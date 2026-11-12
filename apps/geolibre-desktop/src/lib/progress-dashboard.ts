import type { Feature } from "geojson";
import {
  ROAD_ITEM_KEYS,
  PROGRESS_V2_ITEM_KEYS,
  bridgesInPackage,
  clampProgressPct,
  computeProgressAlerts,
  computeProgressV2,
  evaluateProgress,
  computeYard,
  packageForStation,
  spanItemPct,
  supportItemPct,
  type ProgressV2,
  type ProgressV2ItemKey,
  type ProgressV2Summary,
  type ProgressAlert,
} from "./progress-v2";
import {
  PROGRESS_V2_COLORS,
  progressFeatureTarget,
  progressFeatureItems,
  stateColors,
  type ProgressFeatureTarget,
} from "./progress-colors";

export type DashboardKind = "bridge" | "road" | "underpass";
export type DashboardStatus = "empty" | "wip" | "done" | "late";
export type DashboardColorMode = "status" | "deviation" | "girder";
export interface DashboardFilters {
  kinds: DashboardKind[];
  items: ProgressV2ItemKey[];
  statuses: DashboardStatus[];
  bridgeIds: string[];
  station: [number, number] | null;
  girderTypes: string[];
}
export const EMPTY_DASHBOARD_FILTERS: DashboardFilters = {
  kinds: [],
  items: [],
  statuses: [],
  bridgeIds: [],
  station: null,
  girderTypes: [],
};
export interface DashboardRow {
  id: string;
  componentId: string;
  kind: DashboardKind;
  key: ProgressV2ItemKey;
  target: ProgressFeatureTarget;
  bridgeId?: string;
  packageId: string | null;
  from: number;
  to: number;
  pct: number;
  planned: number;
  denominator: number;
  index?: number;
  girderType?: string;
  started?: boolean;
}
export const DASHBOARD_STATUS_COLORS: Record<DashboardStatus, string> = {
  empty: PROGRESS_V2_COLORS.empty,
  wip: PROGRESS_V2_COLORS.wip,
  done: PROGRESS_V2_COLORS.done,
  late: "#dc4545",
};
export const DASHBOARD_DEVIATION_COLORS = { late: "#dc4545", ok: "#d9a520", ahead: "#1f7a47" };

