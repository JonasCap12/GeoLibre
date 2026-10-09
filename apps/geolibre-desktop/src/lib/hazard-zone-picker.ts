import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from "geojson";
import {
  HAZARD_FILL_COLOR,
  HAZARD_FILL_OPACITY,
  HAZARD_STROKE_COLOR,
  HAZARD_STROKE_WIDTH,
  HAZARD_ZONE_FLAG,
  hazardGeometryContainsPoint,
} from "./hazard-zones";

/** Marks the one dedicated layer that contains individually picked zones. */
export const HAZARD_COLLECTION_FLAG = "hazardZoneCollection";
/** Persisted project-data name required by the picker design. */
export const HAZARD_COLLECTION_NAME = "Vùng nguy hiểm";

export type HazardPolygonFeature = Feature<Polygon | MultiPolygon>;

export interface PickedHazardPolygon {
  layerId: string;
  layerName: string;
  featureIndex: number;
  feature: HazardPolygonFeature;
}

export interface HazardZoneEntry {
  featureKey: string;
  name: string;
  level: "nguy_hiem" | "canh_bao";
  sourceLayerName?: string;
  geometry: Polygon | MultiPolygon;
}

export interface HazardLayerChange {
  layers: GeoLibreLayer[];
  hazardLayerId: string;
  changed: boolean;
  created: boolean;
}

export function isDedicatedHazardLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    layer.metadata?.[HAZARD_ZONE_FLAG] === true &&
    layer.metadata?.[HAZARD_COLLECTION_FLAG] === true
  );
}

export function dedicatedHazardLayer(layers: readonly GeoLibreLayer[]): GeoLibreLayer | undefined {
  return layers.find(isDedicatedHazardLayer);
}

export function legacyHazardLayers(layers: readonly GeoLibreLayer[]): GeoLibreLayer[] {
  return layers.filter(
    (layer) =>
      layer.type === "geojson" &&
      layer.metadata?.[HAZARD_ZONE_FLAG] === true &&
      !isDedicatedHazardLayer(layer),
  );
}

/**
 * Pick the topmost visible source polygon under a map coordinate.
 *
 * Store order is bottom-to-top, so both layers and features are searched in
 * reverse. The dedicated hazard layer is excluded: callers check it
 * separately when a click should remove an existing zone.
 */
export function pickPolygonAt(
  lngLat: { lng: number; lat: number },
  layers: readonly GeoLibreLayer[],
): PickedHazardPolygon | null {
  for (let layerIndex = layers.length - 1; layerIndex >= 0; layerIndex -= 1) {
    const layer = layers[layerIndex];
    if (!layer.visible || layer.type !== "geojson" || isDedicatedHazardLayer(layer)) continue;
    const features = layer.geojson?.features ?? [];
    for (let featureIndex = features.length - 1; featureIndex >= 0; featureIndex -= 1) {
      const feature = polygonFeature(features[featureIndex]);
      if (!feature) continue;
      if (!hazardGeometryContainsPoint(lngLat.lng, lngLat.lat, feature.geometry)) continue;
      return { layerId: layer.id, layerName: layer.name, featureIndex, feature };
    }
  }
  return null;
}

/** Pick an already copied zone so the UI can offer to remove it. */
export function pickExistingHazardZoneAt(
  lngLat: { lng: number; lat: number },
  layers: readonly GeoLibreLayer[],
): PickedHazardPolygon | null {
  const layer = dedicatedHazardLayer(layers);
  if (!layer?.visible) return null;
  const features = layer.geojson?.features ?? [];
  for (let featureIndex = features.length - 1; featureIndex >= 0; featureIndex -= 1) {
    const feature = polygonFeature(features[featureIndex]);
    if (!feature) continue;
    if (hazardGeometryContainsPoint(lngLat.lng, lngLat.lat, feature.geometry)) {
      return { layerId: layer.id, layerName: layer.name, featureIndex, feature };
    }
  }
  return null;
}

