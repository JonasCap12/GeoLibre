import {
  applyProjectToStore,
  clearHistory,
  serializeProject,
  useAppStore,
  type CollaborationMode,
  type CollaborationParticipant,
  type CollaborationPresence,
  type GeoLibreProject,
} from "@geolibre/core";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type { MapEngine } from "@geolibre/map";
import type { Map as MapLibreMap, MapLibreEvent } from "maplibre-gl";
import i18n from "../i18n";
import {
  buildCollaborationSnapshot,
  buildProjectEgressSnapshot,
} from "../lib/build-project-snapshot";
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
import { recallHostToken, rememberHostToken } from "../lib/collab-host-tokens";
import { mergeInboundCollaborationProject } from "../lib/collaboration-project";
import {
  learnedSnapshotLimit,
  localTooLargeMessage,
  snapshotSyncAction,
  snapshotSyncLimit,
} from "../lib/collaboration-sync";
import {
  applySharedLayerFeatures,
  classifySharedDatasetError,
  markSharedLayerFailure,
  sharedDatasetIdOf,
} from "../lib/collaboration-shared-layer";
import { loadSharedDatasetFeatures } from "../lib/collaboration-shared-load";
import { useDesktopSettingsStore } from "./useDesktopSettings";

const SNAPSHOT_DEBOUNCE_MS = 250;
const CURSOR_THROTTLE_MS = 40;

