import { useAppStore } from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import { useEffect, useRef } from "react";
import i18n from "../i18n";
import { notify } from "../lib/notify";
import {
  applySharedTerrain,
  clearSharedTerrainCache,
  readSharedTerrain,
} from "../lib/shared-terrain";
import { useDesktopSettingsStore } from "./useDesktopSettings";

/**
 * Put the project's shared-library terrain (`lib/shared-terrain.ts`) on the map.
 *
 * Runs when the project names a terrain dataset and someone is signed in, and
 * again when the project is reopened (opening a project resets the terrain to
 * what it saved, see useTerrainRestore), when the renderer is replaced, when
 * the dataset changes (a collaborator picked another), or after signing in.
 * A style reload keeps the engine's terrain, so it does not download again.
 *
 * Args:
 *     mapControllerRef: Ref to the live map engine.
 *     mapReadyGeneration: Bumped whenever the engine or its style is (re)initialised.
 *     projectGeneration: Bumped whenever a project is loaded.
 */
export function useSharedTerrain(
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  // Select primitives: an object selector would re-render on every store change.
  const datasetId = useAppStore((state) => readSharedTerrain(state.metadata)?.datasetId ?? null);
  const token = useDesktopSettingsStore((state) => state.desktopSettings.shareToken.trim());
  const applied = useRef<{ engine: MapEngine; key: string } | null>(null);

  useEffect(() => {
    const engine = mapControllerRef.current;
    if (!engine) return;
    if (!datasetId) {
      // The shared terrain was removed from the project: put back what the
      // project saves (a URL, or the built-in terrain).
      if (applied.current?.engine === engine) {
        applied.current = null;
        const saved = useAppStore.getState().preferences.map.terrainSource ?? null;
        if (engine.capabilities.terrainSource)
          void engine.setTerrainCogSource(saved).catch(() => undefined);
      }
      return;
    }
    if (!token) {
      // Signed out: the next member to sign in on this page downloads it themselves.
      clearSharedTerrainCache();
      return;
    }
    // Not keyed on the token: a refreshed sign-in (the cookie session swaps its
    // access token every few minutes) must not apply the terrain again. A new
    // token does retry after a failure, which clears `applied`.
    const key = `${datasetId}|${projectGeneration}`;
    if (applied.current?.engine === engine && applied.current.key === key) return;
    applied.current = { engine, key };
    const ref = readSharedTerrain(useAppStore.getState().metadata);
    if (!ref) return;
    let current = true;
    applySharedTerrain(engine, ref, token).then(
      (result) => {
        if (current && result === "unsupported") {
          notify.info(i18n.t("sharedTerrain.unsupportedRenderer"), { dedupeKey: "shared-terrain" });
        }
      },
      (error: unknown) => {
        // Let the next run (re-sign-in, reopening the project) try again.
        if (applied.current?.key === key) applied.current = null;
        if (!current) return;
        notify.error(i18n.t("sharedTerrain.loadFailed", { name: ref.name || ref.datasetId }), {
          error,
          dedupeKey: "shared-terrain",
        });
      },
    );
    return () => {
      current = false;
    };
  }, [mapControllerRef, mapReadyGeneration, projectGeneration, datasetId, token]);
}
