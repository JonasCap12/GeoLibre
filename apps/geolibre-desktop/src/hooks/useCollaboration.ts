import {
  applyProjectToStore,
  clearHistory,
  redactCredentials,
  serializeProject,
  useAppStore,
  type CollaborationMode,
  type CollaborationParticipant,
  type CollaborationPresence,
  type GeoLibreProject,
  type MapViewState,
} from "@geolibre/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
// `bindFollowGestures` listens on the MapLibre map itself: only it reports the
// drag/zoom/rotate/pitch starts that stop following, which `MapEngine` does not
// surface.
import type { Map as MapLibreMap, MapLibreEvent } from "maplibre-gl";
import i18n from "../i18n";
import {
  buildCollaborationSnapshot,
  buildProjectEgressSnapshot,
  buildProjectSnapshot,
} from "../lib/build-project-snapshot";
import { prepareCollaborationLayers } from "../lib/collaboration-layers";
import {
  applySharedDatasetPromotion,
  COLLABORATION_DATASET_VISIBILITY,
  createPromotionCache,
  shrinkCollaborationLayers,
} from "../lib/collaboration-layer-promotion";
import { uploadSharedDataset } from "../lib/shared-datasets";
import { projectChanged } from "../lib/project-broadcast-changed";
import {
  CollabConnection,
  createSession,
  resolveCollabBaseUrl,
  sessionWsUrl,
} from "../lib/collab-client";
import {
  type CommentMutationAction,
  type ServerMessage,
  participantCanEditLayer,
} from "../lib/collab-protocol";
import {
  followAfterParticipants,
  followOnWelcome,
  followTarget,
  viewToApply,
} from "../lib/collab-follow";
import { recallHostToken, rememberHostToken } from "../lib/collab-host-tokens";
import { fetchCollabIdentity } from "../lib/collab-sessions";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { mergeInboundCollaborationProject } from "../lib/collaboration-project";
import {
  learnedSnapshotLimit,
  localTooLargeMessage,
  snapshotSyncAction,
  snapshotSyncLimit,
} from "../lib/collaboration-sync";
import { rehydrateSharedLayersInStore } from "../lib/collaboration-shared-load";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * The identity token for the signed-in account, or undefined when nobody is
 * signed in here (desktop and ungated builds). A members-only relay then
 * refuses with its own message, which is what the person should see.
 */
async function signedInIdentity(): Promise<string | undefined> {
  const token = useDesktopSettingsStore.getState().desktopSettings.shareToken.trim();
  if (token === "" || resolveShareBaseUrl() === null) return undefined;
  try {
    return await fetchCollabIdentity({ token });
  } catch (error) {
    console.warn("[GeoLibre] Could not get a collaboration identity", error);
    return undefined;
  }
}

const SNAPSHOT_DEBOUNCE_MS = 250;
const CURSOR_THROTTLE_MS = 40;

/** Slide the camera to a followed view. Every engine implements `easeToView`. */
function applyFollowedView(engine: MapEngine | null, view: MapViewState): void {
  if (!engine) return;
  if (typeof engine.easeToView === "function") {
    engine.easeToView(view);
    return;
  }
  engine.applyView(view);
}

export interface CollaborationApi {
  enabled: boolean;
  canEdit: () => boolean;
  canEditLayer: (layerId: string) => boolean;
  start: (
    displayName: string,
    color: string,
    mode: CollaborationMode,
    requireIdentity?: boolean,
    options?: { persistent?: boolean },
  ) => Promise<string>;
  join: (
    sessionId: string,
    displayName: string,
    color: string,
    options?: { inviteToken?: string; identityToken?: string },
  ) => Promise<void>;
  leave: () => void;
  setMode: (mode: CollaborationMode) => void;
  setParticipantMode: (clientId: string, canEdit: boolean) => void;
  mintInvite: (role: CollaborationMode, maxUses?: number) => void;
  revokeInvite: (token: string) => void;
  setSessionConfig: (config: { requireIdentity?: boolean }) => void;
  setLayerLocks: (lockedLayerIds: string[]) => void;
  kickParticipant: (clientId: string, reason?: string) => void;
  blockParticipant: (clientId: string, reason?: string) => void;
  setFollow: (clientId: string | null) => void;
  setPresenting: (active: boolean) => void;
  sendChat: (text: string, coordinate?: { lng: number; lat: number } | null) => boolean;
  sendCommentMutation: (action: CommentMutationAction) => boolean;
}