export interface CollaborationApi {
  enabled: boolean;
  canEdit: () => boolean;
  canEditLayer: (layerId: string) => boolean;
  start: (
    displayName: string,
    color: string,
    mode: CollaborationMode,
    requireIdentity?: boolean,
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
  setFollowHost: (enabled: boolean) => void;
  sendChat: (text: string, coordinate?: { lng: number; lat: number } | null) => boolean;
  sendCommentMutation: (action: CommentMutationAction) => boolean;
}

export function useCollaboration(mapControllerRef: RefObject<MapEngine | null>): CollaborationApi {
  const baseUrl = useMemo(() => resolveCollabBaseUrl(), []);
  const enabled = baseUrl !== null;

  const connRef = useRef<CollabConnection | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const lastContentRef = useRef<string | null>(null);
  const revRef = useRef(0);
  const snapshotRequestRef = useRef(0);
  const selfIdRef = useRef<string | null>(null);
  const syncPausedRef = useRef(false);
  // Null until a too-large rejection names the relay's ceiling. The compile-time
  // constant is only the fallback; a deployment may set a lower one.
  const learnedLimitRef = useRef<number | null>(null);
  // Separate from snapshotRequestRef. Sharing that counter would let a library
  // fetch cancel a snapshot that was already the newest one.
  const sharedLoadGenRef = useRef(new Map<string, number>());
  const restoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingConnectRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  useEffect(
    () => () => {
      disconnect();
      useAppStore.getState().resetCollaboration();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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
    const content = serializeProject(project);
    const bytes = new TextEncoder().encode(content).length;
    if (snapshotSyncAction(bytes, learnedLimitRef.current) === "hold") {
      syncPausedRef.current = true;
      useAppStore.getState().setCollaboration({
        error: localTooLargeMessage(bytes, snapshotSyncLimit(learnedLimitRef.current)),
      });
      return;
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
      useAppStore.setState((s) => ({ projectGeneration: s.projectGeneration + 1 }));
    }, 200);
  };

  const applyRemoteSnapshot = (project: GeoLibreProject, initial: boolean): void => {
    const state = useAppStore.getState();
    const localView = mapControllerRef.current?.readView() ?? state.mapView;
    const merged = mergeInboundCollaborationProject(project, localView, state.projectPlugins);
    if (initial) {
      useAppStore
        .getState()
        .loadProject(merged, null, { rememberRecent: false, presenting: false });
    } else {
      const applied = applyProjectToStore(merged);
      useAppStore.setState({ ...applied });
      clearHistory();
      scheduleRestore();
    }
    lastContentRef.current = serializeProject(buildProjectEgressSnapshot(mapControllerRef));
    rehydrateSharedLayers(merged.layers);
  };

  const rehydrateSharedLayers = (layers: GeoLibreProject["layers"]): void => {
    const token = useDesktopSettingsStore.getState().desktopSettings.shareToken.trim();
    for (const layer of layers) {
      const datasetId = sharedDatasetIdOf(layer);
      if (!datasetId) continue;
      const features = layer.geojson?.features;
      if (features && features.length > 0) continue;
      const ticket = (sharedLoadGenRef.current.get(layer.id) ?? 0) + 1;
      sharedLoadGenRef.current.set(layer.id, ticket);
      void loadSharedDatasetFeatures(datasetId, layer, token || undefined)
        .then((collection) => {
          if (sharedLoadGenRef.current.get(layer.id) !== ticket) return;
          const current = useAppStore.getState().layers.find((item) => item.id === layer.id);
          if (!current || sharedDatasetIdOf(current) !== datasetId) return;
          const filled = applySharedLayerFeatures(current, collection);
          useAppStore.getState().updateLayer(current.id, {
            geojson: filled.geojson,
            metadata: filled.metadata,
          });
        })
        .catch((error: unknown) => {
          if (sharedLoadGenRef.current.get(layer.id) !== ticket) return;
          const current = useAppStore.getState().layers.find((item) => item.id === layer.id);
          if (!current || sharedDatasetIdOf(current) !== datasetId) return;
          const failure = classifySharedDatasetError(error, token !== "");
          const marked = markSharedLayerFailure(current, failure);
          useAppStore.getState().updateLayer(current.id, { metadata: marked.metadata });
        });
    }
  };

  const handleMessage = (message: ServerMessage): void => {
    const store = useAppStore.getState();
    switch (message.type) {
      case "welcome": {
        selfIdRef.current = message.clientId;
        store.setCollaboration({
          isActive: true,
          connecting: false,
          clientId: message.clientId,
          role: message.role,
          mode: message.mode,
          participants: message.participants,
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
        if (message.role === "guest" && useAppStore.getState().collaboration.followHost) {
          const host = message.participants.find((participant) => participant.role === "host");
          const hostView = host ? message.presence[host.clientId]?.view : null;
          if (hostView) mapControllerRef.current?.applyView(hostView);
        }
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
        if (collab.followHost && participant?.role === "host" && message.view) {
          mapControllerRef.current?.applyView(message.view);
        }
        break;
      }
      case "participants": {
        store.setCollaboration({ participants: message.participants });
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
        store.setCollaboration({ invites: current.filter((i) => i.token !== message.token) });
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
        useAppStore
          .getState()
          .setCollaboration({ error: message.reason ?? "Removed from session." });
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

    const map = mapControllerRef.current?.getMap() ?? null;
    const detachMap = map ? bindPresence(map, conn) : () => {};

    teardownRef.current = () => {
      if (debounce) clearTimeout(debounce);
      unsubscribe();
      detachMap();
    };
  };

  const bindPresence = (map: MapLibreMap, conn: CollabConnection): (() => void) => {
    let lastCursor = 0;
    const onMouseMove = (e: { lngLat: { lng: number; lat: number } }) => {
      const now = Date.now();
      if (now - lastCursor < CURSOR_THROTTLE_MS) return;
      lastCursor = now;
      conn.send({ type: "presence", cursor: { lng: e.lngLat.lng, lat: e.lngLat.lat } });
    };
    const onMouseOut = () => conn.send({ type: "presence", cursor: null });
    // The token rides along as `eventData` on the flight simulator's camera
    // calls, so it is an extra field on a real `moveend` event rather than a
    // standalone shape — v6's listener types reject the latter.
    const onMoveEnd = (event?: MapLibreEvent & { flightCameraToken?: number }) => {
      if (event?.flightCameraToken !== undefined) return;
      conn.send({ type: "presence", view: mapControllerRef.current?.readView() ?? null });
    };
    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    map.on("moveend", onMoveEnd);
    onMoveEnd();
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseOut);
      map.off("moveend", onMoveEnd);
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
      followHost: !hostToken,
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
            useAppStore
              .getState()
              .setCollaboration({ connecting: false, error: "Could not connect to the session." });
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
    ) => {
      const session = await createSession({ mode, requireIdentity }, baseUrl);
      // Stored before connecting, not after: if the socket fails the session
      // still exists on the relay, and this is the only copy of the token that
      // can claim it back.
      rememberHostToken(session.sessionId, session.hostToken);
      await connect(session.sessionId, displayName, color, session.hostToken);
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
      await connect(code, displayName, color, recallHostToken(code), options);
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
    connRef.current?.send({ type: "set-participant-mode", clientId, canEdit: canEditFlag });
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

  const setFollowHost = useCallback((enabled: boolean) => {
    const store = useAppStore.getState();
    store.setCollaboration({ followHost: enabled });
    if (!enabled) return;
    const host = store.collaboration.participants.find((p) => p.role === "host");
    const view = host ? store.collaboration.presence[host.clientId]?.view : null;
    if (view) mapControllerRef.current?.applyView(view);
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
    setFollowHost,
    sendChat,
    sendCommentMutation,
  };
}
