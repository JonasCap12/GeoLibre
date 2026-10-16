import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature, Geometry, Position } from "geojson";

/**
 * Construction progress read off a technical drawing.
 *
 * Pure: no DOM and no store. The drawing layer carries the whole setup in
 * `metadata.constructionProgress`, so it saves with the project, the cloud
 * workspace and collaboration snapshots the way `metadata.hazardZone` does,
 * with no project-format change.
 *
 * Each feature's state is a property (`tiendo`: "done" or "wip", absent for
 * not started), painted on with the feature-color path so the drawing shows
 * it. A work item gathers the features of some CAD layers (the DXF `Layer`
 * property) and measures them by count, length or area; its percent is the
 * finished share plus half the in-progress share, unless a hand-entered
 * override replaces it. The overall percent is the weighted mean of items.
 */

/** `metadata` key holding the progress setup on the drawing layer. */
export const PROGRESS_METADATA_KEY = "constructionProgress";

/** Feature property holding a feature's construction state. */
export const PROGRESS_STATUS_PROPERTY = "tiendo";

/** Feature property naming the CAD layer, as the DXF loader and GDAL write it. */
export const CAD_LAYER_PROPERTY = "Layer";

export type ProgressStatus = "done" | "wip";
export type ProgressMeasure = "count" | "length" | "area";

/** Paint colors for each state; not-started features keep the layer style. */
export const PROGRESS_STATUS_COLORS: Record<ProgressStatus, string> = {
  done: "#1f7a47",
  wip: "#d9a520",
};

/** Share of an in-progress feature that counts towards its item. */
export const WIP_CREDIT = 0.5;

export interface ProgressItem {
  /** Stable id, kept across renames. */
  key: string;
  name: string;
  /** Relative weight; items are normalised by the sum of weights. */
  weight: number;
  /** CAD `Layer` values whose features belong to this item. */
  cadLayers: string[];
  measure: ProgressMeasure;
  /** Planned percent for the current report. */
  plannedPct: number;
  /** A hand-entered percent that replaces the drawing's, or null. */
  overridePct: number | null;
}

export interface WeekRecord {
  /** ISO week, for example "2026-W42". One record per week. */
  week: string;
  /** Report date, `YYYY-MM-DD`. */
  date: string;
  actualPct: number;
  plannedPct: number;
}

export interface ConstructionProgress {
  version: 1;
  title: string;
  subtitle: string;
  items: ProgressItem[];
  weekly: WeekRecord[];
  /** Issues to watch, one per line. */
  notes: string;
}

export interface ItemProgress {
  item: ProgressItem;
  /** The percent used: the override when set, else the drawing's. */
  pct: number;
  /** The drawing's percent, or null when the item matches no features. */
  drawingPct: number | null;
  /** Measured totals in the item's unit (features, metres or square metres). */
  total: number;
  done: number;
  wip: number;
  featureCount: number;
}

/** How a summary is scoped. */
export interface ProgressScopeOptions {
  /**
   * Summarise one part of the project (a structure, a component): ignore the
   * project-wide manual percents and weight only the items the part holds.
   */
  scope?: boolean;
}

export interface ProgressSummary {
  items: ItemProgress[];
  overallPct: number;
  plannedPct: number;
  /** `overallPct - plannedPct`; negative is behind plan. */
  deviation: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

function clampPct(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeItem(raw: unknown, index: number): ProgressItem | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = text(r.name).trim();
  if (!name) return null;
  const weight = typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : 1;
  const measure: ProgressMeasure =
    r.measure === "length" || r.measure === "area" ? r.measure : "count";
  return {
    key: text(r.key) || `item-${index + 1}`,
    name,
    weight: Math.max(0, weight),
    cadLayers: Array.isArray(r.cadLayers)
      ? r.cadLayers.filter((v): v is string => typeof v === "string")
      : [],
    measure,
    plannedPct: clampPct(r.plannedPct),
    overridePct:
      r.overridePct === null || r.overridePct === undefined || r.overridePct === ""
        ? null
        : clampPct(r.overridePct),
  };
}

function normalizeWeek(raw: unknown): WeekRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const week = text(r.week);
  const date = text(r.date);
  if (!week || !date) return null;
  return { week, date, actualPct: clampPct(r.actualPct), plannedPct: clampPct(r.plannedPct) };
}

