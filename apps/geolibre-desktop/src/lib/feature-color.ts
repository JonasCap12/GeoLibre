import {
  currentEditorIdentity,
  editorTrackingFieldNames,
  featureSelectionId,
  stampFeaturePropertiesEditorTracking,
  type GeoLibreLayer,
} from "@geolibre/core";
import { splitGeometryByArea } from "@geolibre/processing";
import type { Feature, FeatureCollection, GeoJsonProperties, Polygon } from "geojson";

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

/** Writes (or with null, strips) the paint on one feature's properties. */
function paintedProperties(layer: GeoLibreLayer, color: string | null) {
  // One identity and timestamp for the whole paint, as a field calculation
  // stamps: a paint is a single edit however many features it touches.
  const stampOptions = editorTrackingFieldNames(layer.editorTracking)
    ? {
        config: layer.editorTracking,
        userIdentity: currentEditorIdentity(),
        timestamp: new Date().toISOString(),
      }
    : null;
  return (source: GeoJsonProperties): GeoJsonProperties => {
    const properties: Record<string, unknown> = { ...(source ?? {}) };
    for (const key of FEATURE_COLOR_KEYS) {
      if (color === null) delete properties[key];
      else properties[key] = color;
    }
    return stampOptions
      ? stampFeaturePropertiesEditorTracking(properties, "update", stampOptions)
      : properties;
  };
}

/** The layer patch around a painted feature list. */
function paintPatch(
  layer: GeoLibreLayer & { geojson: FeatureCollection },
  features: Feature[],
  color: string | null,
): Partial<GeoLibreLayer> {
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
  const paint = paintedProperties(layer, color);
  let changed = 0;
  const features = layer.geojson.features.map((feature, index) => {
    if (!featureIds.has(featureSelectionId(feature, index))) return feature;
    changed += 1;
    return { ...feature, properties: paint(feature.properties) };
  });
  if (changed === 0) return null;
  return paintPatch({ ...layer, geojson: layer.geojson }, features, color);
}

/**
 * Build the layer patch that paints only what lies inside a drawn area.
 *
 * A feature wholly inside is painted in place. One the area's edge crosses is
 * split there: the outside part keeps the feature's properties and id, and the
 * inside part becomes a new feature right after it carrying the paint, so a
 * sweep over one stretch of a long road line recolours that stretch alone.
 *
 * @param layer - The layer holding the features.
 * @param area - The drawn area, one ring in longitude/latitude.
 * @param color - A `#rrggbb` color, or null to strip the paint inside the area.
 * @returns The patch for `updateLayer`, or null when the layer has no
 *   in-store features or nothing of it lies inside the area.
 */
export function featureAreaColorPatch(
  layer: GeoLibreLayer,
  area: Polygon,
  color: string | null,
): Partial<GeoLibreLayer> | null {
  if (!layer.geojson) return null;
  const paint = paintedProperties(layer, color);
  let changed = 0;
  const features: Feature[] = [];
  for (const feature of layer.geojson.features) {
    const split = feature.geometry ? splitGeometryByArea(feature.geometry, area) : null;
    if (!split?.inside) {
      features.push(feature);
      continue;
    }
    changed += 1;
    if (!split.outside) {
      features.push({ ...feature, properties: paint(feature.properties) });
      continue;
    }
    features.push({ ...feature, geometry: split.outside });
    // The outside part keeps the id. The inside part gets a derived one, since
    // selection keys on ids and must still tell the two parts apart.
    const { id, ...rest } = feature;
    features.push({
      ...rest,
      ...(id !== undefined ? { id: `${id}-${features.length}` } : {}),
      geometry: split.inside,
      properties: paint(feature.properties),
    });
  }
  if (changed === 0) return null;
  return paintPatch({ ...layer, geojson: layer.geojson }, features, color);
}
