import { PROGRESS_DASHBOARD_INDEX_PROPERTY, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, Geometry, Position } from "geojson";

/**
 * The road and bridge network dashboard: an overview of every project line in
 * the workspace (expressways, national roads, bridges), coloured by status or
 * by type, with a compact legend in kilometres.
 *
 * It reads the line layers already in the project. Which layers take part, and
 * which attribute holds each project's name, status, type and year, is saved
 * on the layer (`metadata.networkDashboard`). The map styling is a transient
 * renderer view (`layer.progressDashboard`), so the layers' own styles and
 * features are never changed.
 */

/** The layer metadata key holding a layer's dashboard setup. */
export const NETWORK_METADATA_KEY = "networkDashboard";

/** What the map colours the lines by. */
export type NetworkColorMode = "status" | "type";

/** Which attribute holds each field, per layer. An empty string means none. */
export interface NetworkFields {
  name: string;
  status: string;
  type: string;
  year: string;
  /** Percent done (0–100). */
  progress: string;
  /** Percent planned by now (0–100). */
  plan: string;
}

/** The fields, in the order the setup dialog shows them. */
export const NETWORK_FIELDS: readonly (keyof NetworkFields)[] = [
  "name",
  "status",
  "type",
  "year",
  "progress",
  "plan",
];

/** A layer's dashboard setup. */
export interface NetworkLayerConfig extends NetworkFields {
  included: boolean;
}

/** One project line: a feature of an included layer. */
export interface NetworkSegment {
  layerId: string;
  index: number;
  name: string;
  /** Raw attribute values; "" when the layer has no such field or it is empty. */
  status: string;
  type: string;
  year: number | null;
  /** Percent done and percent planned (0–100), or null when unknown. */
  progress: number | null;
  plan: number | null;
  km: number;
}

/**
 * Line width by zoom: thick enough to see the whole network zoomed out to a
 * country, growing as the map zooms in so a single route stays readable.
 */
export const NETWORK_LINE_WIDTH: unknown[] = [
  "interpolate",
  ["exponential", 1.5],
  ["zoom"],
  4,
  3,
  8,
  4.5,
  12,
  7,
  15,
  11,
  18,
  24,
];

const EARTH_RADIUS_KM = 6371.0088;
const LINE_TYPES = new Set(["LineString", "MultiLineString"]);

/** Fold Vietnamese diacritics and case, so "Đang thi công" matches "dang thi cong". */
export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

function isLineFeature(feature: Feature | undefined): boolean {
  return Boolean(feature?.geometry && LINE_TYPES.has(feature.geometry.type));
}

/** Whether a layer can take part: in-store features with at least one line. */
export function isNetworkCandidate(layer: GeoLibreLayer): boolean {
  return layer.type === "geojson" && (layer.geojson?.features ?? []).some(isLineFeature);
}