export function useCollaboration(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReadyGeneration: number,
): CollaborationApi {
  const baseUrl = useMemo(() => resolveCollabBaseUrl(), []);
  const enabled = baseUrl !== null;

  const connRef = useRef<CollabConnection | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const presenceTeardownRef = useRef<(() => void) | null>(null);
  const lastContentRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const selfIdRef = useRef<string | null>(null);
  // Guests follow the host on the first welcome only. Cleared once that choice
  // is applied, or as soon as the person picks someone (including nobody), so a
  // reconnect does not override them.
  const autoFollowHostRef = useRef(false);
  const syncPausedRef = useRef(false);
  // Null until a too-large rejection names the relay's ceiling. The compile-time
  // constant is only the fallback; a deployment may set a lower one.
  const learnedLimitRef = useRef<number | null>(null);
  // Dataset ids already uploaded this session, so a later snapshot of the same
  // drawing does not post the bytes again.
  const promotionCacheRef = useRef(createPromotionCache());
  // Separate from snapshotRequestRef. Sharing that counter would let a library
  // fetch cancel a snapshot that was already the newest one.
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConnectRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const collaborationActive = useAppStore((state) => state.collaboration.isActive);
  const primaryRenderer = useAppStore((state) => state.primaryRenderer);

  useEffect(
    () => () => {
      disconnect();
      useAppStore.getState().resetCollaboration();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // A settled failure (needs-sign-in, missing, failed) stays settled until the
  // share token changes. Signing in is what makes a team dataset readable, so
  // that change is the retry.
  const shareToken = useDesktopSettingsStore((s) => s.desktopSettings.shareToken.trim());
  useEffect(() => {
    void rehydrateSharedLayersInStore(shareToken);
  }, [shareToken]);

  // A welcome snapshot can swap the renderer after the socket connects. Bind
  // presence after that commit, and rebind whenever a live session changes
  // engines, instead of holding listeners on the destroyed initial canvas.
  useEffect(() => {
    if (!collaborationActive) {
      presenceTeardownRef.current?.();
      presenceTeardownRef.current = null;
      return;
    }
    const frame = requestAnimationFrame(() => {
      presenceTeardownRef.current?.();
      const engine = mapControllerRef.current;
      const conn = connRef.current;
      if (!engine || !conn) {
        presenceTeardownRef.current = null;
        return;
      }
      const detachPresence = bindPresence(engine, conn);
      // Cesium and ArcGIS do not expose a MapLibre map, so they cannot emit
      // drag/zoom/rotate/pitch starts. Follow stays on until the person stops
      // it or the target leaves; only MapLibre (and Mapbox) auto-stop on a
      // gesture. Bound here so it rebinds with presence when the engine swaps.
      const map = engine.getMap();
      const detachGestures = map ? bindFollowGestures(map) : null;
      presenceTeardownRef.current = () => {
        detachPresence();
        detachGestures?.();
      };
    });
    return () => {
      cancelAnimationFrame(frame);
      presenceTeardownRef.current?.();
      presenceTeardownRef.current = null;
    };
    // bindPresence is deliberately local to this hook; renderer/session state
    // is the lifecycle boundary for its DOM and camera listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collaborationActive, primaryRenderer, mapReadyGeneration, mapControllerRef]);

  const canEdit = (): boolean => {
    const c = useAppStore.getState().collaboration;
    if (!c.isActive) return false;
    if (c.role === "host") return true;
    const self = c.participants.find((p) => p.clientId === c.clientId);
    return self?.editOverride ?? c.mode === "co-edit";
  };

  const canEditLayer = useCallback((layerId: string): boolean => {
    const c = useAppStore.getState().collaboration;
    if (!c.isActive) return true;
    if (c.role === "host") return true;
    const self = c.participants.find((p) => p.clientId === c.clientId);
    if (!self) {
      return c.mode === "co-edit" && !(c.lockedLayerIds ?? []).includes(layerId);
    }
    return participantCanEditLayer(self, c.mode, layerId, c.lockedLayerIds ?? []);
  }, []);

  const sendSnapshot = async (): Promise<void> => {
    // A pause does not skip the build. The size is measured locally so an
    // oversized project is never put back on the wire just to learn that it
    // still does not fit. The request id still advances first: a slower build
    // must not send after a newer one has already been decided.
    if (!canEdit()) return;
    const request = ++snapshotRequestRef.current;
    let project: GeoLibreProject;
    try {
      project = await buildCollaborationSnapshot(mapControllerRef);
    } catch {
      if (request === snapshotRequestRef.current && canEdit()) {
        useAppStore.getState().setCollaboration({ error: i18n.t("collaborate.shareFailed") });
      }
      return;
    }
    if (request !== snapshotRequestRef.current || !canEdit()) return;
    let content = serializeProject(project);
    let bytes = new TextEncoder().encode(content).length;
    if (snapshotSyncAction(bytes, learnedLimitRef.current) === "hold") {
      const limit = snapshotSyncLimit(learnedLimitRef.current);
      const token = useDesktopSettingsStore.getState().desktopSettings.shareToken.trim();
      // Team, not public: any signed-in account on this deployment can read it,
      // and an anonymous caller cannot. Private would hide it from the session.
      const shrunk = await shrinkCollaborationLayers({
        layers: project.layers,
        limit,
        token,
        cache: promotionCacheRef.current,
        measure: (layers) => {
          const prepared = prepareCollaborationLayers(layers, new Map());
          const next = redactCredentials(
            buildProjectSnapshot(mapControllerRef, { layers: prepared }),
          );
          return new TextEncoder().encode(serializeProject(next)).length;
        },
        upload: async (candidate, shareToken) =>
          uploadSharedDataset({
            token: shareToken,
            data: new TextEncoder().encode(JSON.stringify(candidate.features)),
            filename: candidate.filename,
            name: candidate.name,
            visibility: COLLABORATION_DATASET_VISIBILITY,
            contentType: "application/geojson",
          }),
      });
      if (request !== snapshotRequestRef.current || !canEdit()) return;
      for (const promotion of shrunk.promotions) {
        const current = useAppStore
          .getState()
          .layers.find((layer) => layer.id === promotion.layerId);
        if (!current) continue;
        useAppStore.getState().updateLayer(promotion.layerId, {
          metadata: applySharedDatasetPromotion(current, promotion.datasetId, promotion.filename)
            .metadata,
        });
      }
      if (request !== snapshotRequestRef.current || !canEdit()) return;
      try {
        project = await buildCollaborationSnapshot(mapControllerRef);
      } catch {
        if (request === snapshotRequestRef.current && canEdit()) {
          useAppStore.getState().setCollaboration({ error: i18n.t("collaborate.shareFailed") });
        }
        return;
      }
      if (request !== snapshotRequestRef.current || !canEdit()) return;
      content = serializeProject(project);
      bytes = new TextEncoder().encode(content).length;
      if (snapshotSyncAction(bytes, learnedLimitRef.current) === "hold") {
        syncPausedRef.current = true;
        const held = shrunk.failure;
        useAppStore.getState().setCollaboration({
          error: held
            ? held.reason === "no-token"
              ? i18n.t("collaborate.layerShareNeedsSignIn", { name: held.layerName })
              : i18n.t("collaborate.layerShareFailed", {
                  name: held.layerName,
                  detail: held.detail ?? "",
                })
            : localTooLargeMessage(bytes, limit),
        });
        return;
      }
    }
    if (syncPausedRef.current) syncPausedRef.current = false;
    if (content === lastContentRef.current) {
      useAppStore.getState().setCollaboration({ error: null });
      return;
    }
    lastContentRef.current = content;
    revRef.current += 1;
    useAppStore.getState().setCollaboration({ error: null });
    connRef.current?.send({ type: "snapshot", project, rev: revRef.current });
  };

  const scheduleRestore = (): void => {
    if (restoreTimerRef.current) clearTimeout(restoreTimerRef.current);
    restoreTimerRef.current = setTimeout(() => {
      restoreTimerRef.current = null;
      useAppStore.setState((s) => ({
        projectGeneration: s.projectGeneration + 1,
      }));
    }, 200);
  };

  const applyRemoteSnapshot = (project: GeoLibreProject, initial: boolean): void => {
    const state = useAppStore.getState();
    const localView = mapControllerRef.current?.readView() ?? state.mapView;
    const merged = mergeInboundCollaborationProject(project, localView, state.projectPlugins);
    if (initial) {
      useAppStore.getState().loadProject(merged, null, {
        rememberRecent: false,
        presenting: false,
      });
    } else {
      const applied = applyProjectToStore(merged);
      useAppStore.setState({ ...applied });
      clearHistory();
      scheduleRestore();
    }
    lastContentRef.current = serializeProject(buildProjectEgressSnapshot(mapControllerRef));
    const token = useDesktopSettingsStore.getState().desktopSettings.shareToken.trim();
    void rehydrateSharedLayersInStore(token, merged.layers);
  };

  const handleMessage = (message: ServerMessage): void => {
    const store = useAppStore.getState();
    switch (message.type) {
      case "welcome": {
        selfIdRef.current = message.clientId;
        const decided = followOnWelcome({
          role: message.role,
          selfId: message.clientId,
          participants: message.participants,
          currentFollow: useAppStore.getState().collaboration.followClientId,
          autoFollowHost: autoFollowHostRef.current,
        });
        autoFollowHostRef.current = decided.autoFollowHost;
        store.setCollaboration({
          isActive: true,
          connecting: false,
          clientId: message.clientId,
          role: message.role,
          mode: message.mode,
          participants: message.participants,
          followClientId: decided.followClientId,
          presenterClientId: message.presenter ?? null,
          chat: message.chat ?? [],
          requireIdentity: message.requireIdentity ?? false,
          identitySupported: message.identitySupported ?? false,
          lockedLayerIds: message.lockedLayerIds ?? [],
          invites: message.invites ?? [],
          error: null,
        });
        for (const [clientId, entry] of Object.entries(message.presence)) {
          if (clientId === message.clientId) continue;
          const participant = message.participants.find((p) => p.clientId === clientId);
          store.updateCollaborationPresence(clientId, {
            displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
            color: participant?.color ?? "#888888",
            cursor: entry.cursor,
            view: entry.view,
          });
        }
        if (message.snapshot) {
          applyRemoteSnapshot(message.snapshot, true);
        } else if (message.role === "host") {
          void sendSnapshot();
        }
        const followedView = viewToApply(decided.followClientId, {
          clientId: decided.followClientId ?? "",
          view: decided.followClientId ? message.presence[decided.followClientId]?.view : null,
        });
        if (followedView) applyFollowedView(mapControllerRef.current, followedView);
        const pending = pendingConnectRef.current;
        pendingConnectRef.current = null;
        pending?.resolve();
        break;
      }
      case "snapshot":
        if (message.origin !== selfIdRef.current) {
          applyRemoteSnapshot(message.project, false);
        }
        break;
      case "presence": {
        if (message.clientId === selfIdRef.current) break;
        const collab = useAppStore.getState().collaboration;
        const participant = collab.participants.find((p) => p.clientId === message.clientId);
        const presence: CollaborationPresence = {
          displayName: participant?.displayName ?? i18n.t("collaborate.guest"),
          color: participant?.color ?? "#888888",
          cursor: message.cursor,
          view: message.view,
        };
        store.updateCollaborationPresence(message.clientId, presence);
        const followedView = viewToApply(collab.followClientId, message);
        if (followedView) applyFollowedView(mapControllerRef.current, followedView);
        break;
      }
      case "presenter":
        store.setCollaboration({ presenterClientId: message.clientId });
        break;
      case "participants": {
        const currentFollow = useAppStore.getState().collaboration.followClientId;
        store.setCollaboration({
          participants: message.participants,
          followClientId: followAfterParticipants(currentFollow, message.participants),
        });
        const present = new Set(message.participants.map((p) => p.clientId));
        const presence = useAppStore.getState().collaboration.presence;
        for (const id of Object.keys(presence)) {
          if (!present.has(id)) store.updateCollaborationPresence(id, null);
        }
        break;
      }
      case "mode":
        store.setCollaboration({ mode: message.mode });
        break;
      case "chat":
        store.addCollaborationChat(message.message);
        break;
      case "comment-mutation": {
        const action = message.action;
        if (action.type === "add") {
          store.addComment(action.comment);
        } else if (action.type === "reply") {
          store.replyToComment(action.commentId, action.reply);
        } else if (action.type === "toggle-resolve") {
          store.toggleResolveComment(action.commentId, action.resolved);
        } else if (action.type === "delete") {
          store.deleteComment(action.commentId);
        }
        break;
      }
      case "invite-created": {
        const current = useAppStore.getState().collaboration.invites;
        store.setCollaboration({ invites: [...current, message.invite] });
        break;
      }
      case "invite-revoked": {
        const current = useAppStore.getState().collaboration.invites;
        store.setCollaboration({
          invites: current.filter((i) => i.token !== message.token),
        });
        break;
      }
      case "session-config": {
        if (message.requireIdentity !== undefined) {
          store.setCollaboration({ requireIdentity: message.requireIdentity });
        }
        break;
      }
      case "layer-locks": {
        store.setCollaboration({ lockedLayerIds: message.lockedLayerIds });
        break;
      }
      case "kicked": {
        disconnect();
        useAppStore.getState().resetCollaboration();
        useAppStore.getState().setCollaboration({
          error: message.reason ?? "Removed from session.",
        });
        break;
      }
      case "error": {
        if (pendingConnectRef.current) {
          const pending = pendingConnectRef.current;
          pendingConnectRef.current = null;
          disconnect();
          store.setCollaboration({ connecting: false, error: message.message });
          pending.reject(new Error(message.message));
          return;
        }
        store.setCollaboration({ error: message.message });
        if (message.code === "too-large") {
          syncPausedRef.current = true;
          const learned = learnedSnapshotLimit(message.message);
          if (learned !== null) learnedLimitRef.current = learned;
        }
        break;
      }
    }
  };

  const attach = (
    displayName: string,
    color: string,
    hostToken: string | undefined,
    inviteToken?: string,
    identityToken?: string,
  ): void => {
    const conn = connRef.current;
    if (!conn) return;

    let debounce: ReturnType<typeof setTimeout> | null = null;
    const scheduleSnapshot = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void sendSnapshot();
      }, SNAPSHOT_DEBOUNCE_MS);
    };

    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (projectChanged(state, prev)) scheduleSnapshot();
    });

    conn.send({
      type: "join",
      clientId: selfIdRef.current ?? crypto.randomUUID(),
      displayName,
      color,
      hostToken,
      inviteToken,
      identityToken,
    });

    // Presence and the follow gestures are bound by the renderer-aware effect
    // above, which rebinds them when a live session swaps engines; both are
    // torn down through `presenceTeardownRef`, not from here.
    teardownRef.current = () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
    };
  };

  const bindPresence = (engine: MapEngine, conn: CollabConnection): (() => void) => {
    const surface = engine.getRenderSurface();
    if (!surface) return () => {};
    const container = surface.getContainer();
    let lastCursor = 0;
    const onPointerMove = (event: PointerEvent) => {
      const now = Date.now();
      if (now - lastCursor < CURSOR_THROTTLE_MS) return;
      lastCursor = now;
      const bounds = container.getBoundingClientRect();
      const lngLat = surface.unproject([event.clientX - bounds.left, event.clientY - bounds.top]);
      if (lngLat)
        conn.send({
          type: "presence",
          cursor: lngLat,
          view: engine.readView(),
        });
    };
    const onPointerLeave = () =>
      conn.send({ type: "presence", cursor: null, view: engine.readView() });
    const onCameraIdle = (event?: { storyCamera: boolean }) => {
      if (event?.storyCamera) return;
      conn.send({ type: "presence", view: engine.readView() });
    };
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);
    const detachCameraIdle = engine.onCameraIdle(onCameraIdle);
    onCameraIdle();
    return () => {
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      detachCameraIdle();
    };
  };

  // User camera gestures carry `originalEvent` (mouse, touch, keyboard).
  // `applyView` / `easeToView` do not, so following someone does not unfollow.
  const bindFollowGestures = (map: MapLibreMap): (() => void) => {
    const onGesture = (event: MapLibreEvent) => {
      if (!event.originalEvent) return;
      if (!useAppStore.getState().collaboration.followClientId) return;
      autoFollowHostRef.current = false;
      useAppStore.getState().setCollaboration({ followClientId: null });
    };
    const events = ["dragstart", "zoomstart", "rotatestart", "pitchstart"] as const;
    for (const name of events) map.on(name, onGesture);
    return () => {
      for (const name of events) map.off(name, onGesture);
    };
  };

  const connect = (
    sessionId: string,
    displayName: string,
    color: string,
    hostToken: string | undefined,
    options?: { inviteToken?: string; identityToken?: string },
  ): Promise<void> => {
    disconnect();
    syncPausedRef.current = false;
    learnedLimitRef.current = null;
    selfIdRef.current = crypto.randomUUID();
    autoFollowHostRef.current = !hostToken;
    lastContentRef.current = null;
    revRef.current = 0;

    const normalizedCode = sessionId.trim().toUpperCase();

    const selfParticipant: CollaborationParticipant = {
      clientId: selfIdRef.current,
      displayName,
      color,
      role: hostToken ? "host" : "guest",
      editOverride: null,
    };

    useAppStore.getState().setCollaboration({
      connecting: true,
      isActive: false,
      sessionId: normalizedCode,
      selfName: displayName,
      selfColor: color,
      role: hostToken ? "host" : "guest",
      mode: "co-edit",
      clientId: selfIdRef.current,
      participants: [selfParticipant],
      followClientId: null,
      presenterClientId: null,
      error: null,
    });

    return new Promise<void>((resolve, reject) => {
      pendingConnectRef.current = { resolve, reject };

      const conn = new CollabConnection(sessionWsUrl(baseUrl!, normalizedCode), {
        onOpen: () => {
          if (connRef.current !== conn) return;
          attach(displayName, color, hostToken, options?.inviteToken, options?.identityToken);
        },
        onMessage: (msg) => {
          if (connRef.current !== conn) return;
          handleMessage(msg);
        },
        onClose: (reconnecting) => {
          if (connRef.current && connRef.current !== conn) return;
          teardownRef.current?.();
          teardownRef.current = null;
          if (reconnecting && pendingConnectRef.current) {
            const p = pendingConnectRef.current;
            pendingConnectRef.current = null;
            conn.close();
            useAppStore.getState().setCollaboration({
              connecting: false,
              error: "Could not connect to the session.",
            });
            p.reject(new Error("Could not connect to the session."));
          }
        },
      });
      connRef.current = conn;
      conn.connect();
    });
  };

  const disconnect = (): void => {
    snapshotRequestRef.current += 1;
    presenceTeardownRef.current?.();
    presenceTeardownRef.current = null;
    teardownRef.current?.();
    teardownRef.current = null;
    if (pendingConnectRef.current) {
      const p = pendingConnectRef.current;
      pendingConnectRef.current = null;
      p.reject(new Error(i18n.t("comments.sessionDisconnected")));
    }
    connRef.current?.close();
    connRef.current = null;
    selfIdRef.current = null;
    if (restoreTimerRef.current) {
      clearTimeout(restoreTimerRef.current);
      restoreTimerRef.current = null;
    }
  };

  const start = useCallback(
    async (
      displayName: string,
      color: string,
      mode: CollaborationMode,
      requireIdentity?: boolean,
      options?: { persistent?: boolean },
    ) => {
      const identityToken = await signedInIdentity();
      const session = await createSession(
        { mode, requireIdentity, persistent: options?.persistent, identityToken },
        baseUrl,
      );
      // Stored before connecting, not after: if the socket fails the session
      // still exists on the relay, and this is the only copy of the token that
      // can claim it back.
      rememberHostToken(session.sessionId, session.hostToken);
      await connect(session.sessionId, displayName, color, session.hostToken, {
        identityToken,
      });
      return session.sessionId;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const join = useCallback(
    async (
      sessionId: string,
      displayName: string,
      color: string,
      options?: { inviteToken?: string; identityToken?: string },
    ) => {
      const code = sessionId.trim().toUpperCase();
      // A host who left and came back arrives through this path, typing their
      // own code. Replaying the stored token is what makes the relay hand host
      // back; without it the session's own creator rejoins as a guest.
      const identityToken = options?.identityToken ?? (await signedInIdentity());
      await connect(code, displayName, color, recallHostToken(code), {
        ...options,
        identityToken,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseUrl],
  );

  const leave = useCallback(() => {
    disconnect();
    useAppStore.getState().resetCollaboration();
  }, []);

  const setMode = useCallback((mode: CollaborationMode) => {
    connRef.current?.send({ type: "set-mode", mode });
  }, []);

  const setParticipantMode = useCallback((clientId: string, canEditFlag: boolean) => {
    connRef.current?.send({
      type: "set-participant-mode",
      clientId,
      canEdit: canEditFlag,
    });
  }, []);

  const mintInvite = useCallback((role: CollaborationMode, maxUses?: number) => {
    connRef.current?.send({ type: "mint-invite", role, maxUses });
  }, []);

  const revokeInvite = useCallback((token: string) => {
    connRef.current?.send({ type: "revoke-invite", token });
  }, []);

  const setSessionConfig = useCallback((config: { requireIdentity?: boolean }) => {
    connRef.current?.send({ type: "set-session-config", ...config });
  }, []);

  const setLayerLocks = useCallback((lockedLayerIds: string[]) => {
    connRef.current?.send({ type: "set-layer-locks", lockedLayerIds });
  }, []);

  const kickParticipant = useCallback((clientId: string, reason?: string) => {
    connRef.current?.send({ type: "kick-participant", clientId, reason });
  }, []);

  const blockParticipant = useCallback((clientId: string, reason?: string) => {
    connRef.current?.send({ type: "block-participant", clientId, reason });
  }, []);

  const sendChat = useCallback((text: string, coordinate?: { lng: number; lat: number } | null) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    return connRef.current?.send({ type: "chat", text: trimmed, coordinate }) ?? false;
  }, []);

  const sendCommentMutation = useCallback((action: CommentMutationAction) => {
    return connRef.current?.send({ type: "comment-mutation", action }) ?? false;
  }, []);

  const setPresenting = useCallback((active: boolean) => {
    connRef.current?.send({ type: "present", active });
  }, []);

  const setFollow = useCallback((clientId: string | null) => {
    const store = useAppStore.getState();
    const selfId = store.collaboration.clientId;
    // A request to follow yourself is a no-op, not an unfollow.
    if (clientId !== null && clientId === selfId) return;
    autoFollowHostRef.current = false;
    const followClientId = followTarget(clientId, selfId);
    store.setCollaboration({ followClientId });
    if (!followClientId) return;
    const followedView = viewToApply(followClientId, {
      clientId: followClientId,
      view: store.collaboration.presence[followClientId]?.view,
    });
    if (followedView) applyFollowedView(mapControllerRef.current, followedView);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    enabled,
    canEdit,
    canEditLayer,
    start,
    join,
    leave,
    setMode,
    setParticipantMode,
    mintInvite,
    revokeInvite,
    setSessionConfig,
    setLayerLocks,
    kickParticipant,
    blockParticipant,
    setFollow,
    setPresenting,
    sendChat,
    sendCommentMutation,
  };
}
