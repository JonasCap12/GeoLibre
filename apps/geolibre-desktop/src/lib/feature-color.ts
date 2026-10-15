import {
  currentEditorIdentity,
  editorTrackingFieldNames,
  featureSelectionId,
  stampFeaturePropertiesEditorTracking,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { FeatureCollection } from "geojson";

/**
 * Paint individual features of a vector layer with their own color, such as
 * marking finished segments of a technical drawing one batch at a time.
 *
 * The color is written as per-feature simplestyle properties (`stroke` for
 * lines and outlines, `fill` for polygons, `marker-color` for points), and the
 * layer's `simpleStyleEnabled` is switched on so those properties override the
 * layer style. Features left unpainted keep the layer style unchanged, and the
 * color travels with the features into a saved project or a GeoJSON export.
 */

/** The simplestyle keys a paint writes, one per geometry channel. */
export const FEATURE_COLOR_KEYS = ["stroke", "fill", "marker-color"] as const;

/** Preset paint colors offered by the menu, keyed by their catalog label. */
export const FEATURE_COLOR_PRESETS = [
  { color: "#dc2626", labelKey: "layers.featureColor.red" },
  { color: "#f97316", labelKey: "layers.featureColor.orange" },
  { color: "#facc15", labelKey: "layers.featureColor.yellow" },
  { color: "#16a34a", labelKey: "layers.featureColor.green" },
  { color: "#0ea5e9", labelKey: "layers.featureColor.cyan" },
  { color: "#2563eb", labelKey: "layers.featureColor.blue" },
  { color: "#9333ea", labelKey: "layers.featureColor.purple" },
  { color: "#6b7280", labelKey: "layers.featureColor.gray" },
] as const;

/**
 * Build the layer patch that paints the given features `color`, or strips
 * their paint when `color` is null.
 *
 * @param layer - The layer holding the features.
 * @param featureIds - Selection ids (see `featureSelectionId`) of the features to paint.
 * @param color - A `#rrggbb` color, or null to restore the layer style.
 * @returns The patch for `updateLayer`, or null when the layer has no
 *   in-store features or none of the ids match.
 */
export function featureColorPatch(
  layer: GeoLibreLayer,
  featureIds: ReadonlySet<string>,
  color: string | null,
): Partial<GeoLibreLayer> | null {
  if (!layer.geojson || featureIds.size === 0) return null;

  // One identity and timestamp for the whole paint, as a field calculation
  // stamps: a paint is a single edit however many features it touches.
  const stampOptions = editorTrackingFieldNames(layer.editorTracking)
    ? {
        config: layer.editorTracking,
        userIdentity: currentEditorIdentity(),
        timestamp: new Date().toISOString(),
      }
    : null;

  let changed = 0;
  const features = layer.geojson.features.map((feature, index) => {
    if (!featureIds.has(featureSelectionId(feature, index))) return feature;
    changed += 1;
    const properties: Record<string, unknown> = { ...(feature.properties ?? {}) };
    for (const key of FEATURE_COLOR_KEYS) {
      if (color === null) delete properties[key];
      else properties[key] = color;
    }
    return {
      ...feature,
      properties: stampOptions
        ? stampFeaturePropertiesEditorTracking(properties, "update", stampOptions)
        : properties,
    };
  });
  if (changed === 0) return null;

  const geojson: FeatureCollection = { ...layer.geojson, features };
  // The painted features no longer match the file or shared dataset the layer
  // came from. Without the edit flag a save keeps only that reference (a
  // library layer drops its features from the cloud workspace and a reloadable
  // desktop file saves its path), and reopening loads the drawing unpainted.
  const metadata = { ...layer.metadata, geometryEdited: true };
  // Clearing leaves the flag on: other features may still carry paint, and
  // with no simplestyle property a feature renders the layer style anyway.
  if (color === null || layer.style.simpleStyleEnabled) return { geojson, metadata };
  return { geojson, metadata, style: { ...layer.style, simpleStyleEnabled: true } };
}
