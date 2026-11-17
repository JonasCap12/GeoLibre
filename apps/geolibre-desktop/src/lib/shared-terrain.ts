/**
 * A 3D terrain kept in the shared data library, the way a project is.
 *
 * The terrain dialog takes a public HTTP(S) URL or a file opened on this
 * device, and a project saves only the URL. A self-hosted team's DEM (a design
 * surface with the road's cuts and fills built in, say) is neither: it belongs
 * behind the same sign-in as the project it goes with. So the project records
 * which library dataset is its terrain, and every member who opens it, or
 * joins a session on it, downloads that dataset with their own sign-in and
 * hands the bytes to the map as a COG terrain source.
 *
 * The record lives in the project's `metadata`, which saves with the project
 * and travels in collaboration snapshots, so nothing else carries it.
 */
import type { MapEngine } from "@geolibre/map";
import { fetchSharedDatasetBytes } from "./shared-datasets";

/** Key under the project's `metadata`. Renaming it orphans saved projects. */
export const SHARED_TERRAIN_KEY = "sharedTerrain";

/** Which library dataset is the project's terrain. */
export interface SharedTerrainRef {
  datasetId: string;
  /** The dataset's name when it was chosen, for messages. */
  name: string;
}

/**
 * Read a project's shared terrain, or null when it has none or the stored
 * value is not one (a hand-edited file, an older build).
 */
export function readSharedTerrain(
  metadata: Record<string, unknown> | undefined,
): SharedTerrainRef | null {
  const value = metadata?.[SHARED_TERRAIN_KEY];
  if (typeof value !== "object" || value === null) return null;
  const { datasetId, name } = value as Record<string, unknown>;
  if (typeof datasetId !== "string" || datasetId.trim() === "") return null;
  return { datasetId: datasetId.trim(), name: typeof name === "string" ? name : "" };
}

/** The metadata with the shared terrain set (or removed, for null). Never mutates. */
export function withSharedTerrain(
  metadata: Record<string, unknown>,
  ref: SharedTerrainRef | null,
): Record<string, unknown> {
  const { [SHARED_TERRAIN_KEY]: _previous, ...rest } = metadata;
  return ref
    ? { ...rest, [SHARED_TERRAIN_KEY]: { datasetId: ref.datasetId, name: ref.name } }
    : rest;
}

/** A library file that can be a terrain: a GeoTIFF, judged by its name. */
export function isTerrainDatasetFile(filename: string): boolean {
  return /\.tiff?$/i.test(filename.trim());
}

type FetchBytes = typeof fetchSharedDatasetBytes;

// One download per dataset and sign-in for the whole page: reopening the
// project, a renderer switch, or each collaboration snapshot must not pull
// tens of megabytes again.
const blobs = new Map<string, Promise<Blob>>();

/**
 * The dataset's bytes as a Blob, downloaded once with `token`. A failed
 * download is forgotten so the next attempt retries.
 */
export function sharedTerrainBlob(
  datasetId: string,
  token: string,
  fetchBytes: FetchBytes = fetchSharedDatasetBytes,
): Promise<Blob> {
  const key = `${token}\u0000${datasetId}`;
  let pending = blobs.get(key);
  if (!pending) {
    pending = fetchBytes(datasetId, { token })
      .then((bytes) => new Blob([bytes], { type: "image/tiff" }))
      .catch((error: unknown) => {
        blobs.delete(key);
        throw error;
      });
    blobs.set(key, pending);
  }
  return pending;
}

/** Forget every downloaded terrain (tests; signing out). */
export function clearSharedTerrainCache(): void {
  blobs.clear();
}

export type SharedTerrainEngine = Pick<MapEngine, "capabilities" | "setTerrainCogSource">;

/**
 * Download the project's terrain and make it the map's terrain source.
 *
 * @returns "applied"; "superseded" when a later terrain choice landed first
 *   (the engine keeps that one); "unsupported" for a renderer without custom
 *   terrain sources. Throws when the download or the GeoTIFF fails.
 */
export async function applySharedTerrain(
  engine: SharedTerrainEngine,
  ref: SharedTerrainRef,
  token: string,
  fetchBytes: FetchBytes = fetchSharedDatasetBytes,
): Promise<"applied" | "superseded" | "unsupported"> {
  if (!engine.capabilities.terrainSource) return "unsupported";
  const blob = await sharedTerrainBlob(ref.datasetId, token, fetchBytes);
  return (await engine.setTerrainCogSource(blob)) ? "applied" : "superseded";
}
