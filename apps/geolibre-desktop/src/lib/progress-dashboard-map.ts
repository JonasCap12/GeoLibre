import { progressDashboardFeature, type GeoLibreLayer } from "@geolibre/core";
import type { Map as MapLibreMap } from "maplibre-gl";
import { featuresBounds } from "./construction-progress";

export interface DashboardCamera {
  fitBounds(bounds: [number, number, number, number]): void;
  getMap?: () => MapLibreMap | null;
}
/** Rendering integration stays outside the UI; authored feature data is never patched. */
export function fitDashboardMap(
  camera: DashboardCamera | null | undefined,
  layer: GeoLibreLayer,
  indexes: number[],
) {
  const bounds = featuresBounds(
    indexes.flatMap((i) => (layer.geojson?.features[i] ? [layer.geojson.features[i]] : [])),
  );
  if (!bounds || !camera) return;
  const map = camera.getMap?.();
  if (map) {
    map.resize();
    map.fitBounds(
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      { pitch: 55, padding: 48, maxZoom: 19, duration: 350 },
    );
  } else camera.fitBounds(bounds);
}
export function watchDashboardMap(
  camera: DashboardCamera | null | undefined,
  getLayer: () => GeoLibreLayer,
  onManual: () => void,
  onHover: (hit: { index: number; x: number; y: number } | null) => void,
) {
  const map = camera?.getMap?.();
  if (!map) return () => {};
  const manual = (event: { originalEvent?: unknown }) => {
    if (event.originalEvent) onManual();
  };
  const move = (event: { point: { x: number; y: number } }) => {
    const layer = getLayer();
    const hit = map
      .queryRenderedFeatures([event.point.x, event.point.y])
      .find((f) => f.source === `source-${layer.id}`);
    const original = hit ? progressDashboardFeature(layer, hit.properties) : null;
    const box = map.getCanvas().getBoundingClientRect();
    onHover(
      original
        ? { index: original.index, x: box.x + event.point.x, y: box.y + event.point.y }
        : null,
    );
  };
  const leave = () => onHover(null);
  map.on("dragstart", manual);
  map.on("zoomstart", manual);
  map.on("rotatestart", manual);
  map.on("pitchstart", manual);
  map.on("mousemove", move);
  map.on("mouseout", leave);
  return () => {
    map.off("dragstart", manual);
    map.off("zoomstart", manual);
    map.off("rotatestart", manual);
    map.off("pitchstart", manual);
    map.off("mousemove", move);
    map.off("mouseout", leave);
  };
}
export function captureDashboardMap(
  camera: DashboardCamera | null | undefined,
): Promise<string | null> {
  const map = camera?.getMap?.();
  if (!map) return Promise.resolve(null);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      try {
        resolve(map.getCanvas().toDataURL("image/png"));
      } catch {
        resolve(null);
      }
    };
    const timer = setTimeout(() => {
      map.off("render", finish);
      resolve(null);
    }, 2000);
    map.once("render", finish);
    map.triggerRepaint();
  });
}