/**
 * Validate a stored progress setup. Unknown fields are dropped and bad values
 * fall back, so a hand-edited or older project still opens.
 *
 * @returns The setup, or null when `raw` is not one.
 */
export function normalizeProgressConfig(raw: unknown): ConstructionProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const items = Array.isArray(r.items)
    ? r.items.map(normalizeItem).filter((item): item is ProgressItem => item !== null)
    : [];
  // Keys must be unique: React keys and item lookups rely on it.
  const seen = new Set<string>();
  for (const item of items) {
    let key = item.key;
    for (let n = 2; seen.has(key); n += 1) key = `${item.key}-${n}`;
    item.key = key;
    seen.add(key);
  }
  const weekly = Array.isArray(r.weekly)
    ? r.weekly.map(normalizeWeek).filter((w): w is WeekRecord => w !== null)
    : [];
  weekly.sort((a, b) => a.date.localeCompare(b.date));
  return {
    version: 1,
    title: text(r.title),
    subtitle: text(r.subtitle),
    items,
    weekly,
    notes: text(r.notes),
  };
}

/** The progress setup stored on a layer, or null when it has none. */
export function readProgressConfig(layer: GeoLibreLayer): ConstructionProgress | null {
  return normalizeProgressConfig(layer.metadata?.[PROGRESS_METADATA_KEY]);
}

/** The first layer in the project carrying a progress setup. */
export function findProgressLayer(layers: readonly GeoLibreLayer[]): GeoLibreLayer | null {
  return layers.find((layer) => readProgressConfig(layer) !== null) ?? null;
}

/** The layer patch that stores `config` on `layer` (or with null, removes it). */
export function progressConfigPatch(
  layer: GeoLibreLayer,
  config: ConstructionProgress | null,
): Partial<GeoLibreLayer> {
  const metadata: Record<string, unknown> = { ...layer.metadata };
  if (config === null) delete metadata[PROGRESS_METADATA_KEY];
  else metadata[PROGRESS_METADATA_KEY] = config;
  return { metadata };
}

/** A feature's construction state, or null when it is not started. */
export function featureStatus(feature: Feature): ProgressStatus | null {
  const value = feature.properties?.[PROGRESS_STATUS_PROPERTY];
  return value === "done" || value === "wip" ? value : null;
}

function cadLayerOf(feature: Feature): string {
  const value = feature.properties?.[CAD_LAYER_PROPERTY];
  return typeof value === "string" ? value : "";
}

