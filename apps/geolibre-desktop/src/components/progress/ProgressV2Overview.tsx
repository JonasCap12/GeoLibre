import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  progressStateColor,
  PROGRESS_V2_COLORS,
  type ProgressFeatureTarget,
} from "../../lib/progress-colors";
import {
  bridgesInPackage,
  computeProgressAlerts,
  computeProgressV2,
  evaluateProgress,
  packageForStation,
  type ProgressAlert,
  type ProgressV2,
} from "../../lib/progress-v2";
import { usePercentFormat } from "./ProgressScreenBlocks";

export function ProgressV2Overview({
  state,
  packageId,
  onOpen,
}: {
  state: ProgressV2;
  packageId: string | null;
  onOpen: (target: ProgressFeatureTarget) => void;
}) {
  const { t } = useTranslation();
  const fmt = usePercentFormat();
  const summary = computeProgressV2(state, packageId);
  const alerts = computeProgressAlerts(state, packageId);
  const hasPlan = summary.items.some((item) => item.plannedPct > 0);
  const structures = structureRows(state, packageId, t("progress.v2.road"));
  const history = state.history.filter((item) => item.packageId === packageId);
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_minmax(72px,.65fr)] gap-2">
      <div className="grid grid-cols-2 gap-1 xl:grid-cols-4">
        {summary.items
          .filter((item) => item.applicable)
          .map((item) => {
            const evaluation = evaluateProgress(item.pct, item.plannedPct, hasPlan);
            return (
              <div key={item.key} className="rounded-sm border border-border p-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-1">
                  <b className="truncate">{t(`progress.v2.items.${item.key}`)}</b>
                  <strong className="tabular-nums">{fmt(item.pct)}%</strong>
                </div>
                <div className="relative my-1 h-1.5 bg-muted">
                  <span
                    className="absolute inset-y-0 start-0"
                    style={{
                      width: `${item.pct}%`,
                      backgroundColor: progressStateColor(item.pct).color,
                    }}
                  />
                  <i
                    className="absolute inset-y-0 w-px bg-foreground"
                    style={{ insetInlineStart: `${item.plannedPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{t("progress.v2.planShort", { value: fmt(item.plannedPct) })}</span>
                  <span>{t(`progress.v2.evaluation.${evaluation}`)}</span>
                </div>
              </div>
            );
          })}
      </div>
      <div className="grid min-h-0 grid-cols-2 gap-2">
        <section className="min-h-0 overflow-hidden rounded-sm border border-border">
          <h3 className="border-b border-border px-2 py-1 text-[11px] font-bold uppercase text-primary">
            {t("progress.v2.alerts")}
          </h3>
          <ul className="h-[calc(100%-25px)] overflow-hidden px-2 py-1 text-[11px]">
            {alerts.length === 0 ? (
              <li className="text-muted-foreground">{t("progress.v2.noAlerts")}</li>
            ) : null}
            {alerts.slice(0, 8).map((alert, index) => {
              const target =
                alert.supportId && alert.bridgeId
                  ? { kind: "support" as const, bridgeId: alert.bridgeId, id: alert.supportId }
                  : alert.spanId && alert.bridgeId
                    ? { kind: "span" as const, bridgeId: alert.bridgeId, id: alert.spanId }
                    : null;
              return (
                <li
                  key={`${alert.code}-${index}`}
                  className="flex min-h-7 items-center gap-1.5 border-b border-border/50 last:border-0"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      alert.severity === 3
                        ? "bg-red-600"
                        : alert.severity === 2
                          ? "bg-amber-500"
                          : "bg-blue-500"
                    }`}
                  />
                  {target ? (
                    <button
                      type="button"
                      className="truncate text-start hover:underline"
                      onClick={() => onOpen(target)}
                    >
                      {alertText(t, alert, fmt)}
                    </button>
                  ) : (
                    <span className="truncate">{alertText(t, alert, fmt)}</span>
                  )}
                </li>
              );
            })}
            {alerts.length > 8 ? (
              <li className="py-1 text-muted-foreground">
                {t("progress.v2.moreAlerts", { count: alerts.length - 8 })}
              </li>
            ) : null}
          </ul>
        </section>
        <section className="min-h-0 overflow-hidden rounded-sm border border-border">
          <h3 className="border-b border-border px-2 py-1 text-[11px] font-bold uppercase text-primary">
            {t("progress.structures")}
          </h3>
          <div className="h-[calc(100%-25px)] overflow-hidden px-2 py-1 text-[11px]">
            {structures.slice(0, 9).map((item) => (
              <div
                key={item.id}
                className="flex min-h-7 items-center gap-2 border-b border-border/50"
              >
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <b className="tabular-nums">{fmt(item.pct)}%</b>
              </div>
            ))}
            {structures.length > 9 ? (
              <div className="py-1 text-muted-foreground">
                {t("progress.more", { count: structures.length - 9 })}
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <section className="rounded-sm border border-border px-2 py-1">
        <div className="mb-1 text-[10px] font-bold uppercase text-primary">
          {t("progress.history")}
        </div>
        <HistoryChart points={history} />
      </section>
    </div>
  );
}

function structureRows(state: ProgressV2, packageId: string | null, roadName: string) {
  const rows = bridgesInPackage(state, packageId).map((bridge) => {
    const isolated = { ...state, bridges: [bridge], road: { km: [] }, underpasses: [] };
    return { id: bridge.id, name: bridge.name, pct: computeProgressV2(isolated).overallPct };
  });
  const packageItem = state.packages.find((item) => item.id === packageId);
  const km = state.road.km.filter(
    (item) =>
      !packageItem ||
      Math.max(item.from, packageItem.fromStation) < Math.min(item.to, packageItem.toStation),
  );
  if (km.length)
    rows.unshift({
      id: "road",
      name: roadName,
      pct: computeProgressV2({ ...state, bridges: [], underpasses: [], road: { km } }, packageId)
        .overallPct,
    });
  for (const underpass of state.underpasses) {
    if (packageId && packageForStation(state.packages, underpass.station)?.id !== packageId)
      continue;
    rows.push({
      id: underpass.id,
      name: underpass.id,
      pct: computeProgressV2(
        { ...state, bridges: [], road: { km: [] }, underpasses: [underpass] },
        packageId,
      ).overallPct,
    });
  }
  return rows;
}

export function alertText(
  t: TFunction,
  alert: ProgressAlert,
  fmt: (value: number) => string,
): string {
  const translate = t as unknown as (key: string, options?: Record<string, unknown>) => string;
  const item = alert.itemKey ? translate(`progress.v2.items.${alert.itemKey}`) : "";
  return translate(`progress.v2.alert.${alert.code}`, {
    item,
    bridge: alert.bridgeId ?? "",
    support: alert.supportId ?? "",
    span: alert.spanId ?? "",
    bed: alert.bed ?? 0,
    actual: fmt(alert.actual ?? 0),
    planned: fmt(alert.planned ?? 0),
    count: alert.count ?? 0,
    total: alert.total ?? 0,
    ids: alert.ids?.join(", ") ?? "",
  });
}

function HistoryChart({ points }: { points: ProgressV2["history"] }) {
  if (points.length === 0) return <div className="text-[11px] text-muted-foreground">—</div>;
  const x = (index: number) => (points.length === 1 ? 50 : (index / (points.length - 1)) * 100);
  const y = (value: number) => 38 - (value / 100) * 36;
  const line = (key: "actual" | "planned") =>
    points.map((point, index) => `${x(index)},${y(point[key])}`).join(" ");
  return (
    <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-12 w-full" role="img">
      <polyline
        points={line("planned")}
        fill="none"
        stroke="currentColor"
        strokeDasharray="3 2"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={line("actual")}
        fill="none"
        stroke={PROGRESS_V2_COLORS.done}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
