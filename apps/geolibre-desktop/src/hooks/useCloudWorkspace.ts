import { parseProject, serializeProject, useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { useEffect, useMemo, useState, type RefObject } from "react";
import { buildCollaborationSnapshot } from "../lib/build-project-snapshot";
import {
  createCloudWorkspace,
  downloadCloudWorkspace,
  findCloudWorkspace,
  updateCloudWorkspace,
  type CloudWorkspaceProject,
} from "../lib/cloud-workspace";
import { dataUrlParameters, serviceUrlParameter } from "../lib/data-url";
import { isTauri } from "../lib/is-tauri";
import { projectChanged } from "../lib/project-broadcast-changed";
import { projectUrlFromLocation } from "../lib/project-url";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { isEmbedded } from "./embedHost";
import { useDesktopSettingsStore } from "./useDesktopSettings";

const CLOUD_SAVE_DEBOUNCE_MS = 3_000;
const SAVED_NOTICE_MS = 2_500;

export type CloudWorkspaceStatus =
  | "disabled"
  | "loading"
  | "ready"
  | "saving"
  | "saved"
  | "error";

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
        const project = await buildCollaborationSnapshot(mapControllerRef);
        const content = serializeProject(project);
        if (content !== lastContent) {
          workspace = workspace
            ? await updateCloudWorkspace(workspace.id, content, options)
            : await createCloudWorkspace(content, options);
          lastContent = content;
        }
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
      saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void save();
      }, CLOUD_SAVE_DEBOUNCE_MS);
    };

    setSyncState({ status: "loading", error: null });
    void (async () => {
      try {
        workspace = await findCloudWorkspace(options);
        if (workspace) {
          const content = await downloadCloudWorkspace(workspace, options);
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
        if (useAppStore.getState().isDirty) {
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
