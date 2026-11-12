import type { FeatureCollection } from "geojson";
import type { GeoLibreLayer } from "./types";

const identified = new WeakMap<FeatureCollection, FeatureCollection>();

/** Renderer-only view; saved features, their colors and the user's style remain untouched. */
export function progressDashboardLayer(layer: GeoLibreLayer): GeoLibreLayer {
  const dashboard = layer.progressDashboard;
  if (!dashboard) return layer;
  let geojson = layer.geojson;
  if (geojson) {
    let cached = identified.get(geojson);
    if (!cached) {
      cached = {
        ...geojson,
        features: geojson.features.map((feature, index) =>
          feature.id == null ? { ...feature, id: index } : feature,
        ),
      };
      identified.set(geojson, cached);
    }
    geojson = cached;
  }
  return {
    ...layer,
    geojson,
    style: {
      ...layer.style,
      simpleStyleEnabled: false,
      vectorStyleMode: "expression",
      vectorStyleExpression: dashboard.colorExpression,
    },
  };
}
