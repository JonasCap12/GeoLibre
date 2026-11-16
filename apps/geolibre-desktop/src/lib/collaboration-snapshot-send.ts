/**
 * Deciding what one collaboration snapshot send does, apart from the hook.
 *
 * `useCollaboration` builds a snapshot, and when it is over the relay's size
 * limit tries to shrink it (by promoting big layers to shared datasets),
 * rebuilds, and either sends the result or holds the session. This module runs
 * that sequence against injected dependencies and returns the outcome; the hook
 * keeps the side effects that depend on its refs (the pause flag, the error in
 * the store, the WebSocket send). The order of the checks and every point where
 * a newer request supersedes this one are the hook's, unchanged.
 */
import type { GeoLibreLayer, GeoLibreProject } from "@geolibre/core";
import { serializeProject } from "@geolibre/core";
import type { TFunction } from "i18next";
import type {
  CollaborationLayerPromotion,
  CollaborationShrinkResult,
} from "./collaboration-layer-promotion";
import { snapshotSyncAction, snapshotSyncLimit } from "./collaboration-sync";
import { heldSnapshotMessage } from "./collaboration-snapshot-shrink";

/** What one snapshot send should do. */
export type CollaborationSnapshotOutcome =
  /** A newer request, or a lost edit right, superseded this one: do nothing. */
  | { kind: "superseded" }
  /** Building the snapshot threw. Report it only if the request is still current. */
  | { kind: "build-failed" }
  /** Still over the limit after shrinking: pause syncing and show `message`. */
  | { kind: "held"; message: string }
  /** Fits: send `project`, whose serialized form is `content`. */
  | { kind: "ready"; project: GeoLibreProject; content: string };

export interface CollaborationSnapshotDeps {
  /** Builds the snapshot as it goes out (the hook applies its basemap egress here). */
  build: () => Promise<GeoLibreProject>;
  /** Whether this request is still the newest one and this client may still edit. */
  isCurrent: () => boolean;
  /** The relay's learned size limit, read each time it is needed. */
  learnedLimit: () => number | null;
  /** Promotes layers until the snapshot fits `limit` or nothing more can move. */
  shrink: (layers: GeoLibreLayer[], limit: number) => Promise<CollaborationShrinkResult>;
  /** Writes the promotions into the store, so the rebuild picks them up. */
  applyPromotions: (promotions: CollaborationLayerPromotion[]) => void;
  t: TFunction;
}

const byteLength = (content: string): number => new TextEncoder().encode(content).length;

/**
 * Runs build → (shrink → rebuild) for one send and says what the send should do.
 *
 * A paused session does not skip the build. The size is measured locally, so
 * an oversized project is never put back on the wire just to learn that it
 * still does not fit.
 */
export async function prepareCollaborationSnapshot(
  deps: CollaborationSnapshotDeps,
): Promise<CollaborationSnapshotOutcome> {
  let project: GeoLibreProject;
  try {
    project = await deps.build();
  } catch {
    return { kind: "build-failed" };
  }
  if (!deps.isCurrent()) return { kind: "superseded" };
  let content = serializeProject(project);
  if (snapshotSyncAction(byteLength(content), deps.learnedLimit()) !== "hold") {
    return { kind: "ready", project, content };
  }

  const limit = snapshotSyncLimit(deps.learnedLimit());
  const shrunk = await deps.shrink(project.layers, limit);
  if (!deps.isCurrent()) return { kind: "superseded" };
  deps.applyPromotions(shrunk.promotions);
  if (!deps.isCurrent()) return { kind: "superseded" };
  try {
    project = await deps.build();
  } catch {
    return { kind: "build-failed" };
  }
  if (!deps.isCurrent()) return { kind: "superseded" };
  content = serializeProject(project);
  const bytes = byteLength(content);
  if (snapshotSyncAction(bytes, deps.learnedLimit()) === "hold") {
    return { kind: "held", message: heldSnapshotMessage(shrunk.failure, bytes, limit, deps.t) };
  }
  return { kind: "ready", project, content };
}
