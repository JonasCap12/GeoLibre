import type { TFunction } from "i18next";
import type { Feature } from "geojson";
import { progressFeatureLink, propertyText as featureText } from "./progress-feature-link";

export const BRIDGE_ITEM_KEYS = ["coc", "be", "than", "xm", "duc", "gac", "bmc", "ht"] as const;
export const ROAD_ITEM_KEYS = ["nen", "mat_trai", "mat_phai", "le", "dpc", "ranh"] as const;
export const UNDERPASS_ITEM_KEYS = ["ham_tuong", "ham_nap"] as const;
export const PROGRESS_V2_ITEM_KEYS = [
  ...BRIDGE_ITEM_KEYS,
  ...ROAD_ITEM_KEYS,
  ...UNDERPASS_ITEM_KEYS,
] as const;

export type BridgeItemKey = (typeof BRIDGE_ITEM_KEYS)[number];
export type RoadItemKey = (typeof ROAD_ITEM_KEYS)[number];
export type UnderpassItemKey = (typeof UNDERPASS_ITEM_KEYS)[number];
export type ProgressV2ItemKey = (typeof PROGRESS_V2_ITEM_KEYS)[number];
export type PileState = 0 | 1 | 2;
export type GirderStage = 0 | 1 | 2 | 3 | 4 | 5;

export interface ProgressV2Meta {
  title: string;
  subtitle: string;
  duan?: string;
  cdt?: string;
  tvtk?: string;
  dv?: string;
  reportDate: string;
}

export interface ProgressPackage {
  id: string;
  name: string;
  fromStation: number;
  toStation: number;
}

export interface ProgressSupport {
  id: string;
  kind: "mo" | "tru";
  inc: boolean;
  coc: { t: number; D: number; L: number };
  piles: PileState[];
  be: number;
  than: number;
  xm: number;
  note?: string;
  mat?: number | null;
  cdday?: number | null;
  than_h?: number | null;
  xmt?: number | null;
  loai?: string | number;
  xmloai?: string | number;
}

export interface ProgressGirder {
  t: string;
  st: GirderStage;
  dob: string;
  bed: number;
}

export interface ProgressSpan {
  id: string;
  L: number;
  lien: string;
  bmc: number;
  ht: number;
  girders: ProgressGirder[];
}

export interface BridgeState {
  id: string;
  name: string;
  station: number;
  quyen?: string;
  yard: { beds: number };
  supports: ProgressSupport[];
  spans: ProgressSpan[];
}

export interface RoadKmState {
  id: string;
  from: number;
  to: number;
  pct: Record<RoadItemKey, number>;
}

export interface UnderpassState {
  id: string;
  station: number;
  pct: { tuong: number; nap: number };
}

export interface ProgressV2History {
  date: string;
  week: string;
  packageId: string | null;
  actual: number;
  planned: number;
}

export interface ProgressV2 {
  version: 2;
  meta: ProgressV2Meta;
  packages: ProgressPackage[];
  weights: Record<ProgressV2ItemKey, number>;
  plan: Record<string, Partial<Record<ProgressV2ItemKey, number>>>;
  bridges: BridgeState[];
  road: { km: RoadKmState[] };
  underpasses: UnderpassState[];
  history: ProgressV2History[];
  notes: string;
}

export interface ProgressV2ItemResult {
  key: ProgressV2ItemKey;
  pct: number;
  plannedPct: number;
  denominator: number;
  applicable: boolean;
}

export interface ProgressV2Summary {
  items: ProgressV2ItemResult[];
  overallPct: number;
  plannedPct: number;
  deviation: number;
  weight: number;
}

export type ProgressEvaluation = "ahead" | "late" | "ok" | "na";

export interface ProgressAlert {
  severity: 1 | 2 | 3;
  code:
    | "no-plan"
    | "item-late"
    | "girder-before-cap"
    | "deck-before-girders"
    | "cap-before-piles"
    | "pier-before-cap"
    | "capbeam-before-pier"
    | "bed-clash"
    | "girder-without-bed"
    | "yard-overstock"
    | "next-span-girders-short"
    | "next-span-waits-cap";
  itemKey?: ProgressV2ItemKey;
  bridgeId?: string;
  supportId?: string;
  spanId?: string;
  bed?: number;
  actual?: number;
  planned?: number;
  count?: number;
  total?: number;
  ids?: string[];
}

export interface YardGirderRef {
  bridgeId: string;
  spanId: string;
  spanIndex: number;
  girderIndex: number;
  id: string;
  girder: ProgressGirder;
  ageDays: number | null;
}

export interface YardSummary {
  total: number;
  cast: number;
  onBed: number;
  ready: number;
  erected: number;
  beds: Array<{ bed: number; girders: YardGirderRef[]; clash: boolean }>;
  unassigned: YardGirderRef[];
  nextSpan: { id: string; ready: number; need: number } | null;
  byType: Array<{
    type: string;
    total: number;
    cast: number;
    onBed: number;
    ready: number;
    erected: number;
    remaining: number;
  }>;
  girders: YardGirderRef[];
}

