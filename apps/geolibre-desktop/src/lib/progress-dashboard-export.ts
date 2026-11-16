import type { TFunction } from "i18next";
import type { ProgressV2 } from "./progress-v2";
import { dashboardHistory, summarizeDashboardRows, type DashboardRow } from "./progress-dashboard";
import {
  dashboardMatrix,
  dashboardAlertGroups,
  dashboardSchedule,
} from "./progress-dashboard-analysis";
import { triggerDownload } from "./chart-export";
import { isoWeek } from "./construction-progress";

export interface ProgressReportSheet {
  name: string;
  data: (string | number | null)[][];
}
export function progressReportSheets(
  state: ProgressV2,
  rows: readonly DashboardRow[],
  packageId: string | null,
  throughDate: string,
  t: TFunction,
): ProgressReportSheet[] {
  const summary = summarizeDashboardRows(state, rows);
  const point = throughDate ? dashboardHistory(state, packageId, throughDate).at(-1) : undefined;
  const actual = point?.actual ?? summary.overallPct,
    planned = point?.planned ?? summary.plannedPct;
  const schedule = dashboardSchedule(state, packageId, throughDate || undefined);
  const matrix = dashboardMatrix(state, rows),
    alerts = dashboardAlertGroups(state, rows, packageId);
  const date = point?.date ?? state.meta.reportDate;
  const scopedPackages = [
    ...new Set(rows.flatMap((row) => (row.packageId ? [row.packageId] : []))),
  ];
  const packageName = packageId
    ? state.packages.find((p) => p.id === packageId)?.name
    : scopedPackages.length === state.packages.length
      ? t("progress.wholeProject")
      : scopedPackages.map((id) => state.packages.find((p) => p.id === id)?.name ?? id).join("; ");
  const details = [t("progress.v2.dashboard.detailsAsOf"), state.meta.reportDate];
  const headings = [
    t("progress.v2.dashboard.structure"),
    t("progress.items"),
    t("progress.actual"),
    t("progress.planned"),
    t("progress.deviation"),
  ];
  const itemKeys = [
    ...new Set(
      matrix.flatMap((s) => s.summary.items.filter((i) => i.applicable).map((i) => i.key)),
    ),
  ];
  return [
    {
      name: t("progress.v2.dashboard.sheetSummary"),
      data: [
        [state.meta.title],
        [t("progress.v2.package"), packageName ?? t("progress.wholeProject")],
        [t("progress.v2.dashboard.reportDate"), date],
        details,
        [t("progress.actual"), actual],
        [t("progress.planned"), planned],
        [t("progress.deviation"), actual - planned],
        [t("progress.v2.dashboard.spi"), planned > 0 ? actual / planned : null],
        [t("progress.v2.dashboard.forecast"), schedule.forecast],
        [t("progress.v2.dashboard.planEndEstimate"), schedule.planEnd],
        [t("progress.v2.dashboard.days"), schedule.days],
        [t("progress.v2.dashboard.activeFilters"), matrix.map((s) => s.name).join("; ")],
        [t("progress.v2.dashboard.week"), point?.week ?? isoWeek(state.meta.reportDate)],
        [t("progress.v2.dashboard.historyScope")],
      ],
    },
    {
      name: t("progress.v2.dashboard.sheetStructures"),
      data: [
        details,
        [
          t("progress.v2.dashboard.structure"),
          ...itemKeys.map((key) => t(`progress.v2.items.${key}`)),
          t("progress.actual"),
          t("progress.planned"),
          t("progress.deviation"),
        ],
        ...matrix.map((s) => [
          s.name,
          ...itemKeys.map((key) => {
            const cell = s.summary.items.find((i) => i.key === key && i.applicable);
            return cell?.pct ?? null;
          }),
          s.summary.overallPct,
          s.summary.plannedPct,
          s.summary.deviation,
        ]),
      ],
    },
    {
      name: t("progress.v2.dashboard.sheetItems"),
      data: [
        details,
        headings.slice(1),
        ...summary.items
          .filter((i) => i.applicable)
          .map((i) => [t(`progress.v2.items.${i.key}`), i.pct, i.plannedPct, i.pct - i.plannedPct]),
      ],
    },
    {
      name: t("progress.v2.dashboard.sheetAlerts"),
      data: [
        details,
        [...headings, t("progress.v2.dashboard.reason")],
        ...alerts.flatMap((g) =>
          g.entries.map((e) => [
            g.structure.name,
            e.itemKey ? t(`progress.v2.items.${e.itemKey}`) : t("progress.v2.dashboard.sequence"),
            e.actual,
            e.planned,
            e.deviation,
            e.alert
              ? t(`progress.v2.alert.${e.alert.code}`, {
                  bridge: e.alert.bridgeId ?? "",
                  support: e.alert.supportId ?? "",
                  span: e.alert.spanId ?? "",
                  count: e.alert.count ?? 0,
                  total: e.alert.total ?? 0,
                  ids: e.alert.ids?.join(", ") ?? "",
                  bed: e.alert.bed ?? 0,
                })
              : t("progress.v2.dashboard.statuses.late"),
          ]),
        ),
      ],
    },
  ];
}

/** XLSX stays off the initial dashboard bundle. Cells are values, never formulas. */
export async function encodeProgressWorkbook(sheets: ProgressReportSheet[]): Promise<ArrayBuffer> {
  const XLSX = await import("@e965/xlsx");
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.data);
    ws["!cols"] = Array.from(
      { length: Math.max(...sheet.data.map((row) => row.length)) },
      (_, i) => ({ wch: i === 0 ? 48 : 18 }),
    );
    XLSX.utils.book_append_sheet(workbook, ws, sheet.name);
  }
  return XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}
export async function downloadProgressWorkbook(sheets: ProgressReportSheet[], filename: string) {
  const data = await encodeProgressWorkbook(sheets);
  triggerDownload(
    new Blob([data], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    filename,
  );
}