function haversineKm(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function pathKm(path: Position[]): number {
  let km = 0;
  for (let i = 1; i < path.length; i += 1) km += haversineKm(path[i - 1], path[i]);
  return km;
}

/** Length of a line geometry in kilometres; 0 for anything that is not a line. */
export function lineKm(geometry: Geometry | null | undefined): number {
  if (geometry?.type === "LineString") return pathKm(geometry.coordinates);
  if (geometry?.type === "MultiLineString") {
    return geometry.coordinates.reduce((sum, path) => sum + pathKm(path), 0);
  }
  return 0;
}

const FIELD_PATTERNS: Record<keyof NetworkFields, RegExp> = {
  name: /^(ten|name|ten_?du_?an|du_?an|project|tuyen|ten_?tuyen|title)$|(^|_)(ten|name)(_|$)/,
  status: /(trang_?thai|tinh_?trang|status|state|giai_?doan)/,
  type: /(loai|type|cap_?duong|category|hang_?muc|kind)/,
  year: /(nam|year|khoi_?cong|start)/,
  progress:
    /(tien_?do|progress|thuc_?hien|hoan_?thanh_?(pct|phan_?tram)|percent_?complete|done_?pct)/,
  plan: /(ke_?hoach|plan|target|du_?kien)/,
};

/** Attribute names that look like a percent but are neither done nor plan. */
const NOT_A_PERCENT = /(chenh|lech|delta|diff|variance|sai_?so)/;

function propertyKeys(features: readonly Feature[]): string[] {
  const keys = new Set<string>();
  for (const feature of features.slice(0, 200)) {
    for (const key of Object.keys(feature.properties ?? {})) keys.add(key);
  }
  return [...keys];
}

/** The attribute names of a layer's features, for the field pickers. */
export function layerFieldNames(layer: GeoLibreLayer): string[] {
  return propertyKeys(layer.geojson?.features ?? []).sort((a, b) => a.localeCompare(b));
}

function looksLikeYear(features: readonly Feature[], key: string): boolean {
  return features.slice(0, 50).some((feature) => parseYear(feature.properties?.[key]) !== null);
}

function looksLikePercent(features: readonly Feature[], key: string): boolean {
  return features.slice(0, 50).some((feature) => parsePercent(feature.properties?.[key]) !== null);
}

/** Guess each field from the attribute names (Vietnamese or English). */
export function suggestFields(features: readonly Feature[]): NetworkFields {
  const keys = propertyKeys(features);
  const taken = new Set<string>();
  const pick = (field: keyof NetworkFields): string => {
    const found =
      keys.find((key) => {
        if (taken.has(key)) return false;
        const folded = foldText(key).replace(/\s+/g, "_");
        if (!FIELD_PATTERNS[field].test(folded)) return false;
        if (field === "year") return looksLikeYear(features, key);
        if (field === "progress" || field === "plan") {
          return !NOT_A_PERCENT.test(folded) && looksLikePercent(features, key);
        }
        return true;
      }) ?? "";
    if (found) taken.add(found);
    return found;
  };
  // The plan first, so "Ke_hoach_tien_do" is not taken as the progress.
  const plan = pick("plan");
  return {
    name: pick("name"),
    status: pick("status"),
    type: pick("type"),
    year: pick("year"),
    progress: pick("progress"),
    plan,
  };
}

/**
 * A layer's saved setup, or a suggested one (included) when none is saved. A
 * field the saved setup does not mention (one added to the dashboard after it
 * was saved) is suggested too; a field saved as "" stays unset.
 */
export function readLayerConfig(layer: GeoLibreLayer): NetworkLayerConfig {
  const saved = layer.metadata?.[NETWORK_METADATA_KEY];
  const record =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : null;
  let suggested: NetworkFields | null = null;
  const field = (key: keyof NetworkFields): string => {
    const value = record?.[key];
    if (typeof value === "string") return value;
    suggested ??= suggestFields(layer.geojson?.features ?? []);
    return suggested[key];
  };
  return {
    included: record?.included !== false,
    name: field("name"),
    status: field("status"),
    type: field("type"),
    year: field("year"),
    progress: field("progress"),
    plan: field("plan"),
  };
}

/** A percent from 45, "45", "45%" or "45,5 %", clamped to 0–100; null otherwise. */
export function parsePercent(value: unknown): number | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value.replace("%", "").replace(",", ".").trim())
        : Number.NaN;
  if (!Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

/** The layer patch that saves a setup. */
export function layerConfigPatch(
  layer: GeoLibreLayer,
  config: NetworkLayerConfig,
): Pick<GeoLibreLayer, "metadata"> {
  return { metadata: { ...layer.metadata, [NETWORK_METADATA_KEY]: { ...config } } };
}

/** A year from a number, "2024", or a date such as "2024-03-01" / "01/03/2024". */
export function parseYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2100) {
    return value;
  }
  if (typeof value !== "string") return null;
  const match = value.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
  return match ? Number(match[1]) : null;
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Line lengths by geometry object. The dashboard recomputes its lines whenever
 * a layer changes (its own transient view counts), and a large KMZ route can
 * hold tens of thousands of vertices; geometries are not mutated in place.
 */
const kmCache = new WeakMap<Geometry, number>();

function cachedLineKm(geometry: Geometry | null | undefined): number {
  if (!geometry) return 0;
  const cached = kmCache.get(geometry);
  if (cached !== undefined) return cached;
  const km = lineKm(geometry);
  kmCache.set(geometry, km);
  return km;
}

/** Every project line of the included layers. */
export function collectSegments(layers: readonly GeoLibreLayer[]): NetworkSegment[] {
  const segments: NetworkSegment[] = [];
  for (const layer of layers) {
    if (!isNetworkCandidate(layer)) continue;
    const config = readLayerConfig(layer);
    if (!config.included) continue;
    (layer.geojson?.features ?? []).forEach((feature, index) => {
      if (!isLineFeature(feature)) return;
      const properties = feature.properties ?? {};
      segments.push({
        layerId: layer.id,
        index,
        name: (config.name && textValue(properties[config.name]).trim()) || layer.name,
        status: config.status ? textValue(properties[config.status]) : "",
        type: config.type ? textValue(properties[config.type]) : "",
        year: config.year ? parseYear(properties[config.year]) : null,
        progress: config.progress ? parsePercent(properties[config.progress]) : null,
        plan: config.plan ? parsePercent(properties[config.plan]) : null,
        km: cachedLineKm(feature.geometry),
      });
    });
  }
  return segments;
}

/** Known statuses get fixed, meaningful colours (folded text → colour). */
const STATUS_COLORS: [RegExp, string][] = [
  [/(dang|under).*(thi cong|construction)|^thi cong|in progress|ongoing/, "#dc2626"],
  [/hoan thanh|completed|complete|done|da khai thac|khai thac|in service/, "#16a34a"],
  [/tam dung|tam ngung|paused|suspended|stopped|dung/, "#6b7280"],
  [/chuan bi|du kien|ke hoach|planned|planning|proposed|quy hoach/, "#f59e0b"],
];