function segmentLength(a: Position, b: Position): number {
  // Haversine: accurate to well under a metre over a construction site.
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function lineLength(coords: Position[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) total += segmentLength(coords[i - 1], coords[i]);
  return total;
}

function ringArea(coords: Position[]): number {
  // Spherical polygon area (Chamberlain & Duquette), the formula Turf uses.
  if (coords.length < 3) return 0;
  let total = 0;
  for (let i = 0; i < coords.length; i += 1) {
    const p1 = coords[i];
    const p2 = coords[(i + 1) % coords.length];
    const p3 = coords[(i + 2) % coords.length];
    total += (p3[0] * RAD - p1[0] * RAD) * Math.sin(p2[1] * RAD);
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

function polygonArea(rings: Position[][]): number {
  if (rings.length === 0) return 0;
  const [outer, ...holes] = rings;
  return Math.max(0, ringArea(outer) - holes.reduce((sum, hole) => sum + ringArea(hole), 0));
}

/**
 * Measure one geometry. Length counts lines and polygon outlines (a pile drawn
 * as a circle has a perimeter), area counts polygons only, count is 1 for any
 * geometry.
 */
export function geometryMeasure(geometry: Geometry | null, measure: ProgressMeasure): number {
  if (!geometry) return 0;
  if (measure === "count") return 1;
  switch (geometry.type) {
    case "LineString":
      return measure === "length" ? lineLength(geometry.coordinates) : 0;
    case "MultiLineString":
      return measure === "length"
        ? geometry.coordinates.reduce((sum, line) => sum + lineLength(line), 0)
        : 0;
    case "Polygon":
      return measure === "area"
        ? polygonArea(geometry.coordinates)
        : lineLength(geometry.coordinates[0] ?? []);
    case "MultiPolygon":
      return geometry.coordinates.reduce(
        (sum, rings) =>
          sum + (measure === "area" ? polygonArea(rings) : lineLength(rings[0] ?? [])),
        0,
      );
    case "GeometryCollection":
      return geometry.geometries.reduce((sum, part) => sum + geometryMeasure(part, measure), 0);
    default:
      return 0;
  }
}

/**
 * Compute every item's percent and the overall percent for the drawing.
 *
 * An item with no matching features and no override reads 0 %. Items of zero
 * weight are listed but do not move the overall figure.
 */
export function computeProgress(
  features: readonly Feature[],
  config: ConstructionProgress,
  options: ProgressScopeOptions = {},
): ProgressSummary {
  const items = config.items.map((item): ItemProgress => {
    const wanted = new Set(item.cadLayers);
    let total = 0;
    let done = 0;
    let wip = 0;
    let featureCount = 0;
    for (const feature of features) {
      if (!wanted.has(cadLayerOf(feature))) continue;
      const size = geometryMeasure(feature.geometry, item.measure);
      featureCount += 1;
      total += size;
      const status = featureStatus(feature);
      if (status === "done") done += size;
      else if (status === "wip") wip += size;
    }
    const drawingPct = total > 0 ? ((done + WIP_CREDIT * wip) / total) * 100 : null;
    // A hand-entered percent is a project-wide figure; one structure's share
    // of the item is still read off its own features.
    const pct = (options.scope ? null : item.overridePct) ?? drawingPct ?? 0;
    return { item, pct, drawingPct, total, done, wip, featureCount };
  });
  // In a scope, only the items it holds count: a bridge has no pavement, and
  // weighting that in at 0 % would understate it.
  const counted = options.scope ? items.filter((entry) => entry.featureCount > 0) : items;
  const weightSum = counted.reduce((sum, entry) => sum + entry.item.weight, 0);
  const weighted = (pick: (entry: ItemProgress) => number) =>
    weightSum > 0
      ? counted.reduce((sum, entry) => sum + entry.item.weight * pick(entry), 0) / weightSum
      : 0;
  const overallPct = weighted((entry) => entry.pct);
  const plannedPct = weighted((entry) => entry.item.plannedPct);
  return { items, overallPct, plannedPct, deviation: overallPct - plannedPct };
}

/** Distinct CAD layer names on the features, most features first. */
export function cadLayerNames(features: readonly Feature[]): string[] {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const name = cadLayerOf(feature);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

function dominantMeasure(features: readonly Feature[], cadLayer: string): ProgressMeasure {
  let polygons = 0;
  let lines = 0;
  let points = 0;
  for (const feature of features) {
    if (cadLayerOf(feature) !== cadLayer) continue;
    const type = feature.geometry?.type ?? "";
    if (type.endsWith("Polygon")) polygons += 1;
    else if (type.endsWith("LineString")) lines += 1;
    else points += 1;
  }
  return lines > polygons && lines >= points ? "length" : "count";
}

/**
 * A first setup for a drawing: one item per CAD layer, measured by length when
 * it is mostly lines and by count otherwise (closed shapes such as piles and
 * girders are counted, not summed by area). The owner renames, merges and
 * weights them in the settings dialog.
 */
export function suggestProgressConfig(
  features: readonly Feature[],
  title: string,
): ConstructionProgress {
  const items = cadLayerNames(features).map(
    (name, index): ProgressItem => ({
      key: `item-${index + 1}`,
      name,
      weight: 1,
      cadLayers: [name],
      measure: dominantMeasure(features, name),
      plannedPct: 0,
      overridePct: null,
    }),
  );
  return { version: 1, title, subtitle: "", items, weekly: [], notes: "" };
}

/** ISO 8601 week of a `YYYY-MM-DD` date, such as "2026-W42". */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  // Thursday of the same ISO week decides the year.
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Record this week's figures. A second record in the same ISO week replaces
 * the first, so closing a week twice keeps one point on the chart.
 */
export function recordWeek(
  config: ConstructionProgress,
  date: string,
  summary: Pick<ProgressSummary, "overallPct" | "plannedPct">,
): ConstructionProgress {
  const week = isoWeek(date);
  const record: WeekRecord = {
    week,
    date,
    actualPct: Math.round(summary.overallPct * 10) / 10,
    plannedPct: Math.round(summary.plannedPct * 10) / 10,
  };
  const weekly = [...config.weekly.filter((w) => w.week !== week), record].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  return { ...config, weekly };
}

/** Non-empty note lines, which the screen lists as issues. */
export function progressIssues(config: ConstructionProgress): string[] {
  return config.notes
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean);
}

/**
 * How many rows fit in a block of `height` pixels when each row needs at least
 * `minRow` pixels. The screen never scrolls: rows beyond this collapse into a
 * "+N" line, which itself takes one row.
 */
export function rowsThatFit(count: number, height: number, minRow: number): number {
  if (count <= 0 || height <= 0 || minRow <= 0) return 0;
  const capacity = Math.max(1, Math.floor(height / minRow));
  return count <= capacity ? count : Math.max(0, capacity - 1);
}

/**
 * The color and properties a feature-color paint writes to mark a state, or
 * with null, to clear both the mark and its color.
 */
export function progressStatusPaint(status: ProgressStatus | null): {
  color: string | null;
  extra: Record<string, string | null>;
} {
  return status === null
    ? { color: null, extra: { [PROGRESS_STATUS_PROPERTY]: null } }
    : { color: PROGRESS_STATUS_COLORS[status], extra: { [PROGRESS_STATUS_PROPERTY]: status } };
}

/** Indexes, in layer order, of the features a work item gathers. */
export function itemFeatureIndexes(features: readonly Feature[], item: ProgressItem): number[] {
  const wanted = new Set(item.cadLayers);
  const indexes: number[] = [];
  features.forEach((feature, index) => {
    if (wanted.has(cadLayerOf(feature))) indexes.push(index);
  });
  return indexes;
}

function visitPositions(geometry: Geometry | null, visit: (position: Position) => void): void {
  if (!geometry) return;
  switch (geometry.type) {
    case "Point":
      visit(geometry.coordinates);
      return;
    case "MultiPoint":
    case "LineString":
      geometry.coordinates.forEach(visit);
      return;
    case "MultiLineString":
    case "Polygon":
      geometry.coordinates.forEach((part) => part.forEach(visit));
      return;
    case "MultiPolygon":
      geometry.coordinates.forEach((rings) => rings.forEach((ring) => ring.forEach(visit)));
      return;
    case "GeometryCollection":
      geometry.geometries.forEach((part) => visitPositions(part, visit));
  }
}

/** `[west, south, east, north]` around the features, or null when they have no coordinates. */
export function featuresBounds(
  features: readonly Feature[],
): [number, number, number, number] | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const feature of features) {
    visitPositions(feature.geometry, ([x, y]) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
    });
  }
  return Number.isFinite(west) ? [west, south, east, north] : null;
}

