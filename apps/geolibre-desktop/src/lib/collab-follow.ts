import type { CollaborationParticipant, CollaborationRole, MapViewState } from "@geolibre/core";

/** A presence update that may carry the sender's camera. */
export interface FollowablePresence {
  clientId: string;
  view?: MapViewState | null;
}

/**
 * The camera to apply for an inbound presence update.
 * Only the person currently being followed contributes a view; everyone else's
 * presence (and a follow target who has not sent a camera yet) yields null.
 */
export function viewToApply(
  followClientId: string | null,
  message: FollowablePresence,
): MapViewState | null {
  if (!followClientId || message.clientId !== followClientId) return null;
  return message.view ?? null;
}

/**
 * Drop a follow when that person is no longer in the roster.
 * Returns the same id while they are still present.
 */
export function followAfterParticipants(
  followClientId: string | null,
  participants: readonly { clientId: string }[],
): string | null {
  if (!followClientId) return null;
  return participants.some((participant) => participant.clientId === followClientId)
    ? followClientId
    : null;
}

/**
 * The client id to store for a follow request.
 * Following yourself is ignored (`null`); an explicit stop is also `null`.
 */
export function followTarget(clientId: string | null, selfId: string | null): string | null {
  if (!clientId || clientId === selfId) return null;
  return clientId;
}

/** Guests start on the host's camera. Hosts, and a roster with no host, follow nobody. */
export function initialFollowClientId(
  role: CollaborationRole | null,
  participants: readonly CollaborationParticipant[],
  selfId: string | null,
): string | null {
  if (role !== "guest") return null;
  const host = participants.find(
    (participant) => participant.role === "host" && participant.clientId !== selfId,
  );
  return host?.clientId ?? null;
}

/**
 * Decide who to follow when a `welcome` arrives.
 * The first welcome of a guest session follows the host. Later welcomes (a
 * transparent reconnect) keep the person's current choice, including "nobody",
 * and only clear it when that person has left the roster.
 */
export function followOnWelcome(input: {
  role: CollaborationRole;
  selfId: string;
  participants: readonly CollaborationParticipant[];
  currentFollow: string | null;
  autoFollowHost: boolean;
}): { followClientId: string | null; autoFollowHost: boolean } {
  if (input.autoFollowHost && input.role === "guest") {
    return {
      followClientId: initialFollowClientId("guest", input.participants, input.selfId),
      autoFollowHost: false,
    };
  }
  return {
    followClientId: followAfterParticipants(input.currentFollow, input.participants),
    autoFollowHost: input.autoFollowHost,
  };
}

/** Isolated follow (the first view, or a gap) uses MapLibre's default ease. */
export const FOLLOW_SETTLE_MS = 500;
/** Short eases stay inside this band so the camera lands as the next view arrives. */
export const FOLLOW_STREAM_MIN_MS = 60;
export const FOLLOW_STREAM_MAX_MS = 150;
/** Longer than a camera-stream interval: treat the update as isolated. */
export const FOLLOW_STREAM_GAP_MS = 200;
/** An ease across more levels than this loads tiles at every step. Jump instead. */
export const FOLLOW_JUMP_ZOOM = 4;

/** How to move the local camera for an inbound followed view. */
export function followMotion(input: {
  current: MapViewState;
  target: MapViewState;
  /** Null for the first view after starting to follow this person. */
  msSinceLastFollowedView: number | null;
}): { kind: "skip" } | { kind: "jump" } | { kind: "ease"; durationMs: number } {
  if (farFollow(input.current, input.target)) return { kind: "jump" };
  if (negligibleFollow(input.current, input.target)) return { kind: "skip" };
  const elapsed = input.msSinceLastFollowedView;
  if (elapsed === null || elapsed > FOLLOW_STREAM_GAP_MS) {
    return { kind: "ease", durationMs: FOLLOW_SETTLE_MS };
  }
  const durationMs = Math.min(FOLLOW_STREAM_MAX_MS, Math.max(FOLLOW_STREAM_MIN_MS, elapsed));
  return { kind: "ease", durationMs };
}

/**
 * Move the local camera the way {@link followMotion} decided.
 * `jump` uses `applyView`. A short ease asks for linear interpolation; a
 * 500 ms ease leaves the engine's own curve. Engines without `easeToView`
 * jump.
 */
export function applyFollowedCamera(
  engine: {
    readView: () => MapViewState;
    applyView: (view: MapViewState) => void;
    easeToView?: (view: MapViewState, options?: { durationMs?: number; linear?: boolean }) => void;
  } | null,
  view: MapViewState,
  msSinceLastFollowedView: number | null,
): void {
  if (!engine) return;
  const motion = followMotion({
    current: engine.readView(),
    target: view,
    msSinceLastFollowedView,
  });
  if (motion.kind === "skip") return;
  if (motion.kind === "jump" || typeof engine.easeToView !== "function") {
    engine.applyView(view);
    return;
  }
  engine.easeToView(view, {
    durationMs: motion.durationMs,
    linear: motion.durationMs < FOLLOW_SETTLE_MS,
  });
}

