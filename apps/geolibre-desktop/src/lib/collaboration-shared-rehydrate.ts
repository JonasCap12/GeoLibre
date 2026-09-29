import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  applySharedLayerFeatures,
  classifySharedDatasetError,
  markSharedLayerFailure,
  sharedDatasetIdOf,
  sharedLayerFailureOf,
} from "./collaboration-shared-layer";

/**
 * One book of in-flight fetches, shared by the cloud workspace and by
 * collaboration. A layer can be in both at once; two callers must not each
 * start a download and race the replies.
 */
export interface SharedRehydrateSession {
  inFlight: Set<string>;
  /**
   * Token the settled failures belong to. Null until the first pass, so a
   * marker restored from disk is tried once against the token we have now.
   */
  token: string | null;
  generation: Map<string, number>;
}

const sharedSession: SharedRehydrateSession = {
  inFlight: new Set(),
  token: null,
  generation: new Map(),
};

export function createSharedRehydrateSession(): SharedRehydrateSession {
  return { inFlight: new Set(), token: null, generation: new Map() };
}

export interface SharedRehydrateArgs {
  layers: GeoLibreLayer[];
  token: string;
  listDatasets: (token: string | undefined) => Promise<{ id: string; filename: string }[]>;
  loadFeatures: (
    datasetId: string,
    layer: GeoLibreLayer,
    token: string | undefined,
    listedFilename: string | undefined,
  ) => Promise<FeatureCollection>;
  getLayer: (id: string) => GeoLibreLayer | undefined;
  updateLayer: (id: string, patch: Partial<GeoLibreLayer>) => void;
  /** Tests pass their own. Callers in the app share {@link sharedSession}. */
  session?: SharedRehydrateSession;
}

/**
 * Fetch features for library layers that were stored by id.
 *
 * A layer that already has features is left alone. A layer already marked
 * `needs-sign-in`, `missing` or `failed` is left alone too, until the share
 * token changes — signing in is what makes a team dataset readable. A fetch
 * already running for that layer is not started again.
 *
 * The library is listed once for the whole pass. Listing it once per layer
 * is what exhausts the download limiter when several layers fail together.
 */
export async function rehydrateSharedLayers(args: SharedRehydrateArgs): Promise<void> {
  const session = args.session ?? sharedSession;
  const tokenChanged = session.token !== args.token;
  const starting: GeoLibreLayer[] = [];
  for (const layer of args.layers) {
    if (!sharedDatasetIdOf(layer)) continue;
    const features = layer.geojson?.features;
    if (features && features.length > 0) continue;
    if (session.inFlight.has(layer.id) && !tokenChanged) continue;
    if (sharedLayerFailureOf(layer) && !tokenChanged) continue;
    // The marker is what a later snapshot treats as settled. Drop it as soon
    // as the token changes, so this pass is a real retry and the panel does
    // not keep showing the old failure while the new request runs.
    if (tokenChanged && sharedLayerFailureOf(layer)) {
      const { sharedDatasetLoad: _settled, ...metadata } = layer.metadata;
      args.updateLayer(layer.id, { metadata });
    }
    starting.push(layer);
    session.inFlight.add(layer.id);
    session.generation.set(layer.id, (session.generation.get(layer.id) ?? 0) + 1);
  }
  // An empty pass must not record the token. The cloud workspace restores
  // after the first effect, and that effect often sees no layers yet. Recording
  // the token then would make a failure saved in the workspace look already
  // settled for this sign-in, so the reload would never fetch it.
  if (args.layers.length > 0) session.token = args.token;
  if (starting.length === 0) return;

  let filenames = new Map<string, string>();
  try {
    const rows = await args.listDatasets(args.token || undefined);
    filenames = new Map(rows.map((row) => [row.id, row.filename]));
  } catch {
    // The per-layer fetch reports the real failure. An empty map just means
    // each one falls back to the layer name.
    filenames = new Map();
  }

  await Promise.all(
    starting.map(async (layer) => {
      const datasetId = sharedDatasetIdOf(layer);
      const ticket = session.generation.get(layer.id);
      if (!datasetId) return;
      try {
        const collection = await args.loadFeatures(
          datasetId,
          layer,
          args.token || undefined,
          filenames.get(datasetId),
        );
        if (session.generation.get(layer.id) !== ticket) return;
        const current = args.getLayer(layer.id);
        if (!current || sharedDatasetIdOf(current) !== datasetId) return;
        const filled = applySharedLayerFeatures(current, collection);
        args.updateLayer(current.id, { geojson: filled.geojson, metadata: filled.metadata });
      } catch (error) {
        if (session.generation.get(layer.id) !== ticket) return;
        const current = args.getLayer(layer.id);
        if (!current || sharedDatasetIdOf(current) !== datasetId) return;
        const marked = markSharedLayerFailure(
          current,
          classifySharedDatasetError(error, args.token !== ""),
        );
        args.updateLayer(current.id, { metadata: marked.metadata });
      } finally {
        if (session.generation.get(layer.id) === ticket) session.inFlight.delete(layer.id);
      }
    }),
  );
}
