import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, GeoJsonProperties } from "geojson";
import { PROGRESS_METADATA_KEY, PROGRESS_STATUS_PROPERTY } from "./construction-progress";
import {
  ROAD_ITEM_KEYS,
  clampProgressPct,
  packageForStation,
  type BridgeState,
  type GirderStage,
  type ProgressV2,
  type RoadItemKey,
  type ProgressV2ItemKey,
} from "./progress-v2";

export const PROGRESS_V2_COLORS = {
  empty: "#edf1ef",
  wip: "#d9a520",
  done: "#1f7a47",
  girder: ["#edf1ef", "#f1e4a8", "#dcb94a", "#b39a6a", "#8cc66d", "#1f7a47"],
} as const;

export type ProgressFeatureStatus = "empty" | "wip" | "done" | `stage-${GirderStage}`;

export interface ProgressFeatureColor {
  color: string;
  status: ProgressFeatureStatus;
}

export type ProgressFeatureTarget =
  | { kind: "support"; bridgeId: string; id: string }
  | { kind: "span"; bridgeId: string; id: string }
  | { kind: "km"; id: string }
  | { kind: "underpass"; id: string };

function propertyText(feature: Feature, key: string): string {
  const value = feature.properties?.[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function propertyIndex(feature: Feature, key: string): number | null {
  const raw = feature.properties?.[key];
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

export function progressStateColor(percent: number): ProgressFeatureColor {
  const value = clampProgressPct(percent);
  if (value >= 100) return { color: PROGRESS_V2_COLORS.done, status: "done" };
  if (value > 0) return { color: PROGRESS_V2_COLORS.wip, status: "wip" };
  return { color: PROGRESS_V2_COLORS.empty, status: "empty" };
}

export function girderStageColor(stage: GirderStage): ProgressFeatureColor {
  return { color: PROGRESS_V2_COLORS.girder[stage], status: `stage-${stage}` };
}

function bridgeApproachPct(bridge: BridgeState): number {
  let numerator = 0;
  let denominator = 0;
  for (const span of bridge.spans) {
    numerator += span.ht * span.L;
    denominator += span.L;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

function supportKey(feature: Feature): "be" | "than" | "xm" | null {
  const item = fold(
    propertyText(feature, "progress_item") ||
      `${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`,
  );
  if (/^(be)$|\bbe\b/.test(item)) return "be";
  if (/^(than)$|than mo|than tru|cot tru|tuong than/.test(item)) return "than";
  if (/^(xm)$|xa mu|tuong dinh/.test(item)) return "xm";
  return null;
}

/** Item links shared by map colors and dashboard cross-filtering. */
export function progressFeatureItems(feature: Feature): ProgressV2ItemKey[] {
  if (propertyText(feature, "support_id")) {
    if (propertyIndex(feature, "pile_index") !== null) return ["coc"];
    const key = supportKey(feature);
    return key ? [key] : [];
  }
  if (propertyText(feature, "span_id")) {
    if (propertyIndex(feature, "girder_index") !== null) return ["duc", "gac"];
    const item = fold(
      propertyText(feature, "progress_item") ||
        `${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`,
    );
    if (/^(bmc)$|ban mat cau/.test(item)) return ["bmc"];
    if (/^(ht)$|lan can|hoan thien/.test(item)) return ["ht"];
    return [];
  }
  if (propertyText(feature, "km_id")) {
    const key = roadKey(feature);
    return key ? [key] : [];
  }
  if (propertyText(feature, "underpass_id")) {
    const item = fold(
      propertyText(feature, "progress_item") ||
        propertyText(feature, "bo_phan") ||
        propertyText(feature, "Layer"),
    );
    if (/ham_tuong|tuong/.test(item)) return ["ham_tuong"];
    if (/ham_nap|nap/.test(item)) return ["ham_nap"];
  }
  return [];
}

function supportColor(feature: Feature, bridge: BridgeState): ProgressFeatureColor | null {
  const supportId = propertyText(feature, "support_id");
  const support = bridge.supports.find((item) => item.id === supportId);
  if (!support) return null;
  const pileIndex = propertyIndex(feature, "pile_index");
  if (pileIndex !== null) {
    const state = support.piles[pileIndex] ?? 0;
    return state === 2
      ? progressStateColor(100)
      : state === 1
      ? progressStateColor(50)
      : progressStateColor(0);
  }
  const key = supportKey(feature);
  return key ? progressStateColor(support[key]) : null;
}

function spanColor(feature: Feature, bridge: BridgeState): ProgressFeatureColor | null {
  const spanId = propertyText(feature, "span_id");
  const span = bridge.spans.find((item) => item.id === spanId);
  if (!span) return null;
  const girderIndex = propertyIndex(feature, "girder_index");
  if (girderIndex !== null) return girderStageColor(span.girders[girderIndex]?.st ?? 0);
  const item = fold(
    propertyText(feature, "progress_item") ||
      `${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`,
  );
  if (/^(bmc)$|ban mat cau/.test(item)) return progressStateColor(span.bmc);
  if (/^(ht)$|lan can|hoan thien/.test(item)) return progressStateColor(span.ht);
  return null;
}

function roadKey(feature: Feature): RoadItemKey | null {
  const explicit = propertyText(feature, "progress_item").replaceAll("-", "_") as RoadItemKey;
  if (ROAD_ITEM_KEYS.includes(explicit)) return explicit;
  const item = fold(`${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`);
  if (/mat duong.*trai/.test(item)) return "mat_trai";
  if (/mat duong.*phai/.test(item)) return "mat_phai";
  if (/le gia co/.test(item)) return "le";
  if (/dai phan cach|\bdpc\b/.test(item)) return "dpc";
  if (/ranh doc|\branh\b/.test(item)) return "ranh";
  if (/nen duong|than nen|mai taluy|le dat|\bnen\b/.test(item)) return "nen";
  return null;
}

function featureColor(feature: Feature, state: ProgressV2): ProgressFeatureColor | null {
  const bridgeId = propertyText(feature, "bridge_id");
  if (bridgeId) {
    const bridge = state.bridges.find((item) => item.id === bridgeId);
    if (!bridge) return null;
    if (propertyText(feature, "support_id")) return supportColor(feature, bridge);
    if (propertyText(feature, "span_id")) return spanColor(feature, bridge);
    const item = fold(propertyText(feature, "progress_item"));
    if (item === "ht" || item === "approach")
      return progressStateColor(bridgeApproachPct(bridge));
  }
  const kmId = propertyText(feature, "km_id");
  if (kmId) {
    const km = state.road.km.find((item) => item.id === kmId);
    const key = roadKey(feature);
    return km && key ? progressStateColor(km.pct[key]) : null;
  }
  const underpassId = propertyText(feature, "underpass_id");
  if (underpassId) {
    const underpass = state.underpasses.find((item) => item.id === underpassId);
    if (!underpass) return null;
    const item = fold(
      propertyText(feature, "progress_item") ||
        `${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`,
    );
    if (/ham_tuong|tuong/.test(item)) return progressStateColor(underpass.pct.tuong);
    if (/ham_nap|nap/.test(item)) return progressStateColor(underpass.pct.nap);
  }
  return null;
}

/** Map each linked drawing feature to the color derived from element-level progress state. */
export function stateColors(
  features: readonly Feature[],
  state: ProgressV2,
): Map<number, ProgressFeatureColor> {
  const colors = new Map<number, ProgressFeatureColor>();
  features.forEach((feature, index) => {
    const color = featureColor(feature, state);
    if (color) colors.set(index, color);
  });
  return colors;
}

/** Resolve a map-clicked feature to the editor entity it represents. */
export function progressFeatureTarget(feature: Feature): ProgressFeatureTarget | null {
  const bridgeId = propertyText(feature, "bridge_id");
  const supportId = propertyText(feature, "support_id");
  if (bridgeId && supportId) return { kind: "support", bridgeId, id: supportId };
  const spanId = propertyText(feature, "span_id");
  if (bridgeId && spanId) return { kind: "span", bridgeId, id: spanId };
  const kmId = propertyText(feature, "km_id");
  if (kmId) return { kind: "km", id: kmId };
  const underpassId = propertyText(feature, "underpass_id");
  if (underpassId) return { kind: "underpass", id: underpassId };
  return null;
}

function paintedProperties(
  properties: GeoJsonProperties,
  { color, status }: ProgressFeatureColor,
): GeoJsonProperties {
  const next: Record<string, unknown> = {
    ...(properties ?? {}),
    fill: color,
    stroke: color,
    "marker-color": color,
  };
  if (status === "empty" || status === "stage-0") delete next[PROGRESS_STATUS_PROPERTY];
  else
    next[PROGRESS_STATUS_PROPERTY] = status === "done" || status === "stage-5" ? "done" : "wip";
  return next;
}

/**
 * One layer patch containing both the v2 metadata update and every derived
 * feature color. Passing this once to `updateLayer` makes an edit one undo step.
 */
export function progressV2LayerPatch(
  layer: GeoLibreLayer,
  state: ProgressV2,
): Partial<GeoLibreLayer> {
  const metadata = {
    ...layer.metadata,
    [PROGRESS_METADATA_KEY]: state,
    // Per-feature simplestyle properties make the embedded geometry differ
    // from a source/library reference, exactly as feature-color painting does.
    geometryEdited: true,
  };
  if (!layer.geojson) return { metadata };
  const colors = stateColors(layer.geojson.features, state);
  const features = layer.geojson.features.map((feature, index) => {
    const color = colors.get(index);
    return color
      ? { ...feature, properties: paintedProperties(feature.properties, color) }
      : feature;
  });
  return {
    metadata,
    geojson: { ...layer.geojson, features },
    style: layer.style.simpleStyleEnabled
      ? layer.style
      : { ...layer.style, simpleStyleEnabled: true },
  };
}

/** Features within a package, used to fit the map after package selection. */
export function packageFeatureIndexes(
  features: readonly Feature[],
  state: ProgressV2,
  packageId: string | null,
): number[] {
  if (packageId === null) return features.map((_, index) => index);
  const indexes: number[] = [];
  features.forEach((feature, index) => {
    const bridgeId = propertyText(feature, "bridge_id");
    const bridge = bridgeId ? state.bridges.find((item) => item.id === bridgeId) : null;
    if (bridge && packageForStation(state.packages, bridge.station)?.id === packageId) {
      indexes.push(index);
      return;
    }
    const kmId = propertyText(feature, "km_id");
    const km = kmId ? state.road.km.find((item) => item.id === kmId) : null;
    const packageItem = state.packages.find((item) => item.id === packageId);
    if (
      km &&
      packageItem &&
      Math.max(km.from, packageItem.fromStation) < Math.min(km.to, packageItem.toStation)
    ) {
      indexes.push(index);
      return;
    }
    const underpassId = propertyText(feature, "underpass_id");
    const underpass = underpassId
      ? state.underpasses.find((item) => item.id === underpassId)
      : null;
    if (underpass && packageForStation(state.packages, underpass.station)?.id === packageId)
      indexes.push(index);
  });
  return indexes;
}
