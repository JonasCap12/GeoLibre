import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "./types";

/** Private property on renderer copies; never added to the store's feature data. */
export const PROGRESS_DASHBOARD_INDEX_PROPERTY = "__progress_index";
const identified = new WeakMap<FeatureCollection, FeatureCollection>();

/** Renderer-only view; saved features, their IDs and the user's filters stay untouched. */
export function progressDashboardLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const dashboard = layer.progressDashboard;
  if (!dashboard) return layer;
  let geojson = layer.geojson;
  if (geojson) {
    let cached = identified.get(geojson);
    if (!cached) {
      cached = {
        ...geojson,
        features: geojson.features.map((feature, index) => ({
          ...feature,
          properties: { ...feature.properties, [PROGRESS_DASHBOARD_INDEX_PROPERTY]: index },
        })),
      };
      identified.set(geojson, cached);
    }
    geojson = cached;
  }
  return {
    ...layer,
    geojson,
    embedFilter: layer.embedFilter?.length
      ? ["all", layer.embedFilter, dashboard.filter]
      : dashboard.filter,
    style: {
      ...layer.style,
      simpleStyleEnabled: false,
      vectorStyleMode: "expression",
      vectorStyleExpression: dashboard.colorExpression,
    },
  };
}

/** Resolve rendered hits back to original data for selection, identify and popups. */
export function progressDashboardFeature(
  layer: GeoLibreLayer | undefined,
  properties: Record<string, unknown> | null | undefined,
): { feature: Feature; index: number } | null {
  const index = properties?.[PROGRESS_DASHBOARD_INDEX_PROPERTY];
  if (
    !layer?.progressDashboard ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0
  )
    return null;
  const feature = layer.geojson?.features[index];
  return feature ? { feature, index } : null;
}
