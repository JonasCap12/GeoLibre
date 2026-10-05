import { useAppStore } from "@geolibre/core";
// The type only. Nothing under `lib/` pulls in the i18n instance; the caller
// hands its `t` over, which also makes the chosen key assertable in a test.
import type { TFunction } from "i18next";
import {
  applySharedDatasetPromotion,
  COLLABORATION_DATASET_VISIBILITY,
  type CollaborationLayerPromotion,
  type CollaborationPromotionCandidate,
  type CollaborationShrinkFailure,
} from "./collaboration-layer-promotion";
import { localTooLargeMessage } from "./collaboration-sync";
import { uploadSharedDataset } from "./shared-datasets";

/**
 * The impure half of shrinking a live snapshot: the store write, the upload and
 * the message. `collaboration-layer-promotion.ts` holds the decision — which
 * layers to move and in what order — and stays free of all three so it can be
 * tested on plain objects. These adapters live here, rather than inside
 * `useCollaboration`, because nothing loads that hook in a test: it reaches the
 * plugin manager and its Vite `virtual:` modules. The one adapter that needs
 * that chain is in `collaboration-snapshot-measure.ts`.
 */

/**
 * Put one drawing in the shared library for the rest of the session.
 *
 * `team`, not `public`: every signed-in account on this deployment can read it
 * and an anonymous caller cannot, which is the narrowest level the API offers
 * that the other people in the session can actually open.
 */
export async function uploadCollaborationCandidate(
  candidate: CollaborationPromotionCandidate,
  token: string,
): Promise<{ id: string }> {
  return uploadSharedDataset({
    token,
    data: new TextEncoder().encode(JSON.stringify(candidate.features)),
    filename: candidate.filename,
    name: candidate.name,
    visibility: COLLABORATION_DATASET_VISIBILITY,
    contentType: "application/geojson",
  });
}

/**
 * Point the store's copy of each promoted layer at its library dataset.
 *
 * Read back per promotion rather than once: `updateLayer` has already replaced
 * the array by the time the next one is applied.
 */
export function applyCollaborationPromotions(promotions: CollaborationLayerPromotion[]): void {
  for (const promotion of promotions) {
    const store = useAppStore.getState();
    const current = store.layers.find((layer) => layer.id === promotion.layerId);
    if (!current) continue;
    store.updateLayer(promotion.layerId, {
      metadata: applySharedDatasetPromotion(current, promotion.datasetId, promotion.filename)
        .metadata,
    });
  }
}

/**
 * What to tell the session when the snapshot is still too large to send.
 *
 * A named layer and a cause beat the generic ceiling message: the reader can act
 * on "sign in" or on a rejected upload, while "the project is too big" only says
 * that something is wrong. The ceiling wording is the fallback for when nothing
 * was promotable, so that path keeps the message the relay also sends — which
 * `learnedSnapshotLimit` parses the limit back out of.
 */
export function heldSnapshotMessage(
  failure: CollaborationShrinkFailure | null,
  bytes: number,
  limit: number,
  t: TFunction,
): string {
  if (!failure) return localTooLargeMessage(bytes, limit);
  if (failure.reason === "no-token") {
    return t("collaborate.layerShareNeedsSignIn", { name: failure.layerName });
  }
  return t("collaborate.layerShareFailed", {
    name: failure.layerName,
    detail: failure.detail ?? "",
  });
}