const BRIDGE_KEYS = new Set<ProgressV2ItemKey>(BRIDGE_ITEM_KEYS);
const ROAD_KEYS = new Set<ProgressV2ItemKey>(ROAD_ITEM_KEYS);
const UNDERPASS_KEYS = new Set<ProgressV2ItemKey>(UNDERPASS_ITEM_KEYS);

function finite(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clampProgressPct(value: unknown): number {
  return Math.min(100, Math.max(0, finite(value)));
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizePile(value: unknown): PileState {
  return value === 1 || value === 2 ? value : 0;
}

function normalizeStage(value: unknown): GirderStage {
  const stage = Math.round(finite(value));
  return Math.min(5, Math.max(0, stage)) as GirderStage;
}

function normalizeSupport(raw: unknown, index: number): ProgressSupport {
  const value = objectValue(raw);
  const coc = objectValue(value.coc);
  const total = Math.max(0, Math.round(finite(coc.t)));
  const rawPiles = Array.isArray(value.piles) ? value.piles.map(normalizePile) : [];
  const piles = Array.from({ length: total }, (_, pile) => rawPiles[pile] ?? 0);
  return {
    id: stringValue(value.id, `T${index + 1}`),
    kind: value.kind === "mo" || value.type === "mo" ? "mo" : "tru",
    inc: value.inc !== false,
    coc: { t: total, D: Math.max(0, finite(coc.D)), L: Math.max(0, finite(coc.L)) },
    piles,
    be: clampProgressPct(value.be),
    than: clampProgressPct(value.than),
    xm: clampProgressPct(value.xm),
    ...(typeof value.note === "string" ? { note: value.note } : {}),
    ...(value.mat !== undefined ? { mat: finite(value.mat) } : {}),
    ...(value.cdday !== undefined ? { cdday: finite(value.cdday) } : {}),
    ...(value.than_h !== undefined ? { than_h: finite(value.than_h) } : {}),
    ...(value.xmt !== undefined ? { xmt: finite(value.xmt) } : {}),
    ...(typeof value.loai === "string" || typeof value.loai === "number"
      ? { loai: value.loai }
      : {}),
    ...(typeof value.xmloai === "string" || typeof value.xmloai === "number"
      ? { xmloai: value.xmloai }
      : {}),
  };
}

function normalizeGirder(raw: unknown): ProgressGirder {
  const value = objectValue(raw);
  const stage = normalizeStage(value.st);
  return {
    t: stringValue(value.t),
    st: stage,
    dob: stage < 2 ? "" : stringValue(value.dob),
    bed: stage === 0 || stage >= 4 ? 0 : Math.max(0, Math.round(finite(value.bed))),
  };
}

function normalizeSpan(raw: unknown, index: number): ProgressSpan {
  const value = objectValue(raw);
  return {
    id: stringValue(value.id, `N${index + 1}`),
    L: Math.max(0, finite(value.L)),
    lien: stringValue(value.lien),
    bmc: clampProgressPct(value.bmc),
    ht: clampProgressPct(value.ht),
    girders: Array.isArray(value.girders) ? value.girders.map(normalizeGirder) : [],
  };
}

function normalizeBridge(raw: unknown, index: number): BridgeState {
  const value = objectValue(raw);
  const yard = objectValue(value.yard);
  return {
    id: stringValue(value.id, `bridge-${index + 1}`),
    name: stringValue(value.name, stringValue(value.id, `Bridge ${index + 1}`)),
    station: value.station == null ? Number.NaN : finite(value.station, Number.NaN),
    ...(typeof value.quyen === "string" ? { quyen: value.quyen } : {}),
    yard: { beds: Math.max(0, Math.round(finite(yard.beds))) },
    supports: Array.isArray(value.supports)
      ? value.supports.map((support, supportIndex) => normalizeSupport(support, supportIndex))
      : [],
    spans: Array.isArray(value.spans)
      ? value.spans.map((span, spanIndex) => normalizeSpan(span, spanIndex))
      : [],
  };
}

function emptyPct<T extends readonly string[]>(keys: T): Record<T[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T[number], number>;
}

export function normalizeProgressV2(raw: unknown): ProgressV2 | null {
  const value = objectValue(raw);
  if (value.version !== 2) return null;
  const meta = objectValue(value.meta);
  const rawWeights = objectValue(value.weights);
  const weights = emptyPct(PROGRESS_V2_ITEM_KEYS);
  for (const key of PROGRESS_V2_ITEM_KEYS) weights[key] = Math.max(0, finite(rawWeights[key]));
  const packages = (Array.isArray(value.packages) ? value.packages : []).map(
    (rawPackage, index) => {
      const item = objectValue(rawPackage);
      const fromStation = finite(item.fromStation);
      const toStation = finite(item.toStation, fromStation);
      return {
        id: stringValue(item.id, `package-${index + 1}`),
        name: stringValue(item.name, `Package ${index + 1}`),
        fromStation: Math.min(fromStation, toStation),
        toStation: Math.max(fromStation, toStation),
      };
    },
  );
  const plan: ProgressV2["plan"] = {};
  const rawPlan = objectValue(value.plan);
  for (const packageItem of packages) {
    const source = objectValue(rawPlan[packageItem.id]);
    plan[packageItem.id] = Object.fromEntries(
      PROGRESS_V2_ITEM_KEYS.map((key) => [key, clampProgressPct(source[key])]),
    );
  }
  const road = objectValue(value.road);
  const km = (Array.isArray(road.km) ? road.km : []).map((rawKm, index): RoadKmState => {
    const item = objectValue(rawKm);
    const rawPct = objectValue(item.pct);
    const pct = emptyPct(ROAD_ITEM_KEYS);
    for (const key of ROAD_ITEM_KEYS) pct[key] = clampProgressPct(rawPct[key]);
    const from = finite(item.from);
    const to = finite(item.to, from);
    return {
      id: stringValue(item.id, `Km${index}`),
      from: Math.min(from, to),
      to: Math.max(from, to),
      pct,
    };
  });
  const underpasses = (Array.isArray(value.underpasses) ? value.underpasses : []).map(
    (rawUnderpass, index): UnderpassState => {
      const item = objectValue(rawUnderpass);
      const pct = objectValue(item.pct);
      return {
        id: stringValue(item.id, `underpass-${index + 1}`),
        station: item.station == null ? Number.NaN : finite(item.station, Number.NaN),
        pct: { tuong: clampProgressPct(pct.tuong), nap: clampProgressPct(pct.nap) },
      };
    },
  );
  const history = (Array.isArray(value.history) ? value.history : [])
    .map((rawHistory): ProgressV2History | null => {
      const item = objectValue(rawHistory);
      const date = stringValue(item.date);
      const week = stringValue(item.week);
      if (!date || !week) return null;
      return {
        date,
        week,
        packageId: typeof item.packageId === "string" ? item.packageId : null,
        actual: clampProgressPct(item.actual),
        planned: clampProgressPct(item.planned),
      };
    })
    .filter((item): item is ProgressV2History => item !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
  return {
    version: 2,
    meta: {
      title: stringValue(meta.title),
      subtitle: stringValue(meta.subtitle),
      ...(typeof meta.duan === "string" ? { duan: meta.duan } : {}),
      ...(typeof meta.cdt === "string" ? { cdt: meta.cdt } : {}),
      ...(typeof meta.tvtk === "string" ? { tvtk: meta.tvtk } : {}),
      ...(typeof meta.dv === "string" ? { dv: meta.dv } : {}),
      reportDate: stringValue(meta.reportDate),
    },
    packages,
    weights,
    plan,
    bridges: Array.isArray(value.bridges)
      ? value.bridges.map((bridge, index) => normalizeBridge(bridge, index))
      : [],
    road: { km },
    underpasses,
    history,
    notes: stringValue(value.notes),
  };
}

export function isProgressV2(raw: unknown): raw is ProgressV2 {
  return objectValue(raw).version === 2;
}

export function packageForStation(
  packages: readonly ProgressPackage[],
  station: number,
): ProgressPackage | null {
  return (
    packages.find(
      (item, index) =>
        station >= item.fromStation &&
        (station < item.toStation || (index === packages.length - 1 && station === item.toStation)),
    ) ?? null
  );
}

export function packageById(state: ProgressV2, packageId: string | null): ProgressPackage | null {
  return packageId === null ? null : (state.packages.find((item) => item.id === packageId) ?? null);
}

export function bridgesInPackage(state: ProgressV2, packageId: string | null): BridgeState[] {
  if (packageId === null) return state.bridges;
  return state.bridges.filter(
    (bridge) => packageForStation(state.packages, bridge.station)?.id === packageId,
  );
}

function donePiles(support: ProgressSupport): number {
  return support.piles.slice(0, support.coc.t).filter((state) => state === 2).length;
}

export function supportItemPct(support: ProgressSupport, key: "coc" | "be" | "than" | "xm") {
  return key === "coc"
    ? support.coc.t > 0
      ? (donePiles(support) / support.coc.t) * 100
      : 0
    : support[key];
}

export function spanItemPct(span: ProgressSpan, key: "duc" | "gac" | "bmc" | "ht") {
  if (key === "duc")
    return span.girders.length > 0
      ? (span.girders.filter((girder) => girder.st >= 2).length / span.girders.length) * 100
      : 0;
  if (key === "gac")
    return span.girders.length > 0
      ? (span.girders.filter((girder) => girder.st === 5).length / span.girders.length) * 100
      : 0;
  return span[key];
}

function bridgeNumeratorDenominator(
  bridges: readonly BridgeState[],
  key: BridgeItemKey,
): [number, number] {
  let numerator = 0;
  let denominator = 0;
  for (const bridge of bridges) {
    if (key === "coc") {
      for (const support of bridge.supports.filter((item) => item.inc)) {
        numerator += donePiles(support) * 100;
        denominator += support.coc.t;
      }
    } else if (key === "be" || key === "than" || key === "xm") {
      for (const support of bridge.supports.filter((item) => item.inc)) {
        numerator += support[key];
        denominator += 1;
      }
    } else if (key === "duc" || key === "gac") {
      for (const span of bridge.spans) {
        numerator +=
          span.girders.filter((girder) => (key === "duc" ? girder.st >= 2 : girder.st === 5))
            .length * 100;
        denominator += span.girders.length;
      }
    } else {
      for (const span of bridge.spans) {
        numerator += span[key] * span.L;
        denominator += span.L;
      }
    }
  }
  return [numerator, denominator];
}

function overlapLength(from: number, to: number, scope: ProgressPackage | null): number {
  if (!scope) return Math.max(0, to - from);
  return Math.max(0, Math.min(to, scope.toStation) - Math.max(from, scope.fromStation));
}

function roadNumeratorDenominator(
  state: ProgressV2,
  key: RoadItemKey,
  scope: ProgressPackage | null,
): [number, number] {
  let numerator = 0;
  let denominator = 0;
  for (const km of state.road.km) {
    const length = overlapLength(km.from, km.to, scope);
    numerator += km.pct[key] * length;
    denominator += length;
  }
  return [numerator, denominator];
}

function underpassNumeratorDenominator(
  state: ProgressV2,
  key: UnderpassItemKey,
  packageId: string | null,
): [number, number] {
  let numerator = 0;
  let denominator = 0;
  for (const underpass of state.underpasses) {
    if (
      packageId !== null &&
      packageForStation(state.packages, underpass.station)?.id !== packageId
    )
      continue;
    numerator += key === "ham_tuong" ? underpass.pct.tuong : underpass.pct.nap;
    denominator += 1;
  }
  return [numerator, denominator];
}

function itemNumeratorDenominator(
  state: ProgressV2,
  key: ProgressV2ItemKey,
  packageId: string | null,
): [number, number] {
  if (BRIDGE_KEYS.has(key))
    return bridgeNumeratorDenominator(bridgesInPackage(state, packageId), key as BridgeItemKey);
  if (ROAD_KEYS.has(key))
    return roadNumeratorDenominator(state, key as RoadItemKey, packageById(state, packageId));
  return underpassNumeratorDenominator(state, key as UnderpassItemKey, packageId);
}

function plannedItemPct(
  state: ProgressV2,
  key: ProgressV2ItemKey,
  packageId: string | null,
): number {
  if (packageId !== null) return clampProgressPct(state.plan[packageId]?.[key]);
  let numerator = 0;
  let denominator = 0;
  for (const packageItem of state.packages) {
    const [, itemDenominator] = itemNumeratorDenominator(state, key, packageItem.id);
    if (itemDenominator <= 0) continue;
    numerator += clampProgressPct(state.plan[packageItem.id]?.[key]) * itemDenominator;
    denominator += itemDenominator;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

export function computeProgressV2(
  state: ProgressV2,
  packageId: string | null = null,
  filteredItems?: ProgressV2ItemResult[],
): ProgressV2Summary {
  const items =
    filteredItems ??
    PROGRESS_V2_ITEM_KEYS.map((key): ProgressV2ItemResult => {
      const [numerator, denominator] = itemNumeratorDenominator(state, key, packageId);
      return {
        key,
        pct: denominator > 0 ? numerator / denominator : 0,
        plannedPct: plannedItemPct(state, key, packageId),
        denominator,
        applicable: denominator > 0,
      };
    });
  const counted = items.filter((item) => item.applicable && state.weights[item.key] > 0);
  const weight = counted.reduce((sum, item) => sum + state.weights[item.key], 0);
  const weighted = (pick: (item: ProgressV2ItemResult) => number) =>
    weight > 0
      ? counted.reduce((sum, item) => sum + state.weights[item.key] * pick(item), 0) / weight
      : 0;
  const overallPct = weighted((item) => item.pct);
  const plannedPct = weighted((item) => item.plannedPct);
  return { items, overallPct, plannedPct, deviation: overallPct - plannedPct, weight };
}

export function supportOverallPct(
  support: ProgressSupport,
  weights: Pick<Record<ProgressV2ItemKey, number>, "coc" | "be" | "than" | "xm">,
): number {
  const keys = ["coc", "be", "than", "xm"] as const;
  let numerator = 0;
  let denominator = 0;
  for (const key of keys) {
    const weight = Math.max(0, finite(weights[key]));
    numerator += weight * supportItemPct(support, key);
    denominator += weight;
  }
  return denominator > 0 ? numerator / denominator : 0;
}

/** Localized quantities for the eight bridge items. */
export function bridgeItemQuantityText(
  bridges: readonly BridgeState[],
  key: BridgeItemKey,
  t: TFunction,
  locale?: string,
): string {
  const number = (value: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 0, useGrouping: false }).format(value);
  if (key === "coc") {
    let done = 0;
    let total = 0;
    let doneMetres = 0;
    let totalMetres = 0;
    for (const bridge of bridges) {
      for (const support of bridge.supports.filter((item) => item.inc)) {
        const count = donePiles(support);
        done += count;
        total += support.coc.t;
        doneMetres += count * support.coc.L;
        totalMetres += support.coc.t * support.coc.L;
      }
    }
    return t("progress.v2.quantity.piles", {
      done: number(done),
      total: number(total),
      doneMetres: number(doneMetres),
      totalMetres: number(totalMetres),
    });
  }
  if (key === "duc" || key === "gac") {
    let done = 0;
    let total = 0;
    for (const bridge of bridges) {
      for (const span of bridge.spans) {
        done += span.girders.filter((girder) =>
          key === "duc" ? girder.st >= 2 : girder.st === 5,
        ).length;
        total += span.girders.length;
      }
    }
    return t("progress.v2.quantity.girders", { done: number(done), total: number(total) });
  }
  if (key === "be" || key === "than" || key === "xm") {
    const supports = bridges.flatMap((bridge) => bridge.supports.filter((support) => support.inc));
    return t("progress.v2.quantity.supports", {
      done: number(supports.filter((support) => support[key] >= 100).length),
      total: number(supports.length),
    });
  }
  let done = 0;
  let total = 0;
  for (const bridge of bridges) {
    for (const span of bridge.spans) {
      done += (span[key] / 100) * span.L;
      total += span.L;
    }
  }
  return t("progress.v2.quantity.length", { done: number(done), total: number(total) });
}

export function evaluateProgress(
  actual: number,
  planned: number,
  hasPlan: boolean,
): ProgressEvaluation {
  if (!hasPlan) return "na";
  const deviation = Math.round((actual - planned) * 10) / 10;
  return deviation > 0.5 ? "ahead" : deviation < -0.5 ? "late" : "ok";
}

function structuralAlerts(bridge: BridgeState, reportDate: string): ProgressAlert[] {
  const alerts: ProgressAlert[] = [];
  bridge.spans.forEach((span, spanIndex) => {
    const erected = span.girders.filter((girder) => girder.st === 5).length;
    if (erected > 0) {
      for (const support of [bridge.supports[spanIndex], bridge.supports[spanIndex + 1]]) {
        if (support?.inc && support.xm < 100)
          alerts.push({
            severity: 3,
            code: "girder-before-cap",
            bridgeId: bridge.id,
            spanId: span.id,
            supportId: support.id,
            count: erected,
            actual: support.xm,
          });
      }
    }
    if (span.bmc > 0 && erected < span.girders.length)
      alerts.push({
        severity: 3,
        code: "deck-before-girders",
        bridgeId: bridge.id,
        spanId: span.id,
        count: erected,
        total: span.girders.length,
      });
  });
  for (const support of bridge.supports) {
    if (!support.inc) continue;
    const pilesDone = donePiles(support);
    if (support.be > 0 && pilesDone < support.coc.t)
      alerts.push({
        severity: 2,
        code: "cap-before-piles",
        bridgeId: bridge.id,
        supportId: support.id,
        count: support.coc.t - pilesDone,
      });
    if (support.than > 0 && support.be < 100)
      alerts.push({
        severity: 2,
        code: "pier-before-cap",
        bridgeId: bridge.id,
        supportId: support.id,
        actual: support.be,
      });
    if (support.xm > 0 && support.than < 100)
      alerts.push({
        severity: 2,
        code: "capbeam-before-pier",
        bridgeId: bridge.id,
        supportId: support.id,
        actual: support.than,
      });
  }
  const yard = computeYard(bridge, reportDate);
  for (const bed of yard.beds.filter((item) => item.clash))
    alerts.push({
      severity: 3,
      code: "bed-clash",
      bridgeId: bridge.id,
      bed: bed.bed,
      count: bed.girders.length,
      ids: bed.girders.map((girder) => girder.id),
    });
  if (yard.unassigned.length > 0)
    alerts.push({
      severity: 2,
      code: "girder-without-bed",
      bridgeId: bridge.id,
      count: yard.unassigned.length,
      ids: yard.unassigned.map((girder) => girder.id),
    });
  if (yard.ready > 20)
    alerts.push({
      severity: 2,
      code: "yard-overstock",
      bridgeId: bridge.id,
      count: yard.ready,
    });
  if (yard.nextSpan) {
    const spanIndex = bridge.spans.findIndex((span) => span.id === yard.nextSpan?.id);
    const span = bridge.spans[spanIndex];
    const ends = [bridge.supports[spanIndex], bridge.supports[spanIndex + 1]].filter(
      (support): support is ProgressSupport => Boolean(support?.inc),
    );
    const notDone = ends.filter((support) => support.xm < 100);
    if (notDone.length === 0 && yard.nextSpan.ready < yard.nextSpan.need)
      alerts.push({
        severity: 2,
        code: "next-span-girders-short",
        bridgeId: bridge.id,
        spanId: span.id,
        count: yard.nextSpan.ready,
        total: yard.nextSpan.need,
      });
    else if (
      notDone.length > 0 &&
      yard.nextSpan.ready >= yard.nextSpan.need &&
      yard.nextSpan.need > 0
    )
      alerts.push({
        severity: 1,
        code: "next-span-waits-cap",
        bridgeId: bridge.id,
        spanId: span.id,
        count: yard.nextSpan.ready,
        ids: notDone.map((support) => support.id),
      });
  }
  return alerts;
}

export function computeProgressAlerts(
  state: ProgressV2,
  packageId: string | null = null,
): ProgressAlert[] {
  const summary = computeProgressV2(state, packageId);
  const hasPlan = summary.items.some((item) => item.plannedPct > 0);
  const alerts: ProgressAlert[] = [];
  if (!hasPlan) alerts.push({ severity: 2, code: "no-plan" });
  for (const item of summary.items) {
    if (!item.applicable || item.plannedPct <= 0) continue;
    const deviation = item.pct - item.plannedPct;
    if (evaluateProgress(item.pct, item.plannedPct, true) === "late")
      alerts.push({
        severity: deviation <= -5 ? 3 : 2,
        code: "item-late",
        itemKey: item.key,
        actual: item.pct,
        planned: item.plannedPct,
      });
  }
  for (const bridge of bridgesInPackage(state, packageId))
    alerts.push(...structuralAlerts(bridge, state.meta.reportDate));
  return alerts.sort((left, right) => right.severity - left.severity);
}

function concreteAge(reportDate: string, dob: string): number | null {
  if (!reportDate || !dob) return null;
  const report = Date.parse(reportDate);
  const poured = Date.parse(dob);
  return Number.isFinite(report) && Number.isFinite(poured)
    ? Math.round((report - poured) / 86_400_000)
    : null;
}

export function computeYard(bridge: BridgeState, reportDate: string): YardSummary {
  const girders = bridge.spans.flatMap((span, spanIndex) =>
    span.girders.map(
      (girder, girderIndex): YardGirderRef => ({
        bridgeId: bridge.id,
        spanId: span.id,
        spanIndex,
        girderIndex,
        id: `${span.id}-D${girderIndex + 1}`,
        girder,
        ageDays: concreteAge(reportDate, girder.dob),
      }),
    ),
  );
  const beds = Array.from({ length: bridge.yard.beds }, (_, index) => {
    const bed = index + 1;
    const occupants = girders.filter(
      ({ girder }) => girder.bed === bed && girder.st >= 1 && girder.st <= 3,
    );
    return { bed, girders: occupants, clash: occupants.length > 1 };
  });
  const unassigned = girders.filter(
    ({ girder }) =>
      girder.st >= 1 && girder.st <= 3 && (girder.bed <= 0 || girder.bed > bridge.yard.beds),
  );
  let nextSpan: YardSummary["nextSpan"] = null;
  bridge.spans.some((span, index) => {
    const erected = span.girders.filter((girder) => girder.st === 5).length;
    const left = bridge.supports[index];
    const right = bridge.supports[index + 1];
    if (erected < span.girders.length && left?.inc && right?.inc) {
      nextSpan = {
        id: span.id,
        ready: span.girders.filter((girder) => girder.st === 4).length,
        need: span.girders.length - erected,
      };
      return true;
    }
    return false;
  });
  const typeMap = new Map<string, YardSummary["byType"][number]>();
  for (const { girder } of girders) {
    const type = girder.t || "";
    const entry = typeMap.get(type) ?? {
      type,
      total: 0,
      cast: 0,
      onBed: 0,
      ready: 0,
      erected: 0,
      remaining: 0,
    };
    entry.total += 1;
    if (girder.st >= 2) entry.cast += 1;
    if (girder.st >= 1 && girder.st <= 3) entry.onBed += 1;
    if (girder.st === 4) entry.ready += 1;
    if (girder.st === 5) entry.erected += 1;
    entry.remaining = entry.total - entry.cast;
    typeMap.set(type, entry);
  }
  return {
    total: girders.length,
    cast: girders.filter(({ girder }) => girder.st >= 2).length,
    onBed: girders.filter(({ girder }) => girder.st >= 1 && girder.st <= 3).length,
    ready: girders.filter(({ girder }) => girder.st === 4).length,
    erected: girders.filter(({ girder }) => girder.st === 5).length,
    beds,
    unassigned,
    nextSpan,
    byType: [...typeMap.values()].sort((left, right) => left.type.localeCompare(right.type)),
    girders,
  };
}

export function setGirderStage(
  girder: ProgressGirder,
  stage: GirderStage,
  reportDate: string,
): ProgressGirder {
  const next = { ...girder, st: stage };
  if (stage >= 4 || stage === 0) next.bed = 0;
  if (stage >= 2 && !next.dob) next.dob = reportDate;
  if (stage < 2) next.dob = "";
  return next;
}

function isoWeek(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) return "";
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function recordProgressV2Week(
  state: ProgressV2,
  date: string,
  packageId: string | null,
): ProgressV2 {
  const week = isoWeek(date);
  const scopes = packageId === null ? [null] : [packageId, null];
  let history = state.history.filter(
    (record) => !scopes.includes(record.packageId) || record.week !== week,
  );
  for (const scope of scopes) {
    const summary = computeProgressV2(state, scope);
    history.push({
      date,
      week,
      packageId: scope,
      actual: Math.round(summary.overallPct * 10) / 10,
      planned: Math.round(summary.plannedPct * 10) / 10,
    });
  }
  history = history.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      String(left.packageId).localeCompare(String(right.packageId)),
  );
  return { ...state, meta: { ...state.meta, reportDate: date }, history };
}

export function cyclePileState(state: PileState): PileState {
  return ((state + 1) % 3) as PileState;
}

export type V1ProgressLike = {
  title?: string;
  subtitle?: string;
  notes?: string;
  items?: Array<{ key?: string; weight?: number; plannedPct?: number }>;
  weekly?: Array<{ week?: string; date?: string; actualPct?: number; plannedPct?: number }>;
};

function featureNumber(feature: Feature, key: string): number {
  return finite(feature.properties?.[key]);
}

function paintedPct(feature: Feature): number {
  return feature.properties?.tiendo === "done"
    ? 100
    : feature.properties?.tiendo === "wip"
      ? 50
      : 0;
}

/**
 * Order a bridge's supports along it: the first abutment, the piers, then the
 * other abutments, so `spans[i]` lies between `supports[i]` and `supports[i + 1]`.
 */
function orderSupports(ids: string[]): string[] {
  const numeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  const abutments = ids.filter((id) => /^M/i.test(id)).sort(numeric);
  const piers = ids.filter((id) => !/^M/i.test(id)).sort(numeric);
  return abutments.length > 0 ? [abutments[0], ...piers, ...abutments.slice(1)] : piers;
}

/**
 * Build an element-level state from a v1 drawing. The weekly history carries
 * over as whole-project records; a v1 item keeps its weight and plan only when
 * its key is already a v2 item key, which `item-N` keys from the suggested
 * setup are not, so the caller confirms before replacing the v1 setup.
 */
export function migrateProgressV1(
  v1: V1ProgressLike,
  features: readonly Feature[],
  reportDate: string,
): ProgressV2 {
  const stations = features.flatMap((feature) =>
    ["station", "km_tu", "km_den"].flatMap((key) => {
      const value = feature.properties?.[key];
      return value != null && value !== "" && Number.isFinite(Number(value)) ? [Number(value)] : [];
    }),
  );
  const packages: ProgressPackage[] = stations.length
    ? [
        {
          id: "goi-1",
          name: v1.subtitle || v1.title || "1",
          fromStation: stations.reduce((min, value) => Math.min(min, value), Infinity),
          toStation: stations.reduce((max, value) => Math.max(max, value), -Infinity) + 1,
        },
      ]
    : [];
  const weights = emptyPct(PROGRESS_V2_ITEM_KEYS);
  Object.assign(weights, {
    coc: 20,
    be: 8,
    than: 10,
    xm: 7,
    duc: 18,
    gac: 10,
    bmc: 17,
    ht: 10,
    nen: 30,
    mat_trai: 12,
    mat_phai: 12,
    le: 5,
    dpc: 4,
    ranh: 3,
    ham_tuong: 4,
    ham_nap: 3,
  });
  for (const item of v1.items ?? []) {
    const key = item.key?.replaceAll("-", "_") as ProgressV2ItemKey;
    if (PROGRESS_V2_ITEM_KEYS.includes(key) && Number.isFinite(item.weight))
      weights[key] = Math.max(0, item.weight ?? 0);
  }
  const links = new Map(features.map((feature) => [feature, progressFeatureLink(feature)]));
  const bridgeFeatures = new Map<string, Feature[]>();
  for (const feature of features) {
    const link = links.get(feature);
    if (!link || !("bridgeId" in link)) continue;
    const id = link.bridgeId;
    bridgeFeatures.set(id, [...(bridgeFeatures.get(id) ?? []), feature]);
  }
  const bridges: BridgeState[] = [...bridgeFeatures.entries()].map(([id, group]) => {
    const name = featureText(group[0], "cong_trinh") || id;
    const rawStation = group
      .flatMap((feature) => [feature.properties?.station, feature.properties?.km_tu])
      .find((value) => value != null && value !== "" && Number.isFinite(Number(value)));
    const station = rawStation == null ? Number.NaN : Number(rawStation);
    const supportIds = orderSupports([
      ...new Set(
        group.flatMap((feature) => {
          const link = links.get(feature);
          return link?.kind === "support" ? [link.id] : [];
        }),
      ),
    ]);
    const spanIds = [
      ...new Set(
        group.flatMap((feature) => {
          const link = links.get(feature);
          return link?.kind === "span" ? [link.id] : [];
        }),
      ),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const supports = supportIds.map((supportId): ProgressSupport => {
      const parts = group.filter(
        (feature) => links.get(feature)?.kind === "support" && links.get(feature)?.id === supportId,
      );
      const piles = parts.filter((feature) => links.get(feature)?.pileIndex !== undefined);
      const pileStates: PileState[] = [];
      for (const feature of piles) {
        const index = links.get(feature)!.pileIndex!;
        pileStates[index] = Math.max(
          pileStates[index] ?? 0,
          paintedPct(feature) === 100 ? 2 : paintedPct(feature) > 0 ? 1 : 0,
        ) as PileState;
      }
      const stagePct = (pattern: RegExp) =>
        Math.max(
          0,
          ...parts
            .filter((feature) =>
              pattern.test(featureText(feature, "Layer") + " " + featureText(feature, "bo_phan")),
            )
            .map(paintedPct),
        );
      return {
        id: supportId,
        kind: /^M/i.test(supportId) ? "mo" : "tru",
        inc: true,
        coc: {
          t: pileStates.length,
          D: featureNumber(piles[0] ?? parts[0], "duong_kinh_coc_m") || 1,
          L: featureNumber(piles[0] ?? parts[0], "chieu_dai_coc_m") || 12,
        },
        piles: Array.from({ length: pileStates.length }, (_, index) => pileStates[index] ?? 0),
        be: stagePct(/\bbe\b|bệ/i),
        than: stagePct(/than|thân|cột trụ|tuong thân|tường thân/i),
        xm: stagePct(/\bxm\b|xà mũ|xa mu|tường đỉnh/i),
      };
    });
    const spans = spanIds.map((spanId): ProgressSpan => {
      const parts = group.filter(
        (feature) => links.get(feature)?.kind === "span" && links.get(feature)?.id === spanId,
      );
      const girderFeatures = parts.filter(
        (feature) => links.get(feature)?.girderIndex !== undefined,
      );
      const girders: ProgressGirder[] = [];
      for (const feature of girderFeatures) {
        const index = links.get(feature)!.girderIndex!;
        const st = paintedPct(feature) === 100 ? 5 : paintedPct(feature) > 0 ? 2 : 0;
        if (!girders[index] || st > girders[index].st)
          girders[index] = {
            t: featureText(feature, "girder_type") || "Super-T 40",
            st,
            dob: paintedPct(feature) > 0 ? reportDate : "",
            bed: 0,
          };
      }
      const percent = (pattern: RegExp) =>
        Math.max(
          0,
          ...parts
            .filter((feature) =>
              pattern.test(featureText(feature, "Layer") + " " + featureText(feature, "bo_phan")),
            )
            .map(paintedPct),
        );
      return {
        id: spanId,
        L:
          featureNumber(parts[0], "span_length") ||
          featureNumber(parts[0], "chieu_dai_nhip_m") ||
          40,
        lien: featureText(parts[0], "lien"),
        bmc: percent(/bmc|bản mặt cầu/i),
        ht: percent(/lan can|hoàn thiện|hoan thien/i),
        // A girder missing from the drawing takes its span's type, so the type filter
        // and the yard never show an empty type.
        girders: Array.from(
          { length: girders.length },
          (_, index) =>
            girders[index] ?? {
              t: girders.find(Boolean)?.t ?? "Super-T 40",
              st: 0,
              dob: "",
              bed: 0,
            },
        ),
      };
    });
    return { id, name, station, yard: { beds: 5 }, supports, spans };
  });
  const roadByKm = new Map<string, Feature[]>();
  for (const feature of features) {
    const link = links.get(feature);
    if (link?.kind === "km") roadByKm.set(link.id, [...(roadByKm.get(link.id) ?? []), feature]);
  }
  const km = [...roadByKm.entries()].map(([id, group]): RoadKmState => {
    const from = Math.min(...group.map((feature) => featureNumber(feature, "km_tu")));
    const to = Math.max(...group.map((feature) => featureNumber(feature, "km_den")));
    const pct = emptyPct(ROAD_ITEM_KEYS);
    const aliases: Record<RoadItemKey, RegExp> = {
      nen: /nền|nen/i,
      mat_trai: /mặt.*trái|mat-trai|mat_trai/i,
      mat_phai: /mặt.*phải|mat-phai|mat_phai/i,
      le: /lề|le/i,
      dpc: /dpc|phân cách/i,
      ranh: /rãnh|ranh/i,
    };
    for (const key of ROAD_ITEM_KEYS) {
      const matching = group.filter((feature) =>
        aliases[key].test(featureText(feature, "Layer") + " " + featureText(feature, "bo_phan")),
      );
      pct[key] =
        matching.length > 0
          ? matching.reduce((sum, feature) => sum + paintedPct(feature), 0) / matching.length
          : 0;
    }
    return { id, from, to: to > from ? to : from + 1000, pct };
  });
  const underpassGroups = new Map<string, Feature[]>();
  for (const feature of features) {
    const link = links.get(feature);
    const id = link?.kind === "underpass" ? link.id : "";
    if (id) underpassGroups.set(id, [...(underpassGroups.get(id) ?? []), feature]);
  }
  const underpasses = [...underpassGroups.entries()].map(([id, group]): UnderpassState => {
    const walls = group.filter((feature) =>
      /tường|tuong/i.test(featureText(feature, "Layer") + " " + featureText(feature, "bo_phan")),
    );
    const lids = group.filter((feature) =>
      /nắp|nap/i.test(featureText(feature, "Layer") + " " + featureText(feature, "bo_phan")),
    );
    const average = (items: Feature[]) =>
      items.length > 0
        ? items.reduce((sum, feature) => sum + paintedPct(feature), 0) / items.length
        : 0;
    return {
      id,
      station: featureNumber(group[0], "station") || featureNumber(group[0], "km_tu"),
      pct: { tuong: average(walls), nap: average(lids) },
    };
  });
  const plan: ProgressV2["plan"] = {};
  for (const packageItem of packages) {
    plan[packageItem.id] = {};
    for (const item of v1.items ?? []) {
      const key = item.key?.replaceAll("-", "_") as ProgressV2ItemKey;
      if (PROGRESS_V2_ITEM_KEYS.includes(key))
        plan[packageItem.id][key] = clampProgressPct(item.plannedPct);
    }
  }
  return {
    version: 2,
    meta: {
      title: v1.title ?? "",
      subtitle: v1.subtitle ?? "",
      reportDate,
    },
    packages,
    weights,
    plan,
    bridges,
    road: { km },
    underpasses,
    history: (v1.weekly ?? [])
      .filter((record) => record.date)
      .map((record) => ({
        date: record.date ?? "",
        week: record.week || isoWeek(record.date ?? ""),
        packageId: null,
        actual: clampProgressPct(record.actualPct),
        planned: clampProgressPct(record.plannedPct),
      })),
    notes: v1.notes ?? "",
  };
}
