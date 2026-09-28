import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { SharedDatasetError } from "./shared-datasets";

/** Why a library-backed layer has no features yet. Empty and failed must not look the same. */
export type SharedLayerFailure = "needs-sign-in" | "missing" | "failed";

const FAILURES = new Set<SharedLayerFailure>(["needs-sign-in", "missing", "failed"]);

/** The shared-library id on a layer, when this snapshot entry is a reference rather than bytes. */
export function sharedDatasetIdOf(layer: GeoLibreLayer): string | null {
  const id = layer.metadata.sharedDatasetId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

export function sharedLayerFailureOf(layer: GeoLibreLayer): SharedLayerFailure | null {
  const value = layer.metadata.sharedDatasetLoad;
  return typeof value === "string" && FAILURES.has(value as SharedLayerFailure)
    ? (value as SharedLayerFailure)
    : null;
}

/**
 * Map a download or conversion error onto a reason the layer can show.
 *
 * A `team` dataset answers 404 when the caller has no account, on purpose, so
 * the status cannot reveal that the file exists. Without a token that 404
 * means "sign in", not "deleted". A 404 from a signed-in caller means the
 * dataset is gone. Anything else — network, conversion — is a failed load.
 */
export function classifySharedDatasetError(error: unknown, hadToken: boolean): SharedLayerFailure {
  if (error instanceof SharedDatasetError) {
    if (!hadToken || error.status === 401) return "needs-sign-in";
    if (error.status === 404) return "missing";
  }
  return "failed";
}

/** Stamp a failure onto a layer without pretending it has zero features. */
export function markSharedLayerFailure(
  layer: GeoLibreLayer,
  failure: SharedLayerFailure,
): GeoLibreLayer {
  return {
    ...layer,
    metadata: { ...layer.metadata, sharedDatasetLoad: failure },
  };
}

/** Replace the reference with the features the peer just fetched. */
export function applySharedLayerFeatures(
  layer: GeoLibreLayer,
  features: FeatureCollection,
): GeoLibreLayer {
  const { sharedDatasetLoad: _drop, ...metadata } = layer.metadata;
  return { ...layer, geojson: features, metadata };
}

/**
 * Filename the vector reader should open.
 *
 * The library listing is the source that cannot drift: `sharedDatasetFilename`
 * is missing on layers added before that field existed, and `layer.name` is a
 * title the user can rename to something with no extension. The listing's
 * `filename` is what was uploaded. The stored field, then the layer name, are
 * only what is left when the listing has no row.
 */
export function resolveSharedDatasetFilename(
  layer: GeoLibreLayer,
  listedFilename: string | null | undefined,
): string {
  const listed = typeof listedFilename === "string" ? listedFilename.trim() : "";
  if (listed) return listed;
  const stored = layer.metadata.sharedDatasetFilename;
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  return layer.name;
}