/** Atomic item quantities retain the same denominators and plans as computeProgressV2. */
export function dashboardRows(
  state: ProgressV2,
  packageId: string | null = null,
): DashboardRow[] {
  const rows: DashboardRow[] = [];
  const add = (
    row: Omit<DashboardRow, "planned" | "id" | "componentId">,
    component: string,
  ) => {
    rows.push({
      ...row,
      componentId: component,
      id: `${component}:${row.key}:${row.from}`,
      planned: row.packageId ? clampProgressPct(state.plan[row.packageId]?.[row.key]) : 0,
    });
  };
  for (const bridge of bridgesInPackage(state, packageId)) {
    const base = {
      kind: "bridge" as const,
      bridgeId: bridge.id,
      packageId: packageForStation(state.packages, bridge.station)?.id ?? null,
      from: bridge.station,
      to: bridge.station,
    };
    for (const support of bridge.supports.filter((item) => item.inc)) {
      const target = { kind: "support" as const, bridgeId: bridge.id, id: support.id };
      const component = `${bridge.id}:support:${support.id}`;
      support.piles.slice(0, support.coc.t).forEach((pile, index) =>
        add(
          {
            ...base,
            target,
            key: "coc",
            pct: pile === 2 ? 100 : 0,
            started: pile > 0,
            denominator: 1,
            index,
          },
          `${component}:pile:${index}`,
        ),
      );
      for (const key of ["be", "than", "xm"] as const)
        add(
          { ...base, target, key, pct: supportItemPct(support, key), denominator: 1 },
          `${component}:${key}`,
        );
    }
    for (const span of bridge.spans) {
      const target = { kind: "span" as const, bridgeId: bridge.id, id: span.id };
      const component = `${bridge.id}:span:${span.id}`;
      span.girders.forEach((girder, index) => {
        for (const key of ["duc", "gac"] as const)
          add(
            {
              ...base,
              target,
              key,
              pct: spanItemPct({ ...span, girders: [girder] }, key),
              denominator: 1,
              index,
              girderType: girder.t,
              started: girder.st > 0,
            },
            `${component}:girder:${index}`,
          );
      });
      for (const key of ["bmc", "ht"] as const)
        add(
          { ...base, target, key, pct: spanItemPct(span, key), denominator: span.L },
          `${component}:${key}`,
        );
    }
  }
  const scope = state.packages.find((item) => item.id === packageId);
  for (const km of state.road.km) {
    const from = Math.max(km.from, scope?.fromStation ?? -Infinity);
    const to = Math.min(km.to, scope?.toStation ?? Infinity);
    if (to <= from) continue;
    const cuts = [
      ...new Set([
        from,
        to,
        ...state.packages
          .flatMap((p) => [p.fromStation, p.toStation])
          .filter((station) => station > from && station < to),
      ]),
    ].sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      for (const key of ROAD_ITEM_KEYS)
        add(
          {
            kind: "road",
            key,
            target: { kind: "km", id: km.id },
            from: cuts[i],
            to: cuts[i + 1],
            packageId:
              packageForStation(state.packages, (cuts[i] + cuts[i + 1]) / 2)?.id ?? null,
            pct: km.pct[key],
            denominator: cuts[i + 1] - cuts[i],
          },
          `road:${km.id}:${key}`,
        );
    }
  }
  for (const underpass of state.underpasses) {
    const owner = packageForStation(state.packages, underpass.station)?.id ?? null;
    if (packageId && owner !== packageId) continue;
    for (const key of ["ham_tuong", "ham_nap"] as const)
      add(
        {
          kind: "underpass",
          key,
          target: { kind: "underpass", id: underpass.id },
          packageId: owner,
          from: underpass.station,
          to: underpass.station,
          denominator: 1,
          pct: key === "ham_tuong" ? underpass.pct.tuong : underpass.pct.nap,
        },
        `underpass:${underpass.id}:${key}`,
      );
  }
  return rows;
}

export function dashboardStatus(pct: number, planned: number): DashboardStatus {
  return evaluateProgress(pct, planned, planned > 0) === "late"
    ? "late"
    : pct >= 100
    ? "done"
    : pct > 0
    ? "wip"
    : "empty";
}

/** Clip road quantities to the selected station interval; never mutate saved state. */
export function filterDashboardRows(
  rows: readonly DashboardRow[],
  filters: DashboardFilters,
): DashboardRow[] {
  const selected = rows.flatMap((row) => {
    if (filters.kinds.length && !filters.kinds.includes(row.kind)) return [];
    if (filters.items.length && !filters.items.includes(row.key)) return [];
    if (
      filters.bridgeIds.length &&
      (!row.bridgeId || !filters.bridgeIds.includes(row.bridgeId))
    )
      return [];
    if (
      filters.girderTypes.length &&
      (row.girderType === undefined || !filters.girderTypes.includes(row.girderType))
    )
      return [];
    if (!filters.station) return [row];
    const [start, end] = filters.station;
    if (!Number.isFinite(row.from) || start > end) return [];
    if (row.kind !== "road") return row.from >= start && row.from <= end ? [row] : [];
    const from = Math.max(start, row.from),
      to = Math.min(end, row.to);
    return to > from ? [{ ...row, from, to, denominator: to - from }] : [];
  });
  if (!filters.statuses.length) return selected;
  const statuses = dashboardComponentStatuses(selected);
  return selected.filter((row) => filters.statuses.includes(statuses.get(row.componentId)!));
}

