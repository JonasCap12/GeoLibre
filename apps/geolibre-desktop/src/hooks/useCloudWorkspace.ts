import { parseProject, serializeProject, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import i18next from "i18next";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { buildCollaborationSnapshot } from "../lib/build-project-snapshot";
import { rehydrateSharedLayersInStore } from "../lib/collaboration-shared-load";
import { collaborationSnapshotMeasure } from "../lib/collaboration-snapshot-measure";
import {
  applyCollaborationPromotions,
  uploadCollaborationCandidate,
} from "../lib/collaboration-snapshot-shrink";
import {
  CloudWorkspaceError,
  createCloudWorkspace,
  downloadCloudWorkspace,
  findCloudWorkspace,
  updateCloudWorkspace,
  type CloudWorkspaceProject,
} from "../lib/cloud-workspace";
import {
  CLOUD_WORKSPACE_INLINE_BYTES,
  CLOUD_WORKSPACE_MAX_BYTES,
  cloudSaveRetryDelay,
  LARGE_WORKSPACE_SAVE_DEBOUNCE_MS,
  createWorkspacePromotionBook,
  currentPromotions,
  deleteSupersededUploads,
  documentBytes,
  shrinkWorkspaceLayers,
  workspaceTooLargeMessage,
} from "../lib/cloud-workspace-shrink";
import { dataUrlParameters, serviceUrlParameter } from "../lib/data-url";
import { isTauri } from "../lib/is-tauri";
import { projectChanged } from "../lib/project-broadcast-changed";
import { projectUrlFromLocation } from "../lib/project-url";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { deleteSharedDataset } from "../lib/shared-datasets";
import { isEmbedded } from "./embedHost";
import { useDesktopSettingsStore } from "./useDesktopSettings";

const CLOUD_SAVE_DEBOUNCE_MS = 3_000;
const SAVED_NOTICE_MS = 2_500;

export type CloudWorkspaceStatus = "disabled" | "loading" | "ready" | "saving" | "saved" | "error";

export interface CloudWorkspaceState {
  status: CloudWorkspaceStatus;
  error: string | null;
}

/** A deep link owns startup state and must never be overwritten by account restore. */
export function hasCloudWorkspaceBlockingPayload(search = window.location.search): boolean {
  const params = new URLSearchParams(search);
  return (
    projectUrlFromLocation() !== null ||
    dataUrlParameters(search) !== null ||
    serviceUrlParameter(search) !== null ||
    params.has("collab")
  );
}

/**
 * Persist the ordinary browser workspace as a private account project.
 *
 * Live collaboration and durable persistence are separate transports: the
 * collaboration relay fans edits out to connected peers, while this hook makes
 * the resulting project survive a normal reload. It is deliberately inactive
 * for desktop, embeds, and explicit project/data/collaboration links.
 */
export function useCloudWorkspace(
  mapControllerRef: RefObject<MapEngine | null>,
  mapReady: boolean,
): CloudWorkspaceState {
  const token = useDesktopSettingsStore((state) => state.desktopSettings.shareToken.trim());
  const baseUrl = useMemo(() => resolveShareBaseUrl(), []);
  const [syncState, setSyncState] = useState<CloudWorkspaceState>({
    status: "disabled",
    error: null,
  });

  useEffect(() => {
    if (
      !mapReady ||
      !token ||
      !baseUrl ||
      isTauri() ||
      isEmbedded() ||
      hasCloudWorkspaceBlockingPayload()
    ) {
      setSyncState({ status: "disabled", error: null });
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    let saveTimer: number | null = null;
    let savedNoticeTimer: number | null = null;
    let saving = false;
    let pendingSave = false;
    let changeRevision = 0;
    let workspace: CloudWorkspaceProject | null = null;
    let lastContent: string | null = null;
    // Layers moved to the shared library to keep the saved document small,
    // and this session's older copies waiting for a save that no longer
    // needs them.
    const promotionBook = createWorkspacePromotionBook();
    let pendingDeletes: string[] = [];
    // Retries made since the last successful save.
    let retryAttempt = 0;
    const abortController = new AbortController();
    const initialGeneration = useAppStore.getState().projectGeneration;
    const options = {
      token,
      baseUrl,
      signal: abortController.signal,
    };

    const showSaved = () => {
      setSyncState({ status: "saved", error: null });
      if (savedNoticeTimer !== null) window.clearTimeout(savedNoticeTimer);
      savedNoticeTimer = window.setTimeout(() => {
        savedNoticeTimer = null;
        if (!cancelled) setSyncState({ status: "ready", error: null });
      }, SAVED_NOTICE_MS);
    };

    const save = async (): Promise<void> => {
      if (cancelled) return;
      if (saving) {
        pendingSave = true;
        return;
      }
      saving = true;
      pendingSave = false;
      const savingRevision = changeRevision;
      const savingGeneration = useAppStore.getState().projectGeneration;
      setSyncState({ status: "saving", error: null });
      try {
        // This is the same portable, credential-redacted snapshot sent to a
        // collaborator. Local vector uploads are embedded before serialization,
        // so restoring the cloud copy does not depend on a vanished File object.
        let content = serializeProject(await buildCollaborationSnapshot(mapControllerRef));
        if (documentBytes(content) > CLOUD_WORKSPACE_INLINE_BYTES) {
          // Move the largest embedded layers to the shared library and save
          // their ids, so each version stays small.
          const before = useAppStore.getState().layers;
          const shrunk = await shrinkWorkspaceLayers({
            layers: before,
            token,
            book: promotionBook,
            measure: collaborationSnapshotMeasure(mapControllerRef),
            upload: uploadCollaborationCandidate,
          });
          const applied = currentPromotions(
            shrunk.promotions,
            before,
            useAppStore.getState().layers,
          );
          applyCollaborationPromotions(applied);
          pendingDeletes.push(...shrunk.superseded);
          if (applied.length > 0) {
            content = serializeProject(await buildCollaborationSnapshot(mapControllerRef));
          }
          const bytes = documentBytes(content);
          // A layer that could not move still saves whole, as before. Only a
          // document the API would refuse is stopped here.
          if (bytes > CLOUD_WORKSPACE_MAX_BYTES) {
            throw new CloudWorkspaceError(
              workspaceTooLargeMessage({ failure: shrunk.failure, bytes }, i18next.t),
              413,
            );
          }
        }
        if (content !== lastContent) {
          workspace = workspace
            ? await updateCloudWorkspace(workspace.id, content, options)
            : await createCloudWorkspace(content, options);
          lastContent = content;
        }
        // The saved version points at the newer copies now.
        const deletes = pendingDeletes;
        pendingDeletes = [];
        void deleteSupersededUploads(deletes, (id) => deleteSharedDataset(id, { token }));
        retryAttempt = 0;
        showSaved();

        // A later edit may have landed while the snapshot/upload was in flight.
        // Only mark the workspace clean when this save still represents the
        // current generation and latest observed revision.
        const current = useAppStore.getState();
        if (
          current.projectGeneration === savingGeneration &&
          changeRevision === savingRevision &&
          current.isDirty
        ) {
          useAppStore.setState({ isDirty: false });
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        console.error("[GeoLibre] Could not save the cloud workspace", error);
        setSyncState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        // A dropped upload often goes through on a later try. Retry on our own
        // unless an edit has already queued the next save.
        const delay = cloudSaveRetryDelay(
          error instanceof CloudWorkspaceError ? error.status : 400,
          retryAttempt,
        );
        if (delay !== null && saveTimer === null && !pendingSave) {
          retryAttempt += 1;
          saveTimer = window.setTimeout(() => {
            saveTimer = null;
            void save();
          }, delay);
        }
      } finally {
        saving = false;
        if (!cancelled && pendingSave) {
          pendingSave = false;
          saveTimer = window.setTimeout(() => {
            saveTimer = null;
            void save();
          }, 0);
        }
      }
    };

    const scheduleSave = () => {
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      // Once a drawing had to go to the library, every pause in painting it
      // would upload it again; wait for a longer quiet spell instead.
      saveTimer = window.setTimeout(
        () => {
          saveTimer = null;
          void save();
        },
        promotionBook.uploaded.size > 0 ? LARGE_WORKSPACE_SAVE_DEBOUNCE_MS : CLOUD_SAVE_DEBOUNCE_MS,
      );
    };

    setSyncState({ status: "loading", error: null });
    void (async () => {
      try {
        workspace = await findCloudWorkspace(options);
        // A workspace whose stored content is gone has nothing to restore. Keep
        // the project so the first save appends a version to it, and save now
        // rather than on the next edit so later launches stop hitting the 404.
        let repairWorkspace = false;
        const content = workspace ? await downloadCloudWorkspace(workspace, options) : null;
        if (workspace && content === null) {
          console.warn("[GeoLibre] The cloud workspace has no content; saving a fresh copy.");
          repairWorkspace = true;
        }
        if (content !== null) {
          const project = parseProject(content);
          if (cancelled) return;
          const current = useAppStore.getState();
          if (current.projectGeneration !== initialGeneration || current.isDirty) {
            // The user opened/edited something while the request was in flight.
            // Do not replace it, and do not later autosave it over the remote copy.
            setSyncState({ status: "ready", error: null });
            return;
          }
          useAppStore.getState().loadProject(project, null, {
            rememberRecent: false,
            presenting: false,
          });
          // The saved workspace keeps the dataset id and drops the features.
          // The same refill collaboration uses puts them back; a layer that
          // is also in a live session shares that in-flight book, so this
          // does not start a second download.
          void rehydrateSharedLayersInStore(token, project.layers);
          lastContent = serializeProject(project);
        }

        if (cancelled) return;
        unsubscribe = useAppStore.subscribe((state, previous) => {
          const changed =
            projectChanged(state, previous) ||
            state.mapView !== previous.mapView ||
            state.comments !== previous.comments;
          if (!state.isDirty || !changed) return;
          changeRevision += 1;
          scheduleSave();
        });
        setSyncState({ status: "ready", error: null });

        // Covers an edit that landed after the final guard but before the
        // subscription was installed (for example, a very fast file drop).
        if (useAppStore.getState().isDirty || repairWorkspace) {
          changeRevision += 1;
          scheduleSave();
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        console.error("[GeoLibre] Could not restore the cloud workspace", error);
        setSyncState({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
      unsubscribe?.();
      if (saveTimer !== null) window.clearTimeout(saveTimer);
      if (savedNoticeTimer !== null) window.clearTimeout(savedNoticeTimer);
    };
  }, [baseUrl, mapControllerRef, mapReady, token]);

  return syncState;
}
