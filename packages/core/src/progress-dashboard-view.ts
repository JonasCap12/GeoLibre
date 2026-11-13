import type { Feature, FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "./types";
import { featureSelectionId } from "./selection";

/** Private property on renderer copies; never added to the store's feature data. */
export const PROGRESS_DASHBOARD_INDEX_PROPERTY = "__geolibre_progress_index";
const identified = new WeakMap<FeatureCollection, FeatureCollection>();

/** Renderer-only view; saved features, their IDs and the user's filters stay untouched. */
export function progressDashboardLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const dashboard = layer.progressDashboard;
  if (!dashboard) return layer;
  const geojson = layer.geojson;
  if (geojson && !identified.has(geojson)) {
    identified.set(geojson, {
      ...geojson,
      features: geojson.features.map((feature, index) => ({
        ...feature,
        properties: { ...feature.properties, [PROGRESS_DASHBOARD_INDEX_PROPERTY]: index },
      })),
    });
  }
  return {
    ...layer,
    geojson: geojson ? identified.get(geojson) : undefined,
    embedFilter: layer.embedFilter?.length
      ? ["all", layer.embedFilter, dashboard.filter]
      : dashboard.filter,
    style: {
      ...layer.style,
      pointRenderer: "single",
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
  const index = layer?.progressDashboard
    ? properties?.[PROGRESS_DASHBOARD_INDEX_PROPERTY]
    : undefined;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  const feature = layer?.geojson?.features[index];
  return feature ? { feature, index } : null;
}

/** Keep renderer-only attributes out of identify, selection and hover results. */
export function resolveRenderedFeature<T extends { properties?: Record<string, unknown> | null }>(
  layer: GeoLibreLayer | undefined,
  rendered: T,
) {
  const original = progressDashboardFeature(layer, rendered.properties);
  const feature = original?.feature ?? rendered;
  return {
    feature,
    properties: feature.properties ?? {},
    featureId: original ? featureSelectionId(original.feature, original.index) : null,
  };
}
