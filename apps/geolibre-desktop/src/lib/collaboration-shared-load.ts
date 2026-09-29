import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { resolveSharedDatasetFilename } from "./collaboration-shared-layer";
import { rehydrateSharedLayers } from "./collaboration-shared-rehydrate";
import { loadDuckDbVectorFile } from "./duckdb-vector-loader";
import { fetchSharedDatasetBytes, listSharedDatasets } from "./shared-datasets";

function extensionOf(filename: string): string {
  const match = /\.([^.\\/]+)$/.exec(filename);
  return match ? match[1].toLowerCase() : "";
}

/**
 * Fetch one shared-library dataset and read it with the same vector path the
 * file picker uses. Kept out of the classification module so tests of the
 * failure rules do not have to load DuckDB.
 *
 * `listed` is set when the caller already listed the library for this pass.
 * Omitting it lists again, which is the right cost for a single layer and
 * the wrong one for a handful of them.
 */
export async function loadSharedDatasetFeatures(
  datasetId: string,
  layer: GeoLibreLayer,
  token: string | undefined,
  listed?: { filename: string | undefined },
): Promise<FeatureCollection> {
  // A listing failure must not hide the dataset. The content fetch below is
  // the one that decides "missing" versus "failed"; the name is only so the
  // reader can pick a driver.
  let listedFilename = listed?.filename;
  if (!listed) {
    try {
      const rows = await listSharedDatasets({ token: token || undefined });
      listedFilename = rows.find((row) => row.id === datasetId)?.filename;
    } catch {
      listedFilename = undefined;
    }
  }
  const filename = resolveSharedDatasetFilename(layer, listedFilename);
  const bytes = await fetchSharedDatasetBytes(datasetId, { token: token || undefined });
  return loadDuckDbVectorFile({
    name: filename,
    extension: extensionOf(filename),
    data: bytes,
  });
}

/**
 * Refill library layers currently in the store. Both the workspace restore
 * and a collaboration snapshot call this, and they share the in-flight book
 * inside {@link rehydrateSharedLayers}.
 */
export function rehydrateSharedLayersInStore(
  token: string,
  layers: GeoLibreLayer[] = useAppStore.getState().layers,
): Promise<void> {
  return rehydrateSharedLayers({
    layers,
    token,
    listDatasets: async (shareToken) => {
      const rows = await listSharedDatasets({ token: shareToken });
      return rows.map((row) => ({ id: row.id, filename: row.filename }));
    },
    loadFeatures: (datasetId, layer, shareToken, filename) =>
      loadSharedDatasetFeatures(datasetId, layer, shareToken, { filename }),
    getLayer: (id) => useAppStore.getState().layers.find((layer) => layer.id === id),
    updateLayer: (id, patch) => useAppStore.getState().updateLayer(id, patch),
  });
}