export function createHazardCollectionLayer(
  id: string,
  features: HazardPolygonFeature[] = [],
): GeoLibreLayer {
  return {
    id,
    name: HAZARD_COLLECTION_NAME,
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: {
      ...DEFAULT_LAYER_STYLE,
      fillColor: HAZARD_FILL_COLOR,
      fillOpacity: HAZARD_FILL_OPACITY,
      strokeColor: HAZARD_STROKE_COLOR,
      strokeWidth: HAZARD_STROKE_WIDTH,
    },
    metadata: { [HAZARD_ZONE_FLAG]: true, [HAZARD_COLLECTION_FLAG]: true },
    geojson: featureCollection(features),
  };
}

/** Copy one picked polygon without changing or sharing objects with its source layer. */
export function addPickedHazardZone(
  layers: readonly GeoLibreLayer[],
  picked: PickedHazardPolygon,
  ids: { hazardLayerId: string; zoneFeatureId: string },
): HazardLayerChange {
  const copied = copyZoneFeature(picked, ids.zoneFeatureId);
  const current = dedicatedHazardLayer(layers);
  if (!current) {
    const created = createHazardCollectionLayer(ids.hazardLayerId, [copied]);
    return {
      layers: [...layers, created],
      hazardLayerId: created.id,
      changed: true,
      created: true,
    };
  }
  const updated = appendFeatures(current, [copied]);
  return {
    layers: replaceLayer(layers, updated),
    hazardLayerId: current.id,
    changed: true,
    created: false,
  };
}

export function removeHazardZone(
  layers: readonly GeoLibreLayer[],
  featureKey: string,
): HazardLayerChange | null {
  const current = dedicatedHazardLayer(layers);
  if (!current) return null;
  const features = current.geojson?.features ?? [];
  const next = features.filter((feature, index) => zoneFeatureKey(feature, index) !== featureKey);
  if (next.length === features.length) return null;
  const updated = withFeatures(current, next);
  return {
    layers: replaceLayer(layers, updated),
    hazardLayerId: current.id,
    changed: true,
    created: false,
  };
}

export function updateHazardZone(
  layers: readonly GeoLibreLayer[],
  featureKey: string,
  patch: { name?: string; level?: "nguy_hiem" | "canh_bao" },
): HazardLayerChange | null {
  const current = dedicatedHazardLayer(layers);
  if (!current) return null;
  let changed = false;
  const features = (current.geojson?.features ?? []).map((feature, index) => {
    if (zoneFeatureKey(feature, index) !== featureKey) return feature;
    const properties = { ...(feature.properties ?? {}) };
    if (patch.name !== undefined) properties.ten = patch.name;
    if (patch.level !== undefined) properties.muc = patch.level;
    changed = true;
    return { ...feature, properties };
  });
  if (!changed) return null;
  const updated = withFeatures(current, features);
  return {
    layers: replaceLayer(layers, updated),
    hazardLayerId: current.id,
    changed: true,
    created: false,
  };
}

/** Copy every polygon from a legacy flagged layer and clear only its old flag. */
export function migrateLegacyHazardLayer(
  layers: readonly GeoLibreLayer[],
  legacyLayerId: string,
  ids: { hazardLayerId: string; nextZoneFeatureId: () => string },
): HazardLayerChange | null {
  const legacy = layers.find((layer) => layer.id === legacyLayerId);
  if (!legacy || isDedicatedHazardLayer(legacy) || legacy.metadata?.[HAZARD_ZONE_FLAG] !== true)
    return null;
  const copied: HazardPolygonFeature[] = [];
  (legacy.geojson?.features ?? []).forEach((feature, featureIndex) => {
    const polygon = polygonFeature(feature);
    if (!polygon) return;
    copied.push(
      copyZoneFeature(
        { layerId: legacy.id, layerName: legacy.name, featureIndex, feature: polygon },
        ids.nextZoneFeatureId(),
      ),
    );
  });

  const metadata = { ...legacy.metadata };
  delete metadata[HAZARD_ZONE_FLAG];
  const unflagged = { ...legacy, metadata };
  const current = dedicatedHazardLayer(layers);
  const hazard = current
    ? appendFeatures(current, copied)
    : createHazardCollectionLayer(ids.hazardLayerId, copied);
  const replaced = layers.map((layer) => {
    if (layer.id === legacy.id) return unflagged;
    if (current && layer.id === current.id) return hazard;
    return layer;
  });
  return {
    layers: current ? replaced : [...replaced, hazard],
    hazardLayerId: hazard.id,
    changed: true,
    created: !current,
  };
}