export function summarizeDashboardRows(
  state: ProgressV2,
  rows: readonly DashboardRow[],
): ProgressV2Summary {
  // The existing engine owns applicability, weight selection and overall rounding policy.
  const items = PROGRESS_V2_ITEM_KEYS.map((key) => {
    const selected = rows.filter((row) => row.key === key);
    const denominator = selected.reduce((sum, row) => sum + row.denominator, 0);
    const plannedDenominator = selected.reduce(
      (sum, row) => sum + (row.packageId ? row.denominator : 0),
      0,
    );
    return {
      key,
      denominator,
      applicable: denominator > 0,
      pct: denominator
        ? selected.reduce((sum, row) => sum + row.pct * row.denominator, 0) / denominator
        : 0,
      plannedPct: plannedDenominator
        ? selected.reduce((sum, row) => sum + row.planned * row.denominator, 0) /
          plannedDenominator
        : 0,
    };
  });
  return computeProgressV2(state, null, items);
}

export function dashboardGroups(
  state: ProgressV2,
  rows: readonly DashboardRow[],
  by: "package" | "bridge",
) {
  const ids = [
    ...new Set(
      rows.flatMap((row) => {
        const id = by === "package" ? row.packageId : row.bridgeId;
        return id ? [id] : [];
      }),
    ),
  ];
  return ids
    .map((id) => ({
      id,
      name:
        (by === "package" ? state.packages : state.bridges).find((item) => item.id === id)
          ?.name ?? id,
      ...summarizeDashboardRows(
        state,
        rows.filter((row) => (by === "package" ? row.packageId : row.bridgeId) === id),
      ),
    }))
    .sort((a, b) => a.deviation - b.deviation);
}

export function dashboardQuantities(state: ProgressV2, rows: readonly DashboardRow[]) {
  const item = (key: ProgressV2ItemKey) => {
    const selected = rows.filter((row) => row.key === key);
    return {
      total: selected.reduce((sum, row) => sum + row.denominator, 0),
      done: selected.reduce((sum, row) => sum + (row.denominator * row.pct) / 100, 0),
    };
  };
  const roadRows = rows.filter((row) => row.kind === "road");
  const road = state.road.km.reduce((sum, km) => {
    const selected = roadRows.filter((row) => row.target.id === km.id);
    if (!selected.length) return sum;
    const intervals = [...new Set(selected.map((row) => `${row.from}:${row.to}`))];
    return (
      sum +
      intervals.reduce((length, interval) => {
        const segment = selected.filter((row) => `${row.from}:${row.to}` === interval);
        return length + (segment.every((row) => row.pct >= 100) ? segment[0].denominator : 0);
      }, 0) /
        1000
    );
  }, 0);
  const underpasses = [
    ...new Set(rows.filter((row) => row.kind === "underpass").map((row) => row.target.id)),
  ];
  return {
    piles: item("coc"),
    girders: item("gac"),
    roadKm: road,
    underpasses: {
      total: underpasses.length,
      done: underpasses.filter((id) =>
        rows
          .filter((row) => row.kind === "underpass" && row.target.id === id)
          .every((row) => row.pct >= 100),
      ).length,
    },
  };
}

