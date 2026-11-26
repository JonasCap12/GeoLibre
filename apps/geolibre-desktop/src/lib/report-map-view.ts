import { PROGRESS_DASHBOARD_INDEX_PROPERTY, type GeoLibreLayer } from "@geolibre/core";
import { linesForFront, type BoardReport } from "./daily-report-data";
import {
  layerView,
  NETWORK_LINE_WIDTH,
  type NetworkColorMode,
  type NetworkLayerConfig,
  type NetworkSegment,
} from "./network-dashboard";
import { frontForLine, frontProgress, type ReportSelection } from "./report-map-interaction";

export const REPORT_BANDS = [
  { value: "80", min: 80, color: "#15803d" },
  { value: "60", min: 60, color: "#65a30d" },
  { value: "40", min: 40, color: "#eab308" },
  { value: "20", min: 20, color: "#f97316" },
  { value: "0", min: 0, color: "#dc2626" },
  { value: "unknown", min: -Infinity, color: "#94a3b8" },
] as const;
export const reportBand = (percent: number | null) =>
  REPORT_BANDS.find((band) => percent !== null && percent >= band.min) ?? REPORT_BANDS[5];

export function reportLineProgress(line: NetworkSegment, report: BoardReport | null) {
  if (!report) return null;
  const match = frontForLine(line.name, [report]);
  const front = match && report.fronts.find((item) => item.id === match.frontId);
  return front ? { front, percent: frontProgress(report, front) } : null;
}

/** The report's six fixed progress bands; totals always use the viewed day's figures. */
export function reportLegend(lines: readonly NetworkSegment[], report: BoardReport | null) {
  return REPORT_BANDS.map((band) => ({
    ...band,
    km: lines.reduce((sum, line) => {
      const hit = reportLineProgress(line, report);
      return sum + (hit && reportBand(hit.percent).value === band.value ? line.km : 0);
    }, 0),
  }));
}

const indexExpression = ["get", PROGRESS_DASHBOARD_INDEX_PROPERTY];
const indexesMatch = (indexes: readonly number[]) =>
  indexes.length ? ["match", indexExpression, [...indexes], true, false] : ["literal", false];
function dim(color: unknown): unknown[] {
  const rgba = ["to-rgba", color];
  return ["rgba", ["at", 0, rgba], ["at", 1, rgba], ["at", 2, rgba], 0.2];
}

/** Uses only the existing renderer view. Match tables give O(1) feature styling. */
export function reportDashboardView(
  layerId: string,
  config: NetworkLayerConfig,
  lines: readonly NetworkSegment[],
  mode: NetworkColorMode | "report",
  colors: ReadonlyMap<string, string>,
  report: BoardReport | null,
  emphasis: ReportSelection | null,
): NonNullable<GeoLibreLayer["progressDashboard"]> {
  const own = lines.filter((line) => line.layerId === layerId);
  const base = layerView(
    config,
    mode === "report" ? "status" : mode,
    colors,
    own.map((line) => line.index),
  );
  let color: unknown = JSON.parse(base.colorExpression);
  if (mode === "report") {
    const pairs = own.flatMap((line) => {
      const hit = reportLineProgress(line, report);
      return hit ? [line.index, reportBand(hit.percent).color] : [];
    });
    color = pairs.length
      ? ["match", indexExpression, ...pairs, "rgba(148, 163, 184, 0.2)"]
      : ["to-color", "rgba(148, 163, 184, 0.2)"];
  }
  if (!emphasis) return { ...base, colorExpression: JSON.stringify(color) };
  const front =
    report?.pkg === emphasis.pkg
      ? report.fronts.find((item) => item.id === emphasis.frontId)
      : null;
  const emphasized = front ? linesForFront(own, emphasis.pkg, front).map((line) => line.index) : [];
  if (!front) return { ...base, colorExpression: JSON.stringify(color) };
  const selected = indexesMatch(emphasized);
  color = ["to-color", color];
  // Zoom expressions must remain top-level; put the per-feature case at each stop.
  const width = NETWORK_LINE_WIDTH.map((value, index) =>
    index >= 4 && index % 2 === 0 && typeof value === "number"
      ? ["case", selected, value * 1.6, value * 0.7]
      : value,
  );
  return {
    ...base,
    colorExpression: JSON.stringify(["case", selected, color, dim(color)]),
    lineWidth: width,
  };
}
