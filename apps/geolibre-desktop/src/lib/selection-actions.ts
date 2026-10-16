import {
  featureSelectionId,
  invertSelection,
  useAppStore,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { MapEngine } from "@geolibre/map";
import type { Feature, FeatureCollection, Polygon } from "geojson";
import { featureAreaColorPatch, featureColorPatch, type PaintProperties } from "./feature-color";

/**
 * Actions on the live feature selection (#1314), shared by the Edit menu and
 * the layer panel's context menu. The selection always lives on the active
 * layer (`selectedLayerId`), so these act on that layer's features.
 */

/** The layer currently holding the selection, when its features are loaded. */
export function selectionHolderLayer(): GeoLibreLayer | null {
  const store = useAppStore.getState();
  const layer = store.layers.find((l) => l.id === store.selectedLayerId);
  return layer?.geojson?.features ? layer : null;
}

/** The selected features of the active layer, in layer order. */
function selectedFeatures(): { layer: GeoLibreLayer; features: Feature[] } | null {
  const layer = selectionHolderLayer();
  if (!layer) return null;
  const selected = new Set(useAppStore.getState().selectedFeatureIds);
  const features = (layer.geojson?.features ?? []).filter((feature, index) =>
    selected.has(featureSelectionId(feature, index)),
  );
  return { layer, features };
}

/**
 * Re-exported from `@geolibre/core`, where it lives so the map's drawing
 * gestures share the one implementation. Kept exported here because the
 * dialogs and menus in this app import it from this module.
 */
export { applyMatchedSelection } from "@geolibre/core";

/**
 * QGIS "Invert selection": select every unselected feature of the active
 * layer. With nothing selected this selects all features.
 */
export function invertLayerSelection(): void {
  const layer = selectionHolderLayer();
  if (!layer) return;
  const store = useAppStore.getState();
  const allIds = (layer.geojson?.features ?? []).map(featureSelectionId);
  store.selectFeatures(invertSelection(allIds, store.selectedFeatureIds));
}

/** Clear the selection (keeps the layer active). */
export function clearFeatureSelection(): void {
  useAppStore.getState().selectFeature(null);
}

/**
 * Paint the selected features `color`, or restore the layer style on them
 * when `color` is null. The selection is cleared afterwards: its highlight
 * would otherwise cover the color that was just applied. Returns how many
 * features were painted. `extra` properties (such as a construction state)
 * are written with the color.
 */
export function paintSelection(color: string | null, extra?: PaintProperties): number {
  const layer = selectionHolderLayer();
  if (!layer) return 0;
  const store = useAppStore.getState();
  const ids = new Set(store.selectedFeatureIds);
  const patch = featureColorPatch(layer, ids, color, extra);
  if (!patch) return 0;
  store.updateLayer(layer.id, patch);
  clearFeatureSelection();
  return ids.size;
}

/**
 * Paint given features of a layer `color` (or with null, strip the paint),
 * such as one cell of the progress screen's component table. Unlike
 * {@link paintSelection} it leaves the live selection alone. Returns how many
 * features were painted.
 */
export function paintFeatures(
  layerId: string,
  featureIds: ReadonlySet<string>,
  color: string | null,
  extra?: PaintProperties,
): number {
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (!layer) return 0;
  const patch = featureColorPatch(layer, featureIds, color, extra);
  if (!patch) return 0;
  store.updateLayer(layer.id, patch);
  return featureIds.size;
}

/**
 * Paint `color` (or with null, strip the paint) on only what lies inside a
 * drawn area of a layer, splitting features its edge crosses. Returns whether
 * anything was inside.
 */
export function paintArea(
  layerId: string,
  area: Polygon,
  color: string | null,
  extra?: PaintProperties,
  keepWhole?: (feature: Feature) => boolean,
): boolean {
  const store = useAppStore.getState();
  const layer = store.layers.find((item) => item.id === layerId);
  if (!layer) return false;
  const patch = featureAreaColorPatch(layer, area, color, extra, keepWhole);
  if (!patch) return false;
  store.updateLayer(layer.id, patch);
  // Splitting inserts features, so index-based selection ids on this layer
  // would now point at different features.
  if (store.selectedLayerId === layer.id) clearFeatureSelection();
  return true;
}

/** Fit the map to the selected features (re-using the highlight overlay). */
export function zoomToSelection(controller: MapEngine | null): void {
  const store = useAppStore.getState();
  const layer = selectionHolderLayer();
  if (!layer || store.selectedFeatureIds.length === 0) return;
  controller?.highlightFeature(layer, store.selectedFeatureIds, { fit: true });
}

/**
 * Materialize the selected features as a new GeoJSON layer. Returns the new
 * layer's id, or null when nothing is selected. `layerName` is the translated
 * display name supplied by the caller.
 */
export function exportSelectionAsLayer(layerName: string): string | null {
  const result = selectedFeatures();
  if (!result || result.features.length === 0) return null;
  const collection: FeatureCollection = {
    type: "FeatureCollection",
    features: result.features,
  };
  return useAppStore.getState().addGeoJsonLayer(layerName, collection);
}
