import { useAppStore } from "@geolibre/core";
import {
  DEFAULT_TERRAIN_EXAGGERATION,
  TERRAIN_TOGGLE_EVENT,
  type MapEngine,
  type TerrainToggleDetail,
} from "@geolibre/map";
import { useEffect, useRef } from "react";
import { applyTerrainLook } from "../lib/terrain-look";

/**
 * Apply the project's 3D terrain (`terrainEnabled`, exaggeration and DEM
 * source) to the live map.
 *
 * Terrain is project state rather than optional map chrome, so restoring it
 * cannot live in the toolbar: embeds that hide the toolbar (`?maponly`, used by
 * share.geolibre.app for thumbnails) never mount it and would render a saved 3D
 * project flat. Re-runs on project load and on controller/style initialization
 * so reopening a project brings back both the control and its terrain surface.
 *
 * Args:
 *     mapControllerRef: Ref to the live MapController.
 *     mapReadyGeneration: Bumped whenever the controller/style reinitialises.
 *     projectGeneration: Bumped whenever a project is loaded.
 */
export function useTerrainRestore(
  mapControllerRef: React.RefObject<MapEngine | null>,
  mapReadyGeneration: number,
  projectGeneration: number,
): void {
  const terrainEnabled = useAppStore((state) => state.preferences.map.terrainEnabled);
  // The engine and project the saved look was last applied to. A style reload
  // keeps the engine's own exaggeration and source, so only a new engine or a
  // new project applies it again; the Terrain settings dialog drives the
  // engine directly in between.
  const applied = useRef<{ engine: MapEngine; projectGeneration: number } | null>(null);

  useEffect(() => {
    const engine = mapControllerRef.current;
    if (!engine) return;
    // On a map with a terrain button the button always shows, in the
    // top-right control column; `terrainEnabled` only says whether terrain is
    // on. A project saved with terrain off used to lose the button entirely.
    if (terrainEnabled) engine.setBuiltInControlVisible("terrain", true);
    else if (engine.showTerrainToggle) engine.showTerrainToggle();
    else engine.setBuiltInControlVisible("terrain", false);
  }, [mapControllerRef, mapReadyGeneration, projectGeneration, terrainEnabled]);

  // Save a click on the terrain button in the project, so the choice survives
  // a reload and the autosave instead of snapping back to the saved state.
  useEffect(() => {
    const onToggle = (event: Event) => {
      const { enabled } = (event as CustomEvent<TerrainToggleDetail>).detail;
      const { preferences, setPreferences } = useAppStore.getState();
      if (preferences.map.terrainEnabled === enabled) return;
      setPreferences({ ...preferences, map: { ...preferences.map, terrainEnabled: enabled } });
    };
    window.addEventListener(TERRAIN_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(TERRAIN_TOGGLE_EVENT, onToggle);
  }, []);

  useEffect(() => {
    const engine = mapControllerRef.current;
    if (!engine) return;
    const last = applied.current;
    if (last?.engine === engine && last.projectGeneration === projectGeneration) return;
    applied.current = { engine, projectGeneration };
    applyTerrainLook(engine, useAppStore.getState().preferences.map, {
      reset: last !== null && last.projectGeneration !== projectGeneration,
      defaultExaggeration: DEFAULT_TERRAIN_EXAGGERATION,
    });
  }, [mapControllerRef, mapReadyGeneration, projectGeneration]);
}