/**
 * Which features a sweep must not split: those of items measured by count.
 * Half a pile is not half a pile done, so a counted feature is marked only
 * when the sweep holds all of it; lines and areas are split at its edge.
 */
export function countedFeatureTest(config: ConstructionProgress): (feature: Feature) => boolean {
  const counted = new Set(
    config.items.filter((item) => item.measure === "count").flatMap((item) => item.cadLayers),
  );
  return (feature) => counted.has(cadLayerOf(feature));
}

// ---------------------------------------------------------------- structures

/** Feature property naming the structure a feature belongs to (a bridge, a road section). */
export const STRUCTURE_PROPERTY = "cong_trinh";
/** Feature property naming the component within its structure (M1, T1, N1, a 100 m segment). */
export const COMPONENT_PROPERTY = "cau_kien";
/** Optional numeric feature property ordering structures and components along the route. */
export const ORDER_PROPERTY = "thu_tu";

function textProperty(feature: Feature, key: string): string {
  const value = feature.properties?.[key];
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function orderOf(feature: Feature, fallback: number): number {
  const raw = feature.properties?.[ORDER_PROPERTY];
  const value = typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
}

export interface StructureProgress {
  name: string;
  /** Indexes, in layer order, of the structure's features. */
  featureIndexes: number[];
  summary: ProgressSummary;
}

/**
 * The project's structures, in route order, each with its own progress. A
 * drawing without the structure property has none, and the screen then shows
 * the project as a whole only.
 */
export function progressStructures(
  features: readonly Feature[],
  config: ConstructionProgress,
): StructureProgress[] {
  const groups = new Map<string, { order: number; indexes: number[] }>();
  features.forEach((feature, index) => {
    const name = textProperty(feature, STRUCTURE_PROPERTY);
    if (!name) return;
    const group = groups.get(name) ?? { order: Infinity, indexes: [] };
    group.order = Math.min(group.order, orderOf(feature, index));
    group.indexes.push(index);
    groups.set(name, group);
  });
  return [...groups.entries()]
    .sort((a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0]))
    .map(([name, group]) => ({
      name,
      featureIndexes: group.indexes,
      summary: computeProgress(
        group.indexes.map((index) => features[index]),
        config,
        { scope: true },
      ),
    }));
}

