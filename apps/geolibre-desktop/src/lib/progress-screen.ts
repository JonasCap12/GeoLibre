import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  findProgressLayer,
  progressConfigPatch,
  readStoredProgressConfig,
  suggestProgressConfig,
} from "./construction-progress";
import { notify } from "./notify";

/**
 * Which drawing layer the construction progress screen shows (null when it is
 * closed). The screen reads the layer from the app store, so it follows paint
 * and settings edits and closes itself if the layer goes away.
 *
 * While open, `data-progress-screen` on the document element lets
 * `index.css` pin the map area into the screen's map cell, so the shell does
 * not need its own layout for it.
 */

/** Document-element attribute the progress-screen CSS keys on. */
export const PROGRESS_SCREEN_ATTRIBUTE = "data-progress-screen";

let layerId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Whether a layer can carry construction progress: in-store vector features. */
export function canTrackProgress(layer: GeoLibreLayer): boolean {
  return layer.type === "geojson" && (layer.geojson?.features?.length ?? 0) > 0;
}

/**
 * The layer the screen should open on: the given one, else the project's
 * progress drawing, else the active layer when it can carry progress.
 *
 * A requested layer with no setup of its own yields to the project's progress
 * drawing when there is one: opening the screen from a label or reference
 * layer's menu would otherwise seed an empty setup there and show a blank
 * dashboard next to the drawing that holds the real progress.
 */
export function progressScreenTarget(
  layers: readonly GeoLibreLayer[],
  selectedLayerId: string | null,
  requested?: string,
): GeoLibreLayer | null {
  const existing = findProgressLayer(layers);
  if (requested) {
    const layer = layers.find((item) => item.id === requested);
    if (!layer || !canTrackProgress(layer)) return null;
    return readStoredProgressConfig(layer) || !existing ? layer : existing;
  }
  if (existing) return existing;
  const selected = layers.find((item) => item.id === selectedLayerId);
  return selected && canTrackProgress(selected) ? selected : null;
}

/**
 * Open the screen on a drawing layer. A layer without a setup gets one
 * suggested from its CAD layers, so the screen has something to show.
 *
 * @param requested A layer id; omitted, the screen picks one.
 * @returns The opened layer's id, or null when no layer can carry progress.
 */
export function openProgressScreen(requested?: string): string | null {
  const store = useAppStore.getState();
  const layer = progressScreenTarget(store.layers, store.selectedLayerId, requested);
  if (!layer) return null;
  if (!readStoredProgressConfig(layer)) {
    const config = suggestProgressConfig(layer.geojson?.features ?? [], layer.name);
    store.updateLayer(layer.id, progressConfigPatch(layer, config));
  }
  layerId = layer.id;
  emit();
  return layer.id;
}

/**
 * Open the screen from a menu or command, telling the user why when no layer
 * can carry progress.
 *
 * @param noLayerMessage The translated notice shown when nothing opens.
 */
export function openProgressScreenOrNotify(noLayerMessage: string): void {
  if (openProgressScreen() === null) notify.info(noLayerMessage);
}

/** Close the screen. */
export function closeProgressScreen(): void {
  if (layerId === null) return;
  layerId = null;
  emit();
}

/** The shown layer's id, or null when the screen is closed. */
export function getProgressScreenLayerId(): string | null {
  return layerId;
}

/**
 * Subscribe to open / close changes (for `useSyncExternalStore`).
 *
 * @param listener Called after each change.
 * @returns Unsubscribe.
 */
export function subscribeProgressScreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