export function unflagLegacyHazardLayer(
  layers: readonly GeoLibreLayer[],
  legacyLayerId: string,
): GeoLibreLayer[] | null {
  const legacy = layers.find((layer) => layer.id === legacyLayerId);
  if (!legacy || isDedicatedHazardLayer(legacy) || legacy.metadata?.[HAZARD_ZONE_FLAG] !== true)
    return null;
  const metadata = { ...legacy.metadata };
  delete metadata[HAZARD_ZONE_FLAG];
  return replaceLayer(layers, { ...legacy, metadata });
}

export function hazardZoneEntries(layers: readonly GeoLibreLayer[]): HazardZoneEntry[] {
  const layer = dedicatedHazardLayer(layers);
  if (!layer) return [];
  const entries: HazardZoneEntry[] = [];
  (layer.geojson?.features ?? []).forEach((feature, index) => {
    const polygon = polygonFeature(feature);
    if (!polygon) return;
    const properties = polygon.properties ?? {};
    entries.push({
      featureKey: zoneFeatureKey(polygon, index),
      name: readString(properties.ten) ?? readString(properties.name) ?? HAZARD_COLLECTION_NAME,
      level: readLevel(properties.muc),
      sourceLayerName: readString(properties.nguon_lop),
      geometry: polygon.geometry,
    });
  });
  return entries;
}

export function hazardGeometryBounds(
  geometry: Polygon | MultiPolygon,
): [number, number, number, number] | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
      west = Math.min(west, value[0]);
      south = Math.min(south, value[1]);
      east = Math.max(east, value[0]);
      north = Math.max(north, value[1]);
      return;
    }
    value.forEach(visit);
  };
  visit(geometry.coordinates);
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

function polygonFeature(feature: Feature): HazardPolygonFeature | null {
  return feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon"
    ? (feature as HazardPolygonFeature)
    : null;
}

function copyZoneFeature(picked: PickedHazardPolygon, id: string): HazardPolygonFeature {
  const properties = picked.feature.properties ?? {};
  const sourceId = picked.feature.id;
  return {
    type: "Feature",
    id,
    geometry: cloneGeometry(picked.feature.geometry),
    properties: {
      ten: readString(properties.ten) ?? readString(properties.name) ?? picked.layerName,
      muc: readLevel(properties.muc),
      nguon_lop: picked.layerName,
      ...(sourceId === undefined || sourceId === null ? {} : { nguon_id: sourceId }),
    },
  };
}

function cloneGeometry(geometry: Polygon | MultiPolygon): Polygon | MultiPolygon {
  const clonePosition = (position: Position): Position => [...position];
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring) => ring.map(clonePosition)),
    };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map((polygon) =>
      polygon.map((ring) => ring.map(clonePosition)),
    ),
  };
}

function featureCollection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features };
}

function appendFeatures(layer: GeoLibreLayer, features: Feature[]): GeoLibreLayer {
  return withFeatures(layer, [...(layer.geojson?.features ?? []), ...features]);
}

function withFeatures(layer: GeoLibreLayer, features: Feature[]): GeoLibreLayer {
  return {
    ...layer,
    geojson: { ...(layer.geojson ?? featureCollection([])), type: "FeatureCollection", features },
  };
}

function replaceLayer(
  layers: readonly GeoLibreLayer[],
  replacement: GeoLibreLayer,
): GeoLibreLayer[] {
  return layers.map((layer) => (layer.id === replacement.id ? replacement : layer));
}

function zoneFeatureKey(feature: Feature, index: number): string {
  return feature.id === undefined || feature.id === null ? `index:${index}` : String(feature.id);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLevel(value: unknown): "nguy_hiem" | "canh_bao" {
  const token = readString(value)?.toLowerCase();
  return token === "canh_bao" || token === "caution" || token === "warning"
    ? "canh_bao"
    : "nguy_hiem";
}