export type CellState = "done" | "wip" | "partial" | "none";

export interface MatrixCell {
  component: string;
  itemKey: string;
  /** Measured totals in the item's unit. */
  total: number;
  done: number;
  wip: number;
  /** Feature counts by state, for the cell's label. */
  counts: { done: number; wip: number; none: number };
  pct: number;
  state: CellState;
  featureIndexes: number[];
}

export interface ComponentMatrix {
  components: { name: string; featureIndexes: number[] }[];
  /** The items the structure holds, in setup order. */
  items: ProgressItem[];
  cells: Map<string, MatrixCell>;
}

/** Key of a cell in {@link ComponentMatrix.cells}. */
export const cellKey = (component: string, itemKey: string) => `${component}\u0000${itemKey}`;

/** The state a cell shows: all done, all in progress or not started, or a mix. */
export function cellState(counts: { done: number; wip: number; none: number }): CellState {
  const total = counts.done + counts.wip + counts.none;
  if (total === 0 || counts.none === total) return "none";
  if (counts.done === total) return "done";
  if (counts.wip === total) return "wip";
  return "partial";
}

/**
 * One structure as a grid of its components (columns, in route order) by the
 * items they hold (rows): the survey sheet's "support × stage" table. A cell
 * gathers the features of one component that belong to one item.
 */
export function componentMatrix(
  features: readonly Feature[],
  config: ConstructionProgress,
  structure: string,
): ComponentMatrix {
  const components = new Map<string, { order: number; indexes: number[] }>();
  features.forEach((feature, index) => {
    if (textProperty(feature, STRUCTURE_PROPERTY) !== structure) return;
    const name = textProperty(feature, COMPONENT_PROPERTY) || "—";
    const entry = components.get(name) ?? { order: Infinity, indexes: [] };
    // Without an order, components fall back to their names (M1, T2, T10).
    entry.order = Math.min(entry.order, orderOf(feature, Infinity));
    entry.indexes.push(index);
    components.set(name, entry);
  });
  const cells = new Map<string, MatrixCell>();
  const present = new Set<string>();
  for (const [component, entry] of components) {
    for (const item of config.items) {
      const wanted = new Set(item.cadLayers);
      const cell: MatrixCell = {
        component,
        itemKey: item.key,
        total: 0,
        done: 0,
        wip: 0,
        counts: { done: 0, wip: 0, none: 0 },
        pct: 0,
        state: "none",
        featureIndexes: [],
      };
      for (const index of entry.indexes) {
        const feature = features[index];
        if (!wanted.has(cadLayerOf(feature))) continue;
        const size = geometryMeasure(feature.geometry, item.measure);
        const status = featureStatus(feature);
        cell.total += size;
        cell.featureIndexes.push(index);
        if (status === "done") {
          cell.done += size;
          cell.counts.done += 1;
        } else if (status === "wip") {
          cell.wip += size;
          cell.counts.wip += 1;
        } else cell.counts.none += 1;
      }
      if (cell.featureIndexes.length === 0) continue;
      present.add(item.key);
      cell.pct = cell.total > 0 ? ((cell.done + WIP_CREDIT * cell.wip) / cell.total) * 100 : 0;
      cell.state = cellState(cell.counts);
      cells.set(cellKey(component, item.key), cell);
    }
  }
  return {
    components: [...components.entries()]
      .sort(
        (a, b) => a[1].order - b[1].order || a[0].localeCompare(b[0], undefined, { numeric: true }),
      )
      .map(([name, entry]) => ({ name, featureIndexes: entry.indexes })),
    items: config.items.filter((item) => present.has(item.key)),
    cells,
  };
}