/** Historical records are aggregate snapshots, not per-element snapshots. */
export function dashboardHistory(
  state: ProgressV2,
  packageId: string | null,
  throughDate?: string,
) {
  const byWeek = new Map<string, ProgressV2["history"][number]>();
  for (const point of [...state.history].sort((a, b) => a.date.localeCompare(b.date))) {
    if (
      point.packageId === packageId &&
      (!throughDate || point.date <= throughDate) &&
      Number.isFinite(Date.parse(point.date))
    )
      byWeek.set(point.week, point);
  }
  return [...byWeek.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Linear extrapolation of the latest eight actual observations; no plan dates are invented. */
export function forecastDashboardCompletion(history: ProgressV2["history"]): string | null {
  const points = [...history]
    .filter((p) => Number.isFinite(Date.parse(p.date)))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-8);
  if (!points.length) return null;
  const last = points[points.length - 1];
  if (last.actual >= 100) return last.date;
  if (points.length < 2) return null;
  const origin = Date.parse(points[0].date);
  const xs = points.map((p) => (Date.parse(p.date) - origin) / 86400000);
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = points.reduce((a, b) => a + b.actual, 0) / points.length;
  const variance = xs.reduce((sum, x) => sum + (x - meanX) ** 2, 0);
  const slope = variance
    ? xs.reduce((sum, x, i) => sum + (x - meanX) * (points[i].actual - meanY), 0) / variance
    : 0;
  if (slope <= 0) return null;
  const time = Date.parse(last.date) + Math.ceil((100 - last.actual) / slope) * 86400000;
  return Number.isFinite(time) && time <= 8640000000000000
    ? new Date(time).toISOString().slice(0, 10)
    : null;
}

export function dashboardYard(state: ProgressV2, rows: readonly DashboardRow[]) {
  const types = new Map<
    string,
    {
      type: string;
      cast: number;
      onBed: number;
      ready: number;
      erected: number;
      remaining: number;
    }
  >();
  const wanted = new Set(
    rows
      .filter((row) => row.girderType !== undefined)
      .map((row) => `${row.bridgeId}:${row.target.id}:${row.index}`),
  );
  for (const bridge of state.bridges) {
    for (const entry of computeYard(bridge, state.meta.reportDate).girders) {
      if (!wanted.has(`${bridge.id}:${entry.spanId}:${entry.girderIndex}`)) continue;
      const type = entry.girder.t;
      const row = types.get(type) ?? {
        type,
        cast: 0,
        onBed: 0,
        ready: 0,
        erected: 0,
        remaining: 0,
      };
      const stage = entry.girder.st;
      if (stage >= 2) row.cast++;
      if (stage >= 1 && stage <= 3) row.onBed++;
      else if (stage === 4) row.ready++;
      else if (stage === 5) row.erected++;
      else row.remaining++;
      types.set(type, row);
    }
  }
  return [...types.values()].sort((a, b) => a.type.localeCompare(b.type));
}

export function dashboardComponentStatuses(rows: readonly DashboardRow[]) {
  const components = new Map<string, DashboardRow[]>();
  for (const row of rows)
    components.set(row.componentId, [...(components.get(row.componentId) ?? []), row]);
  const statuses = new Map<string, DashboardStatus>();
  for (const [id, group] of components) {
    // A girder is one physical component even though it contributes to casting and erection.
    const total = group.reduce((sum, row) => sum + row.denominator, 0);
    const pct = total
      ? group.reduce((sum, row) => sum + row.pct * row.denominator, 0) / total
      : 0;
    const plan = total
      ? group.reduce((sum, row) => sum + row.planned * row.denominator, 0) / total
      : 0;
    const status = dashboardStatus(pct, plan);
    statuses.set(id, status === "empty" && group.some((row) => row.started) ? "wip" : status);
  }
  return statuses;
}

export function dashboardStatusCounts(rows: readonly DashboardRow[]) {
  const counts: Record<DashboardStatus, number> = { empty: 0, wip: 0, done: 0, late: 0 };
  for (const status of dashboardComponentStatuses(rows).values()) counts[status]++;
  return counts;
}

export function dashboardAlerts(
  state: ProgressV2,
  packageId: string | null,
  rows: readonly DashboardRow[],
): ProgressAlert[] {
  const summary = summarizeDashboardRows(state, rows);
  const late: ProgressAlert[] = summary.items
    .filter((item) => item.applicable && dashboardStatus(item.pct, item.plannedPct) === "late")
    .map((item) => ({
      code: "item-late",
      severity: item.pct - item.plannedPct <= -5 ? 3 : 2,
      itemKey: item.key,
      actual: item.pct,
      planned: item.plannedPct,
    }));
  const structural = computeProgressAlerts(state, packageId).filter((alert) => {
    if (alert.code === "item-late" || alert.code === "no-plan") return false;
    return rows.some(
      (row) =>
        row.bridgeId === alert.bridgeId &&
        (!alert.supportId || row.target.id === alert.supportId) &&
        (!alert.spanId || row.target.id === alert.spanId),
    );
  });
  if (rows.length && !summary.items.some((item) => item.applicable && item.plannedPct > 0))
    structural.push({ code: "no-plan", severity: 2 });
  return [...late, ...structural].sort((a, b) => b.severity - a.severity);
}

/** Locate every filtered component involved in an alert, including yard girder IDs. */
export function dashboardAlertRows(
  rows: readonly DashboardRow[],
  alert: ProgressAlert,
): DashboardRow[] {
  return rows.filter((row) => {
    if (alert.bridgeId && row.bridgeId !== alert.bridgeId) return false;
    if (alert.supportId && (row.target.kind !== "support" || row.target.id !== alert.supportId))
      return false;
    if (alert.spanId && (row.target.kind !== "span" || row.target.id !== alert.spanId))
      return false;
    if (
      alert.itemKey &&
      (row.key !== alert.itemKey || dashboardStatus(row.pct, row.planned) !== "late")
    )
      return false;
    if (alert.ids?.length && !alert.supportId && !alert.spanId) {
      return (
        row.target.kind === "span" &&
        row.index !== undefined &&
        alert.ids.includes(`${row.target.id}-D${row.index + 1}`)
      );
    }
    return true;
  });
}

export function dashboardStationExtent(rows: readonly DashboardRow[]): [number, number] | null {
  const values = rows.flatMap((row) => [row.from, row.to]).filter(Number.isFinite);
  return values.length
    ? values.reduce<[number, number]>(
        ([min, max], value) => [Math.min(min, value), Math.max(max, value)],
        [Infinity, -Infinity],
      )
    : null;
}

/** Use the drawing's existing link and alias resolution for both filtering and coloring. */
export function dashboardMapView(
  features: readonly Feature[],
  state: ProgressV2,
  rows: readonly DashboardRow[],
  mode: DashboardColorMode,
) {
  const colors = stateColors(features, state);
  const statuses = dashboardComponentStatuses(rows);
  const indexes: number[] = [];
  const expression: unknown[] = ["match", ["to-string", ["id"]]];
  const byTarget = new Map<string, DashboardRow[]>();
  const targetKey = (target: ProgressFeatureTarget) =>
    `${target.kind}:${"bridgeId" in target ? target.bridgeId : ""}:${target.id}`;
  for (const row of rows) {
    const key = targetKey(row.target);
    byTarget.set(key, [...(byTarget.get(key) ?? []), row]);
  }
  features.forEach((feature, index) => {
    const target = progressFeatureTarget(feature);
    const approach =
      !target && ["ht", "approach"].includes(String(feature.properties?.progress_item));
    if (!target && !approach) return;
    const keys = progressFeatureItems(feature);
    const candidates = target
      ? byTarget.get(targetKey(target)) ?? []
      : rows.filter(
          (row) => row.bridgeId === feature.properties?.bridge_id && row.key === "ht",
        );
    const matched = candidates.filter(
      (row) =>
        (!keys.length || keys.includes(row.key)) &&
        (row.index === undefined ||
          Number(feature.properties?.[row.key === "coc" ? "pile_index" : "girder_index"]) ===
            row.index),
    );
    if (!matched.length) return;
    indexes.push(index);
    const pct = matched.reduce((sum, row) => sum + row.pct, 0) / matched.length;
    const plan = matched.reduce((sum, row) => sum + row.planned, 0) / matched.length;
    const status = statuses.get(matched[0].componentId) ?? dashboardStatus(pct, plan);
    const evaluation = evaluateProgress(pct, plan, true);
    const color =
      mode === "girder"
        ? colors.get(index)?.color ?? DASHBOARD_STATUS_COLORS[status]
        : mode === "deviation"
        ? DASHBOARD_DEVIATION_COLORS[evaluation === "na" ? "ok" : evaluation]
        : DASHBOARD_STATUS_COLORS[status];
    // Renderer-only source IDs preserve explicit feature IDs and identify untagged features by index.
    expression.push(String(feature.id ?? index), color);
  });
  expression.push(PROGRESS_V2_COLORS.empty);
  return {
    indexes,
    filter: [
      "in",
      ["to-string", ["id"]],
      ["literal", indexes.map((index) => String(features[index].id ?? index))],
    ],
    colorExpression: indexes.length
      ? JSON.stringify(expression)
      : JSON.stringify(PROGRESS_V2_COLORS.empty),
  };
}
