import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { hasEditedGeometry } from "./edited-geometry-save";

/**
 * Move embedded features off a live snapshot that would otherwise be held.
 *
 * The relay carries the layer id. The features go to the shared library once.
 * Only layers that are actually pushing the snapshot over the ceiling are
 * uploaded, largest first, so a small file stays inline.
 *
 * Who can read the upload: `team`, chosen by the caller. The API has no
 * session-scoped grant. `private` is the owner alone, so the other people in
 * the session would get a 404. `public` is wider than this deployment wants.
 * `team` is the narrowest level a signed-in peer can read, and this deployment
 * requires a signed-in identity to join.
 *
 * An edited layer is uploaded as a new dataset and the edit flag is cleared.
 * Leaving the old id in place would make peers refetch the pristine file.
 * The same feature bytes keep the dataset id for the rest of the session.
 */

export interface CollaborationPromotionCache {
  /** Fingerprint of the uploaded features → dataset id. */
  ids: Map<string, string>;
  /** Uploads still in flight, so a second snapshot waits instead of posting again. */
  inflight: Map<string, Promise<string>>;
}

export function createPromotionCache(): CollaborationPromotionCache {
  return { ids: new Map(), inflight: new Map() };
}

export interface CollaborationPromotionCandidate {
  layerId: string;
  name: string;
  filename: string;
  bytes: number;
  features: FeatureCollection;
}

export interface CollaborationLayerPromotion {
  layerId: string;
  datasetId: string;
  filename: string;
}

export interface CollaborationShrinkFailure {
  layerName: string;
  reason: "no-token" | "upload";
  detail?: string;
}

export interface CollaborationShrinkResult {
  promotions: CollaborationLayerPromotion[];
  /** Set only when the snapshot is still over the ceiling. */
  failure: CollaborationShrinkFailure | null;
  bytes: number;
}

/**
 * Who may read a drawing uploaded for a live session.
 *
 * `private` is the uploader alone, so everyone else in the session would see
 * the layer as missing. `public` is wider than the session. `team` is every
 * signed-in account on this deployment and nobody anonymous — the narrowest
 * level the API offers that the other participants can actually open.
 */
export const COLLABORATION_DATASET_VISIBILITY = "team" as const;

const textEncoder = new TextEncoder();

function asFeatureCollection(value: unknown): FeatureCollection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as FeatureCollection;
  if (record.type !== "FeatureCollection" || !Array.isArray(record.features)) return null;
  if (record.features.length === 0) return null;
  return record;
}

/** Features a snapshot would actually transmit for this layer, if any. */
export function embeddedCollaborationFeatures(layer: GeoLibreLayer): FeatureCollection | null {
  if (hasEditedGeometry(layer)) return asFeatureCollection(layer.geojson);
  const sharedDatasetId = layer.metadata.sharedDatasetId;
  if (typeof sharedDatasetId === "string" && sharedDatasetId.trim() !== "") return null;
  return asFeatureCollection(layer.metadata.embeddedGeoJSON) ?? asFeatureCollection(layer.geojson);
}

export function collaborationDatasetFilename(name: string): string {
  const stem = (name.trim() || "layer").replace(/\.[^.]+$/, "");
  return `${stem || "layer"}.geojson`;
}

function featureFingerprint(layerId: string, features: FeatureCollection): string {
  const json = JSON.stringify(features);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i += 1) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${layerId}:${json.length}:${hash >>> 0}`;
}

function candidateFrom(layer: GeoLibreLayer): CollaborationPromotionCandidate | null {
  const features = embeddedCollaborationFeatures(layer);
  if (!features) return null;
  const filename = collaborationDatasetFilename(layer.name);
  return {
    layerId: layer.id,
    name: layer.name,
    filename,
    bytes: textEncoder.encode(JSON.stringify(features)).length,
    features,
  };
}

/**
 * Point the layer at a library copy of the features it is showing now.
 *
 * The edit flag goes away because the new dataset *is* the edit. Keeping it
 * would make the next snapshot drop the id and embed the bytes again.
 */
export function applySharedDatasetPromotion(
  layer: GeoLibreLayer,
  datasetId: string,
  filename: string,
): GeoLibreLayer {
  const {
    geometryEdited: _edited,
    embeddedGeoJSON: _embedded,
    sharedDatasetLoad: _load,
    ...metadata
  } = layer.metadata;
  return {
    ...layer,
    metadata: {
      ...metadata,
      sharedDatasetId: datasetId,
      sharedDatasetFilename: filename,
    },
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The shared data library rejected the upload.";
}

async function datasetIdFor(
  cache: CollaborationPromotionCache,
  candidate: CollaborationPromotionCandidate,
  token: string,
  upload: (candidate: CollaborationPromotionCandidate, token: string) => Promise<{ id: string }>,
): Promise<string> {
  const key = featureFingerprint(candidate.layerId, candidate.features);
  const cached = cache.ids.get(key);
  if (cached) return cached;
  const pending = cache.inflight.get(key);
  if (pending) return pending;
  const created = Promise.resolve()
    .then(() => upload(candidate, token))
    .then((dataset) => {
      cache.ids.set(key, dataset.id);
      cache.inflight.delete(key);
      return dataset.id;
    })
    .catch((error: unknown) => {
      cache.inflight.delete(key);
      throw error;
    });
  cache.inflight.set(key, created);
  return created;
}

/**
 * Upload the largest embedded layers until `measure` is within `limit`.
 *
 * `measure` must price layers the way the snapshot does: a layer with a
 * dataset id contributes the id, not its features. Successful promotions are
 * returned even when a later upload fails, so those bytes are not posted twice.
 */
export async function shrinkCollaborationLayers(options: {
  layers: GeoLibreLayer[];
  limit: number;
  token: string;
  cache: CollaborationPromotionCache;
  measure: (layers: GeoLibreLayer[]) => number;
  upload: (candidate: CollaborationPromotionCandidate, token: string) => Promise<{ id: string }>;
}): Promise<CollaborationShrinkResult> {
  let layers = options.layers;
  let bytes = options.measure(layers);
  const promotions: CollaborationLayerPromotion[] = [];
  const attempted = new Set<string>();
  let failure: CollaborationShrinkFailure | null = null;

  while (bytes > options.limit) {
    const next = layers
      .map(candidateFrom)
      .filter((candidate): candidate is CollaborationPromotionCandidate => candidate !== null)
      .filter((candidate) => !attempted.has(candidate.layerId))
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (!next) break;

    if (options.token.trim() === "") {
      failure = { layerName: next.name, reason: "no-token" };
      break;
    }

    let datasetId: string;
    try {
      datasetId = await datasetIdFor(options.cache, next, options.token, options.upload);
    } catch (error) {
      attempted.add(next.layerId);
      failure ??= { layerName: next.name, reason: "upload", detail: failureMessage(error) };
      continue;
    }

    const before = bytes;
    layers = layers.map((layer) =>
      layer.id === next.layerId
        ? applySharedDatasetPromotion(layer, datasetId, next.filename)
        : layer,
    );
    promotions.push({ layerId: next.layerId, datasetId, filename: next.filename });
    bytes = options.measure(layers);
    if (bytes >= before) attempted.add(next.layerId);
  }

  return { promotions, failure: bytes > options.limit ? failure : null, bytes };
}
