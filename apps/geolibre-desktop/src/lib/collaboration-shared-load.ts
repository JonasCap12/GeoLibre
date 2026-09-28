import type { GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import { resolveSharedDatasetFilename } from "./collaboration-shared-layer";
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
 */
export async function loadSharedDatasetFeatures(
  datasetId: string,
  layer: GeoLibreLayer,
  token: string | undefined,
): Promise<FeatureCollection> {
  // A listing failure must not hide the dataset. The content fetch below is
  // the one that decides "missing" versus "failed"; the name is only so the
  // reader can pick a driver.
  let listedFilename: string | undefined;
  try {
    const rows = await listSharedDatasets({ token: token || undefined });
    listedFilename = rows.find((row) => row.id === datasetId)?.filename;
  } catch {
    listedFilename = undefined;
  }
  const filename = resolveSharedDatasetFilename(layer, listedFilename);
  const bytes = await fetchSharedDatasetBytes(datasetId, { token: token || undefined });
  return loadDuckDbVectorFile({
    name: filename,
    extension: extensionOf(filename),
    data: bytes,
  });
}
