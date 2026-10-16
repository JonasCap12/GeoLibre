import type { GeoLibreLayer } from "@geolibre/core";
// The type only. Nothing under `lib/` pulls in the i18n instance; the caller
// hands its `t` over.
import type { TFunction } from "i18next";
import {
  createPromotionCache,
  shrinkCollaborationLayers,
  type CollaborationPromotionCache,
  type CollaborationPromotionCandidate,
  type CollaborationShrinkResult,
} from "./collaboration-layer-promotion";

/**
 * Keep the browser workspace's saved document small.
 *
 * Painting a library drawing marks it edited, so the workspace document
 * embeds the whole drawing: tens of megabytes sent again a few seconds after
 * every stroke, and kept in R2 as one more immutable version each time, since
 * versions are never pruned. On a slow uplink such a save can also take
 * minutes and drop. So before a save the largest embedded layers go to the
 * shared library (R2) the way a held collaboration snapshot already does, and
 * the document carries their dataset ids. Restoring refills them with
 * `rehydrateSharedLayersInStore`, paint included.
 *
 * Each upload of edited features is a new dataset, so painting a drawing would
 * otherwise leave one copy per save. The book remembers which dataset this
 * session uploaded for each layer, and once a newer one has been saved in its
 * place the older copy is returned for deletion. Datasets the user put in the
 * library are never in the book, so they are never deleted.
 */

/**
 * Size above which embedded layers move to the library before a save. Under
 * the 10 MB live-session ceiling, so a shrunk workspace is also small enough
 * to share.
 */
export const CLOUD_WORKSPACE_INLINE_BYTES = 8 * 1024 * 1024;

/**
 * The projects API's default `GEOLIBRE_MAX_PROJECT_BYTES`. A document still
 * larger after shrinking is refused here rather than uploaded only to earn a
 * 413; anything up to it is still sent whole if a layer could not be moved.
 */
export const CLOUD_WORKSPACE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Quiet time before saving a workspace that needed an upload. Painting fires
 * an edit per stroke; at the normal few seconds every pause would upload the
 * whole drawing again.
 */
export const LARGE_WORKSPACE_SAVE_DEBOUNCE_MS = 30_000;

export interface WorkspacePromotionBook {
  cache: CollaborationPromotionCache;
  /** Layer id → the dataset this session last uploaded for it. */
  uploaded: Map<string, string>;
}

export function createWorkspacePromotionBook(): WorkspacePromotionBook {
  return { cache: createPromotionCache(), uploaded: new Map() };
}

export interface WorkspaceShrinkResult extends CollaborationShrinkResult {
  /**
   * Datasets this session uploaded earlier for a layer that now points at a
   * newer one. Delete them only after the save that references the newer one
   * has succeeded; until then the last saved version still needs them.
   */
  superseded: string[];
}

/** UTF-8 size of a serialized document. */
export function documentBytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

/**
 * Upload the largest embedded layers until the document fits.
 *
 * @param options.measure - Prices a layer list as the saved document would.
 * @param options.upload - Puts one candidate in the shared library.
 */
export async function shrinkWorkspaceLayers(options: {
  layers: GeoLibreLayer[];
  token: string;
  book: WorkspacePromotionBook;
  measure: (layers: GeoLibreLayer[]) => number;
  upload: (candidate: CollaborationPromotionCandidate, token: string) => Promise<{ id: string }>;
  limit?: number;
}): Promise<WorkspaceShrinkResult> {
  const result = await shrinkCollaborationLayers({
    layers: options.layers,
    limit: options.limit ?? CLOUD_WORKSPACE_INLINE_BYTES,
    token: options.token,
    cache: options.book.cache,
    measure: options.measure,
    upload: options.upload,
  });
  const superseded: string[] = [];
  for (const promotion of result.promotions) {
    const previous = options.book.uploaded.get(promotion.layerId);
    if (previous && previous !== promotion.datasetId) superseded.push(previous);
    options.book.uploaded.set(promotion.layerId, promotion.datasetId);
  }
  // A superseded copy is about to be deleted. Undoing back to its features must
  // upload them again rather than reuse an id that will answer 404.
  for (const [key, id] of options.book.cache.ids) {
    if (superseded.includes(id)) options.book.cache.ids.delete(key);
  }
  return { ...result, superseded };
}

/**
 * Delete superseded uploads, best effort: a copy left behind costs storage,
 * not correctness, so a failure is logged and the save stays successful.
 */
export async function deleteSupersededUploads(
  ids: readonly string[],
  remove: (id: string) => Promise<void>,
): Promise<void> {
  for (const id of ids) {
    try {
      await remove(id);
    } catch (error) {
      console.warn(`[GeoLibre] Could not delete the superseded workspace copy ${id}`, error);
    }
  }
}

/**
 * Why a workspace is still too large to save after shrinking, for the status
 * tooltip. Naming the layer and the cause beats a bare size: the reader can
 * act on a rejected upload, while "too large" only says something is wrong.
 */
export function workspaceTooLargeMessage(
  result: Pick<CollaborationShrinkResult, "failure" | "bytes">,
  t: TFunction,
  limit = CLOUD_WORKSPACE_MAX_BYTES,
): string {
  if (result.failure?.reason === "upload") {
    return t("cloudWorkspace.layerUploadFailed", {
      name: result.failure.layerName,
      detail: result.failure.detail ?? "",
    });
  }
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  return t("cloudWorkspace.tooLarge", { size: mb(result.bytes), limit: mb(limit) });
}

/**
 * The promotions still true of the store. An upload takes a while, and a
 * stroke painted meanwhile is not in the uploaded copy: pointing that layer at
 * the copy would clear its edit flag and the stroke would not be saved. Such a
 * layer stays edited and the next save uploads it again, which supersedes the
 * copy that was never used.
 *
 * @param before - The layers the uploads were made from.
 * @param now - The store's layers once they finished.
 */
export function currentPromotions<P extends { layerId: string }>(
  promotions: readonly P[],
  before: readonly GeoLibreLayer[],
  now: readonly GeoLibreLayer[],
): P[] {
  return promotions.filter((promotion) => {
    const then = before.find((layer) => layer.id === promotion.layerId);
    const current = now.find((layer) => layer.id === promotion.layerId);
    return then !== undefined && current !== undefined && then.geojson === current.geojson;
  });
}

/**
 * Waits before retrying a failed save, in order. A large upload over a weak
 * connection drops now and then and goes through on a later try, so a save
 * that failed on the network is retried on its own rather than waiting for
 * the next edit. After the last delay it waits for an edit again.
 */
export const CLOUD_SAVE_RETRY_DELAYS_MS = [15_000, 60_000, 180_000, 600_000] as const;

/**
 * How long to wait before retrying a failed save, or null when retrying cannot
 * help: a 4xx the same document would earn again, or a document refused
 * before upload.
 *
 * @param status - The HTTP status of the failure; undefined for a network error.
 * @param attempt - Retries already made since the last successful save.
 */
export function cloudSaveRetryDelay(status: number | undefined, attempt: number): number | null {
  const retryable = status === undefined || status === 429 || status >= 500;
  if (!retryable) return null;
  return CLOUD_SAVE_RETRY_DELAYS_MS[attempt] ?? null;
}
