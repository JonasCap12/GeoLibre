import type { ProgressV2, ProgressV2ItemKey, ProgressAlert } from "./progress-v2";
import {
  dashboardAlerts,
  dashboardAlertRows,
  dashboardHistory,
  dashboardStatus,
  forecastDashboardCompletion,
  summarizeDashboardRows,
  dashboardStructureId,
  type DashboardRow,
  type DashboardKind,
} from "./progress-dashboard";

export interface DashboardStructure {
  id: string;
  kind: DashboardKind;
  name: string;
  from: number;
  to: number;
  summary: ReturnType<typeof summarizeDashboardRows>;
  rows: DashboardRow[];
}

/** Group atomic rows once; all cell totals use the existing weighted progress engine. */
export function dashboardMatrix(
  state: ProgressV2,
  rows: readonly DashboardRow[],
): DashboardStructure[] {
  const grouped = new Map<string, DashboardRow[]>();
  const names = new Map(state.bridges.map((b) => [b.id, b.name]));
  for (const row of rows) {
    const id = dashboardStructureId(row),
      group = grouped.get(id);
    if (group) group.push(row);
    else grouped.set(id, [row]);
  }
  return [...grouped]
    .map(([id, group]) => ({
      id,
      kind: group[0].kind,
      name: group[0].bridgeId
        ? (names.get(group[0].bridgeId) ?? group[0].bridgeId)
        : group[0].target.id,
      from: Math.min(...group.map((r) => r.from)),
      to: Math.max(...group.map((r) => r.to)),
      summary: summarizeDashboardRows(state, group),
      rows: group,
    }))
    .sort(
      (a, b) =>
        a.summary.deviation - b.summary.deviation ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
}

/** One segment for each structure/item/interval, retaining real station widths and points. */
export function dashboardStrip(state: ProgressV2, rows: readonly DashboardRow[]) {
  const grouped = new Map<string, DashboardRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.from) || !Number.isFinite(row.to)) continue;
    const id = `${dashboardStructureId(row)}:${row.kind === "road" ? row.key : "all"}:${row.from}:${row.to}`;
    const group = grouped.get(id);
    if (group) group.push(row);
    else grouped.set(id, [row]);
  }
  return [...grouped].map(([id, group]) => {
    const denominator = group.reduce((s, r) => s + r.denominator, 0);
    const summary = group[0].kind === "road" ? null : summarizeDashboardRows(state, group);
    const pct =
      summary?.overallPct ??
      (denominator ? group.reduce((s, r) => s + r.pct * r.denominator, 0) / denominator : 0);
    const planned =
      summary?.plannedPct ??
      (denominator ? group.reduce((s, r) => s + r.planned * r.denominator, 0) / denominator : 0);
    const row = group[0];
    return {
      id,
      structureId: dashboardStructureId(row),
      kind: row.kind,
      key: row.key,
      from: row.from,
      to: row.to,
      pct,
      planned,
      status: dashboardStatus(pct, planned),
    };
  });
}

export interface DashboardAlertEntry {
  id: string;
  itemKey?: ProgressV2ItemKey;
  actual: number;
  planned: number;
  deviation: number;
  alert?: ProgressAlert;
}

/** Open a real component of this item, respecting support/span-specific alerts. */
export function dashboardAlertTarget(structure: DashboardStructure, entry: DashboardAlertEntry) {
  const candidates = entry.alert ? dashboardAlertRows(structure.rows, entry.alert) : structure.rows;
  const matching = entry.itemKey
    ? candidates.filter((row) => row.key === entry.itemKey)
    : candidates;
  const rows = matching.length ? matching : candidates;
  return rows.reduce<DashboardRow | undefined>(
    (worst, row) => (!worst || row.pct - row.planned < worst.pct - worst.planned ? row : worst),
    undefined,
  )?.target;
}
export function dashboardAlertGroups(
  state: ProgressV2,
  rows: readonly DashboardRow[],
  packageId: string | null,
) {
  const structures = dashboardMatrix(state, rows);
  const structural = dashboardAlerts(state, packageId, rows).filter((a) => a.code !== "item-late");
  const structuralItems: Partial<Record<ProgressAlert["code"], ProgressV2ItemKey>> = {
    "girder-before-cap": "gac",
    "deck-before-girders": "bmc",
    "cap-before-piles": "be",
    "pier-before-cap": "than",
    "capbeam-before-pier": "xm",
    "bed-clash": "duc",
    "girder-without-bed": "duc",
    "yard-overstock": "duc",
    "next-span-girders-short": "gac",
    "next-span-waits-cap": "xm",
  };
  return structures
    .flatMap((structure) => {
      const entries: DashboardAlertEntry[] = structure.summary.items
        .filter((item) => item.applicable && dashboardStatus(item.pct, item.plannedPct) === "late")
        .map((item) => ({
          id: `item:${item.key}`,
          itemKey: item.key,
          actual: item.pct,
          planned: item.plannedPct,
          deviation: item.pct - item.plannedPct,
        }));
      structural.forEach((alert, index) => {
        if (!dashboardAlertRows(structure.rows, alert).length) return;
        const itemKey = alert.itemKey ?? structuralItems[alert.code];
        const item = structure.summary.items.find((i) => i.key === itemKey);
        const actual = alert.actual ?? item?.pct ?? 0,
          planned = alert.planned ?? item?.plannedPct ?? 0;
        entries.push({
          id: `sequence:${index}`,
          itemKey,
          actual,
          planned,
          deviation: actual - planned,
          alert,
        });
      });
      entries.sort((a, b) => a.deviation - b.deviation);
      return entries.length ? [{ structure, entries, worst: entries[0] }] : [];
    })
    .sort((a, b) => a.worst.deviation - b.worst.deviation);
}

/** Aggregate history has no per-element snapshots. Dates below are explicitly estimates. */
export function dashboardSchedule(
  state: ProgressV2,
  packageId: string | null,
  throughDate?: string,
) {
  const history = dashboardHistory(state, packageId, throughDate);
  const forecast = forecastDashboardCompletion(history);
  const planEnd = forecastDashboardCompletion(history.map((p) => ({ ...p, actual: p.planned })));
  const days =
    forecast && planEnd
      ? Math.round((Date.parse(planEnd) - Date.parse(forecast)) / 86400000)
      : null;
  return { history, forecast, planEnd, days };
}

export function dashboardBrush(
  extent: [number, number],
  start: number,
  end: number,
): [number, number] {
  const clamp = (v: number) => Math.max(extent[0], Math.min(extent[1], v));
  return [Math.round(clamp(Math.min(start, end))), Math.round(clamp(Math.max(start, end)))];
}