/** Colours for everything else, in order of first appearance. */
const CATEGORY_PALETTE = [
  "#2563eb",
  "#dc2626",
  "#f59e0b",
  "#16a34a",
  "#9333ea",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
];

/** Lines with no value for the colour field. */
export const UNCLASSIFIED_COLOR = "#94a3b8";

/** One value of the colour field, with its colour and totals. */
export interface NetworkCategory {
  value: string;
  color: string;
  km: number;
  count: number;
}

/** A colour for each value of the colour field, stable for the given values. */
export function categoryColors(
  mode: NetworkColorMode,
  values: readonly string[],
): Map<string, string> {
  const colors = new Map<string, string>();
  let next = 0;
  for (const value of values) {
    if (colors.has(value)) continue;
    if (!value.trim()) {
      colors.set(value, UNCLASSIFIED_COLOR);
      continue;
    }
    const folded = foldText(value);
    const fixed =
      mode === "status" ? STATUS_COLORS.find(([pattern]) => pattern.test(folded))?.[1] : undefined;
    colors.set(value, fixed ?? CATEGORY_PALETTE[next++ % CATEGORY_PALETTE.length]);
  }
  return colors;
}

/**
 * Every distinct value of a field across the lines, most kilometres first.
 *
 * @param colors Colours to use, so a filtered list keeps the colours of the
 *   whole network; omitted, they are assigned in this list's order.
 */
export function fieldValues(
  segments: readonly NetworkSegment[],
  field: NetworkColorMode,
  colors?: ReadonlyMap<string, string>,
): NetworkCategory[] {
  const totals = new Map<string, { km: number; count: number }>();
  for (const segment of segments) {
    const entry = totals.get(segment[field]) ?? { km: 0, count: 0 };
    entry.km += segment.km;
    entry.count += 1;
    totals.set(segment[field], entry);
  }
  const ordered = [...totals.entries()].sort(
    (a, b) => b[1].km - a[1].km || a[0].localeCompare(b[0]),
  );
  const palette =
    colors ??
    categoryColors(
      field,
      ordered.map(([value]) => value),
    );
  return ordered.map(([value, { km, count }]) => ({
    value,
    color: palette.get(value) ?? UNCLASSIFIED_COLOR,
    km,
    count,
  }));
}

function fieldExpression(field: string): unknown {
  return ["to-string", ["coalesce", ["get", field], ""]];
}

/**
 * The transient renderer view for one included layer: its project lines,
 * a colour per value of the colour field, and the zoom-driven line width.
 *
 * The map filters on the included feature indexes (the renderer copy
 * carries each feature's index), so the map and the kilometre figures always
 * agree.
 *
 * @param shown The original indexes of this layer's included lines.
 */
export function layerView(
  config: NetworkLayerConfig,
  mode: NetworkColorMode,
  colors: ReadonlyMap<string, string>,
  shown: readonly number[],
): NonNullable<GeoLibreLayer["progressDashboard"]> {
  const filter =
    shown.length > 0
      ? ["match", ["get", PROGRESS_DASHBOARD_INDEX_PROPERTY], [...shown], true, false]
      : ["literal", false];

  const field = mode === "status" ? config.status : config.type;
  const pairs = field ? [...colors.entries()].filter(([value]) => value !== "").flat() : [];
  const fallback = colors.get("") ?? UNCLASSIFIED_COLOR;
  const colorExpression =
    pairs.length > 0
      ? ["match", fieldExpression(field), ...pairs, fallback]
      : ["to-color", fallback];

  return {
    filter,
    colorExpression: JSON.stringify(colorExpression),
    lineWidth: NETWORK_LINE_WIDTH,
  };
}

/** The indexes of each layer's included lines, by layer id. */
export function shownIndexes(segments: readonly NetworkSegment[]): Map<string, number[]> {
  const shown = new Map<string, number[]>();
  for (const segment of segments) {
    const list = shown.get(segment.layerId) ?? [];
    list.push(segment.index);
    shown.set(segment.layerId, list);
  }
  return shown;
}

/** The bounding box [west, south, east, north] of the given lines, or null. */
export function segmentsBounds(
  layers: readonly GeoLibreLayer[],
  segments: readonly NetworkSegment[],
): [number, number, number, number] | null {
  const byId = new Map(layers.map((layer) => [layer.id, layer]));
  let bounds: [number, number, number, number] | null = null;
  const extend = (position: Position) => {
    const [x, y] = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bounds = bounds
      ? [
          Math.min(bounds[0], x),
          Math.min(bounds[1], y),
          Math.max(bounds[2], x),
          Math.max(bounds[3], y),
        ]
      : [x, y, x, y];
  };
  for (const segment of segments) {
    const geometry = byId.get(segment.layerId)?.geojson?.features[segment.index]?.geometry;
    if (geometry?.type === "LineString") geometry.coordinates.forEach(extend);
    if (geometry?.type === "MultiLineString") geometry.coordinates.flat().forEach(extend);
  }
  return bounds;
}
