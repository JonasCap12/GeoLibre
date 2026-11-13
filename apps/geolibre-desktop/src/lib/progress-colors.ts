import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, GeoJsonProperties } from "geojson";
import {
  progressFeatureLink,
  propertyText,
  propertyIndex,
  fold,
  type ProgressFeatureLink,
} from "./progress-feature-link";
export { progressFeatureLink, propertyText, propertyIndex, fold } from "./progress-feature-link";
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
  | { kind: "approach"; bridgeId: string; id: string }
  | { kind: "km"; id: string }
  | { kind: "underpass"; id: string };

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
  const link = progressFeatureLink(feature);
  if (link?.kind === "support" || propertyText(feature, "support_id")) {
    if (link?.pileIndex !== undefined || propertyIndex(feature, "pile_index") !== null)
      return ["coc"];
    const key = supportKey(feature);
    return key ? [key] : [];
  }
  if (link?.kind === "span" || propertyText(feature, "span_id")) {
    if (link?.girderIndex !== undefined || propertyIndex(feature, "girder_index") !== null)
      return ["duc", "gac"];
    const item = fold(
      propertyText(feature, "progress_item") ||
        `${propertyText(feature, "Layer")} ${propertyText(feature, "bo_phan")}`,
    );
    if (/^(bmc)$|ban mat cau/.test(item)) return ["bmc"];
    if (/^(ht)$|lan can|hoan thien/.test(item)) return ["ht"];
    return [];
  }
  if (link?.kind === "km") {
    const key = roadKey(feature);
    return key ? [key] : [];
  }
  if (link?.kind === "underpass") {
    const item = fold(
      propertyText(feature, "progress_item") ||
        propertyText(feature, "bo_phan") ||
        propertyText(feature, "Layer"),
    );
    if (/ham_tuong|tuong/.test(item)) return ["ham_tuong"];
    if (/ham_nap|nap/.test(item)) return ["ham_nap"];
  }
  return link?.kind === "approach" ? ["ht"] : [];
}

function supportColor(
  feature: Feature,
  bridge: BridgeState,
  link: ProgressFeatureLink,
): ProgressFeatureColor | null {
  const supportId = link.id;
  const support = bridge.supports.find((item) => item.id === supportId);
  if (!support) return null;
  const pileIndex = link.pileIndex;
  if (pileIndex !== undefined) {
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

function spanColor(
  feature: Feature,
  bridge: BridgeState,
  link: ProgressFeatureLink,
): ProgressFeatureColor | null {
  const spanId = link.id;
  const span = bridge.spans.find((item) => item.id === spanId);
  if (!span) return null;
  const girderIndex = link.girderIndex;
  if (girderIndex !== undefined) return girderStageColor(span.girders[girderIndex]?.st ?? 0);
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
  const link = progressFeatureLink(feature);
  if (!link) return null;
  if ("bridgeId" in link) {
    const bridge = state.bridges.find((item) => item.id === link.bridgeId);
    if (!bridge) return null;
    if (link.kind === "support") return supportColor(feature, bridge, link);
    if (link.kind === "span") return spanColor(feature, bridge, link);
    return progressStateColor(bridgeApproachPct(bridge));
  }
  if (link.kind === "km") {
    const km = state.road.km.find((item) => item.id === link.id);
    const key = roadKey(feature);
    return km && key ? progressStateColor(km.pct[key]) : null;
  }
  const underpass = state.underpasses.find((item) => item.id === link.id);
  if (underpass) {
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
  const link = progressFeatureLink(feature);
  if (!link) return null;
  return "bridgeId" in link
    ? { kind: link.kind, bridgeId: link.bridgeId, id: link.id }
    : { kind: link.kind, id: link.id };
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
  else next[PROGRESS_STATUS_PROPERTY] = status === "done" || status === "stage-5" ? "done" : "wip";
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
    const link = progressFeatureLink(feature);
    const bridgeId = link && "bridgeId" in link ? link.bridgeId : "";
    const bridge = bridgeId ? state.bridges.find((item) => item.id === bridgeId) : null;
    if (bridge && packageForStation(state.packages, bridge.station)?.id === packageId) {
      indexes.push(index);
      return;
    }
    const kmId = link?.kind === "km" ? link.id : "";
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
    const underpassId = link?.kind === "underpass" ? link.id : "";
    const underpass = underpassId
      ? state.underpasses.find((item) => item.id === underpassId)
      : null;
    if (underpass && packageForStation(state.packages, underpass.station)?.id === packageId)
      indexes.push(index);
  });
  return indexes;
}