/**
 * Remembers which person is being followed and when their last view arrived.
 * Changing person (including stopping) makes the next view the first one.
 */
export function createFollowClock(now: () => number = () => Date.now()): {
  note: (followClientId: string | null) => void;
  mark: () => number | null;
} {
  let target: string | null = null;
  let lastAt: number | null = null;
  return {
    note(followClientId) {
      if (followClientId === target) return;
      target = followClientId;
      lastAt = null;
    },
    mark() {
      const time = now();
      const elapsed = lastAt === null ? null : time - lastAt;
      lastAt = time;
      return elapsed;
    },
  };
}

/**
 * Leading send plus one trailing send of the last view in the window.
 * `flush` is the authoritative settle (`moveend`) and cancels the trailer.
 * `dispose` drops the trailer without sending.
 */
export function createThrottledViewSend(input: {
  throttleMs: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  clear?: (id: unknown) => void;
  send: (view: MapViewState) => void;
}): {
  push: (view: MapViewState) => void;
  flush: (view: MapViewState) => void;
  dispose: () => void;
} {
  const now = input.now ?? (() => Date.now());
  const schedule = input.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = input.clear ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let pending: MapViewState | null = null;
  let trailing: unknown = null;
  let lastSentAt = Number.NEGATIVE_INFINITY;

  const sendPending = () => {
    if (!pending) return;
    const view = pending;
    pending = null;
    lastSentAt = now();
    input.send(view);
  };

  return {
    push(view) {
      pending = view;
      if (trailing !== null) return;
      const wait = input.throttleMs - (now() - lastSentAt);
      if (wait <= 0) {
        sendPending();
        return;
      }
      trailing = schedule(() => {
        trailing = null;
        sendPending();
      }, wait);
    },
    flush(view) {
      if (trailing !== null) {
        clear(trailing);
        trailing = null;
      }
      pending = null;
      lastSentAt = now();
      input.send(view);
    },
    dispose() {
      if (trailing !== null) {
        clear(trailing);
        trailing = null;
      }
      pending = null;
    },
  };
}

/**
 * Publish this client's camera on a steady interval, plus once when it settles.
 * While following, the camera is someone else's: publishing it would echo their
 * view back as ours. `storyCamera` settles are scripted story moves, same skip.
 */
export function bindCameraPresence(input: {
  throttleMs: number;
  isFollowing: () => boolean;
  readView: () => MapViewState;
  sendView: (view: MapViewState) => void;
  onCameraMove: (listener: () => void) => () => void;
  onCameraIdle: (listener: (event?: { storyCamera?: boolean }) => void) => () => void;
}): () => void {
  const publisher = createThrottledViewSend({
    throttleMs: input.throttleMs,
    send: input.sendView,
  });
  const blocked = () => input.isFollowing();
  const detachMove = input.onCameraMove(() => {
    if (blocked()) return;
    publisher.push(input.readView());
  });
  const detachIdle = input.onCameraIdle((event) => {
    if (event?.storyCamera || blocked()) return;
    publisher.flush(input.readView());
  });
  if (!blocked()) publisher.flush(input.readView());
  return () => {
    detachMove();
    detachIdle();
    publisher.dispose();
  };
}

const BEARING_EPS_DEG = 3;
const PITCH_EPS_DEG = 1;
const ZOOM_EPS = 0.02;

function angleDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** Half a pixel, in degrees, at `zoom`. Longitude uses the equator; latitude shrinks with cos. */
function negligibleCenter(current: MapViewState, target: MapViewState): boolean {
  const zoom = Number.isFinite(current.zoom) ? current.zoom : 0;
  const halfPxDeg = 360 / (256 * 2 ** zoom) / 2;
  const latScale = Math.max(Math.cos((current.center[1] * Math.PI) / 180), 0.2);
  return (
    Math.abs(target.center[0] - current.center[0]) <= halfPxDeg &&
    Math.abs(target.center[1] - current.center[1]) <= halfPxDeg * latScale
  );
}

function negligibleFollow(current: MapViewState, target: MapViewState): boolean {
  return (
    negligibleCenter(current, target) &&
    Math.abs(current.zoom - target.zoom) < ZOOM_EPS &&
    angleDelta(current.bearing, target.bearing) <= BEARING_EPS_DEG &&
    Math.abs(current.pitch - target.pitch) <= PITCH_EPS_DEG
  );
}

function centerOutside(current: MapViewState, target: MapViewState): boolean {
  const bbox = current.bbox;
  if (!bbox) return false;
  const [west, south, east, north] = bbox;
  const [lng, lat] = target.center;
  if (lat < south || lat > north) return true;
  if (west <= east) return lng < west || lng > east;
  return lng < west && lng > east;
}

function farFollow(current: MapViewState, target: MapViewState): boolean {
  return Math.abs(current.zoom - target.zoom) > FOLLOW_JUMP_ZOOM || centerOutside(current, target);
}
