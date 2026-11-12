import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  DASHBOARD_DEVIATION_COLORS,
  DASHBOARD_STATUS_COLORS,
  EMPTY_DASHBOARD_FILTERS,
  dashboardAlerts,
  dashboardAlertRows,
  dashboardGroups,
  dashboardHistory,
  dashboardMapView,
  dashboardQuantities,
  dashboardRows,
  dashboardStationExtent,
  dashboardStatusCounts,
  dashboardStatus,
  dashboardYard,
  filterDashboardRows,
  reconcileDashboardFilters,
  forecastDashboardCompletion,
  summarizeDashboardRows,
  type DashboardColorMode,
  type DashboardFilters,
  type DashboardStatus,
} from "../../lib/progress-dashboard";
import { PROGRESS_V2_ITEM_KEYS, type ProgressV2 } from "../../lib/progress-v2";
import { PROGRESS_V2_COLORS, type ProgressFeatureTarget } from "../../lib/progress-colors";
import { alertText } from "./ProgressV2Overview";

export function ProgressV2Dashboard({
  layer,
  state,
  packageId,
  throughDate,
  onPackage,
  onOpen,
  onFit,
}: {
  layer: GeoLibreLayer;
  state: ProgressV2;
  packageId: string | null;
  throughDate: string;
  onPackage: (id: string | null) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
  onFit: (indexes: number[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const panelsRef = useRef<HTMLDivElement>(null);
  const mapSlotRef = useRef<HTMLElement>(null);
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS);
  const [mode, setMode] = useState<DashboardColorMode>("status");
  const features = layer.geojson?.features;
  const allRows = useMemo(() => dashboardRows(state, packageId), [state, packageId]);
  const [filterScope, setFilterScope] = useState(packageId);
  if (filterScope !== packageId) {
    setFilterScope(packageId);
    setFilters(reconcileDashboardFilters(filters, allRows));
  }
  const rows = useMemo(() => filterDashboardRows(allRows, filters), [allRows, filters]);
  const summary = useMemo(() => summarizeDashboardRows(state, rows), [state, rows]);
  const quantities = useMemo(() => dashboardQuantities(state, rows), [state, rows]);
  const groups = useMemo(
    () => dashboardGroups(state, rows, packageId ? "bridge" : "package"),
    [state, rows, packageId],
  );
  const history = useMemo(
    () => dashboardHistory(state, packageId, throughDate || undefined),
    [state, packageId, throughDate],
  );
  const forecast = useMemo(() => forecastDashboardCompletion(history), [history]);
  const counts = useMemo(() => dashboardStatusCounts(rows), [rows]);
  const yard = useMemo(() => dashboardYard(state, rows), [state, rows]);
  const alerts = useMemo(() => dashboardAlerts(state, packageId, rows), [state, packageId, rows]);
  const extent = useMemo(() => dashboardStationExtent(allRows), [allRows]);
  const view = useMemo(
    () => dashboardMapView(features ?? [], state, rows, mode),
    [features, state, rows, mode],
  );
  const delayed = useMemo(
    () =>
      [...rows]
        .filter((row) => dashboardStatus(row.pct, row.planned) === "late")
        .sort((a, b) => a.pct - a.planned - (b.pct - b.planned))
        .slice(0, 10),
    [rows],
  );
  const nf = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  const num = (value: number) => nf.format(value);
  const pct = (value: number) =>
    new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 1 }).format(
      value / 100,
    );
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00Z`),
    );
  const toggle = <K extends "kinds" | "items" | "statuses" | "bridgeIds" | "girderTypes">(
    key: K,
    value: DashboardFilters[K][number],
  ) =>
    setFilters((previous) => ({
      ...previous,
      [key]: previous[key].includes(value as never)
        ? previous[key].filter((item) => item !== value)
        : [...previous[key], value],
    }));

  useEffect(() => {
    document.documentElement.setAttribute("data-progress-dashboard", "");
    window.dispatchEvent(new Event("resize"));
    return () => {
      document.documentElement.removeAttribute("data-progress-dashboard");
      useAppStore.getState().updateLayer(layer.id, { progressDashboard: undefined });
      window.dispatchEvent(new Event("resize"));
    };
  }, [layer.id]);
  useEffect(() => {
    if (
      layer.progressDashboard?.filter === view.filter &&
      layer.progressDashboard.colorExpression === view.colorExpression
    )
      return;
    useAppStore.getState().updateLayer(layer.id, {
      progressDashboard: {
        filter: view.filter,
        colorExpression: view.colorExpression,
      },
    });
  }, [layer.id, layer.progressDashboard, view]);

  useEffect(() => {
    const panels = panelsRef.current,
      slot = mapSlotRef.current;
    if (!panels || !slot) return;
    const measure = () => {
      const rect = slot.getBoundingClientRect();
      const root = document.documentElement;
      root.style.setProperty("--dashboard-map-top", `${rect.top + 76}px`);
      root.style.setProperty("--dashboard-map-h", `${Math.max(220, rect.height - 76)}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panels);
    observer.observe(slot);
    panels.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      panels.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      document.documentElement.style.removeProperty("--dashboard-map-top");
      document.documentElement.style.removeProperty("--dashboard-map-h");
    };
  }, []);

  const kpis = (
    <>
      <Kpi label={t("progress.actual")} value={pct(summary.overallPct)} />
      <Kpi label={t("progress.planned")} value={pct(summary.plannedPct)} />
      <Kpi
        label={t("progress.deviation")}
        value={pct(summary.deviation)}
        late={dashboardStatus(summary.overallPct, summary.plannedPct) === "late"}
      />
      <Kpi
        label={t("progress.v2.dashboard.criticalAlerts")}
        value={num(alerts.filter((alert) => alert.severity === 3).length)}
        late={alerts.some((alert) => alert.severity === 3)}
      />
      <Kpi
        label={t("progress.v2.dashboard.forecast")}
        value={forecast ? date(forecast) : t("progress.v2.dashboard.insufficientHistory")}
      />
    </>
  );
  const selectedWeek = throughDate ? history.find((point) => point.date === throughDate) : null;
  return (
    <div
      ref={panelsRef}
      className="progress-dashboard-panels text-foreground"
      aria-label={t("progress.v2.dashboard.title")}
    >
      <aside className="progress-dashboard-filters border-border bg-background p-3">
        <details open>
          <summary className="mb-3 cursor-pointer font-bold">
            {t("progress.v2.dashboard.filters")}
          </summary>
          <button
            className="mb-3 w-full rounded border border-border p-2 text-xs hover:bg-muted"
            type="button"
            onClick={() => {
              setFilters(EMPTY_DASHBOARD_FILTERS);
              onPackage(null);
            }}
          >
            {t("progress.v2.dashboard.clear")}
          </button>
          <FilterGroup title={t("progress.v2.dashboard.kind")}>
            {(["bridge", "road", "underpass"] as const).map((kind) => (
              <Check
                key={kind}
                label={t(`progress.v2.dashboard.kinds.${kind}`)}
                checked={filters.kinds.includes(kind)}
                onChange={() => toggle("kinds", kind)}
              />
            ))}
          </FilterGroup>
          <FilterGroup title={t("progress.v2.tabs.items")}>
            {PROGRESS_V2_ITEM_KEYS.map((key) => (
              <Check
                key={key}
                label={t(`progress.v2.items.${key}`)}
                checked={filters.items.includes(key)}
                onChange={() => toggle("items", key)}
              />
            ))}
          </FilterGroup>
          <FilterGroup title={t("progress.v2.dashboard.status")}>
            {(Object.keys(counts) as DashboardStatus[]).map((key) => (
              <Check
                key={key}
                label={t(`progress.v2.dashboard.statuses.${key}`)}
                checked={filters.statuses.includes(key)}
                onChange={() => toggle("statuses", key)}
              />
            ))}
          </FilterGroup>
          {extent ? (
            <FilterGroup title={t("progress.v2.dashboard.station")}>
              {([0, 1] as const).map((end) => (
                <label key={end} className="block text-xs">
                  {t(end === 0 ? "progress.v2.dashboard.from" : "progress.v2.dashboard.to")}:{" "}
                  {num((filters.station ?? extent)[end])}
                  <input
                    className="block w-full accent-primary"
                    type="range"
                    min={extent[0]}
                    max={extent[1]}
                    step="1"
                    aria-label={t(
                      end === 0 ? "progress.v2.dashboard.from" : "progress.v2.dashboard.to",
                    )}
                    value={(filters.station ?? extent)[end]}
                    onChange={(event) =>
                      setFilters((previous) => {
                        const station: [number, number] = [...(previous.station ?? extent)];
                        station[end] =
                          end === 0
                            ? Math.min(Number(event.target.value), station[1])
                            : Math.max(Number(event.target.value), station[0]);
                        return { ...previous, station };
                      })
                    }
                  />
                </label>
              ))}
            </FilterGroup>
          ) : null}
          <FilterGroup title={t("progress.v2.dashboard.bridges")}>
            {state.bridges
              .filter((bridge) => allRows.some((row) => row.bridgeId === bridge.id))
              .map((bridge) => (
                <Check
                  key={bridge.id}
                  label={bridge.name}
                  checked={filters.bridgeIds.includes(bridge.id)}
                  onChange={() => toggle("bridgeIds", bridge.id)}
                />
              ))}
          </FilterGroup>
          {filters.girderTypes.length ? (
            <FilterGroup title={t("progress.v2.dashboard.girderTypes")}>
              {filters.girderTypes.map((type) => (
                <Check
                  key={type}
                  label={type}
                  checked
                  onChange={() => toggle("girderTypes", type)}
                />
              ))}
            </FilterGroup>
          ) : null}
        </details>
      </aside>
      <section
        ref={mapSlotRef}
        className="progress-dashboard-map-toolbar flex flex-wrap items-center gap-2 rounded border border-border bg-background/95 p-2 text-xs"
      >
        <label className="flex items-center gap-2">
          {t("progress.v2.dashboard.colorMode")}
          <select
            className="min-w-0 rounded border border-border bg-background p-1"
            value={mode}
            onChange={(event) => setMode(event.target.value as DashboardColorMode)}
          >
            {(["status", "deviation", "girder"] as const).map((key) => (
              <option key={key} value={key}>
                {t(`progress.v2.dashboard.colorModes.${key}`)}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded border border-border px-2 py-1 hover:bg-muted"
          onClick={() => onFit(view.indexes)}
        >
          {t("progress.v2.dashboard.fit")}
        </button>
        <span aria-live="polite">
          {t("progress.v2.dashboard.visible", { count: view.indexes.length })}
        </span>
      </section>
      <aside className="progress-dashboard-metrics border-border bg-background p-3">
        <div className="grid gap-2">{kpis}</div>
        <section className="mt-3 rounded border border-border p-2 text-xs">
          <h3 className="mb-2 font-bold">{t("progress.v2.dashboard.quantities")}</h3>
          <Quantity
            label={t("progress.v2.items.coc")}
            value={`${num(quantities.piles.done)} / ${num(quantities.piles.total)}`}
          />
          <Quantity
            label={t("progress.v2.items.gac")}
            value={`${num(quantities.girders.done)} / ${num(quantities.girders.total)}`}
          />
          <Quantity label={t("progress.v2.dashboard.roadKm")} value={num(quantities.roadKm)} />
          <Quantity
            label={t("progress.v2.dashboard.kinds.underpass")}
            value={`${num(quantities.underpasses.done)} / ${num(quantities.underpasses.total)}`}
          />
        </section>
        <section className="mt-3 text-xs">
          <h3 className="mb-2 font-bold">{t("progress.v2.dashboard.legend")}</h3>
          {mode === "girder"
            ? PROGRESS_V2_COLORS.girder.map((color, stage) => (
                <Legend
                  key={stage}
                  color={color}
                  label={t(`progress.v2.stage.${stage as 0 | 1 | 2 | 3 | 4 | 5}`)}
                />
              ))
            : mode === "deviation"
              ? (
                  Object.keys(DASHBOARD_DEVIATION_COLORS) as Array<
                    keyof typeof DASHBOARD_DEVIATION_COLORS
                  >
                ).map((key) => (
                  <Legend
                    key={key}
                    color={DASHBOARD_DEVIATION_COLORS[key]}
                    label={t(`progress.v2.evaluation.${key}`)}
                  />
                ))
              : (Object.keys(counts) as DashboardStatus[]).map((key) => (
                  <Legend
                    key={key}
                    color={DASHBOARD_STATUS_COLORS[key]}
                    label={t(`progress.v2.dashboard.statuses.${key}`)}
                  />
                ))}
        </section>
        {!rows.length ? (
          <p className="mt-3 text-xs" role="status">
            {t("progress.v2.dashboard.empty")}
          </p>
        ) : null}
      </aside>
      <div className="progress-dashboard-charts border-border bg-muted/80 p-2">
        <Chart title={t("progress.v2.dashboard.sCurve")}>
          <p className="mb-2 text-[10px] text-muted-foreground">
            {t("progress.v2.dashboard.historyScope")}
          </p>
          {selectedWeek ? (
            <p className="mb-2 text-xs">
              {date(selectedWeek.date)} · {t("progress.actual")}: {pct(selectedWeek.actual)} ·{" "}
              {t("progress.planned")}: {pct(selectedWeek.planned)}
            </p>
          ) : null}
          <div className="mb-1 flex gap-3 text-[10px]">
            <Legend color={PROGRESS_V2_COLORS.done} label={t("progress.actual")} />
            <Legend color="#7b8ea4" label={t("progress.planned")} />
          </div>
          {history.length ? (
            <svg
              viewBox="0 0 300 110"
              className="h-28 w-full"
              role="img"
              aria-label={t("progress.v2.dashboard.sCurve")}
            >
              {[0, 50, 100].map((value) => (
                <g key={value}>
                  <line
                    x1="30"
                    x2="290"
                    y1={95 - value * 0.8}
                    y2={95 - value * 0.8}
                    stroke="currentColor"
                    opacity=".15"
                  />
                  <text x="0" y={98 - value * 0.8} fontSize="9" fill="currentColor">
                    {num(value)}
                  </text>
                </g>
              ))}
              {(["planned", "actual"] as const).map((key) => (
                <polyline
                  key={key}
                  fill="none"
                  stroke={key === "actual" ? PROGRESS_V2_COLORS.done : "#7b8ea4"}
                  strokeWidth="2"
                  strokeDasharray={key === "planned" ? "4 3" : undefined}
                  points={history
                    .map(
                      (point, index) =>
                        `${
                          history.length === 1 ? 160 : 30 + (index * 260) / (history.length - 1)
                        },${95 - point[key] * 0.8}`,
                    )
                    .join(" ")}
                />
              ))}
              {history.map((point, index) => (
                <circle
                  key={point.week}
                  cx={history.length === 1 ? 160 : 30 + (index * 260) / (history.length - 1)}
                  cy={95 - point.actual * 0.8}
                  r="3"
                  fill={PROGRESS_V2_COLORS.done}
                >
                  <title>
                    {date(point.date)}: {pct(point.actual)} / {pct(point.planned)}
                  </title>
                </circle>
              ))}
            </svg>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("progress.v2.dashboard.insufficientHistory")}
            </p>
          )}
          {history.length ? (
            <div dir="ltr" className="flex justify-between text-[10px] text-muted-foreground">
              <span>{date(history[0].date)}</span>
              <span>{date(history[history.length - 1].date)}</span>
            </div>
          ) : null}
        </Chart>
        <Chart title={t("progress.v2.dashboard.itemsChart")}>
          <BarLegend />
          {summary.items
            .filter((item) => item.applicable)
            .sort((a, b) => a.pct - a.plannedPct - (b.pct - b.plannedPct))
            .map((item) => (
              <Bars
                key={item.key}
                name={t(`progress.v2.items.${item.key}`)}
                actual={item.pct}
                planned={item.plannedPct}
                active={filters.items.includes(item.key)}
                onClick={() => toggle("items", item.key)}
              />
            ))}
        </Chart>
        <Chart
          title={t(
            packageId
              ? "progress.v2.dashboard.bridgesChart"
              : "progress.v2.dashboard.packagesChart",
          )}
        >
          <BarLegend />
          {groups.map((group) => (
            <Bars
              key={group.id}
              name={group.name}
              actual={group.overallPct}
              planned={group.plannedPct}
              onClick={() => (packageId ? toggle("bridgeIds", group.id) : onPackage(group.id))}
            />
          ))}
        </Chart>
        <Chart title={t("progress.v2.dashboard.yardChart")}>
          <p className="mb-2 text-[10px] text-muted-foreground">
            {t("progress.v2.dashboard.yardNote")}
          </p>
          {yard.map((entry) => {
            const segments = [
              { key: "onBed", count: entry.onBed, color: PROGRESS_V2_COLORS.girder[2] },
              { key: "ready", count: entry.ready, color: PROGRESS_V2_COLORS.girder[4] },
              { key: "erected", count: entry.erected, color: PROGRESS_V2_COLORS.girder[5] },
              {
                key: "notStarted",
                count: entry.total - entry.onBed - entry.ready - entry.erected,
                color: PROGRESS_V2_COLORS.girder[0],
              },
            ];
            const total = segments.reduce((sum, item) => sum + item.count, 0);
            return (
              <button
                key={entry.type}
                type="button"
                className="mb-3 block w-full text-start text-xs"
                aria-pressed={filters.girderTypes.includes(entry.type)}
                onClick={() => toggle("girderTypes", entry.type)}
              >
                <span className="flex justify-between gap-2">
                  <b>{entry.type || t("progress.v2.dashboard.unknownType")}</b>
                  <span>
                    {t("progress.v2.dashboard.castCount", { count: entry.cast })} ·{" "}
                    {t("progress.v2.dashboard.remainingCount", { count: entry.remaining })}
                  </span>
                </span>
                <svg
                  viewBox="0 0 200 18"
                  className="my-1 h-5 w-full"
                  role="img"
                  aria-label={entry.type || t("progress.v2.dashboard.unknownType")}
                >
                  {segments.map((segment, index) => (
                    <rect
                      key={segment.key}
                      x={
                        (segments.slice(0, index).reduce((sum, item) => sum + item.count, 0) /
                          Math.max(1, total)) *
                        200
                      }
                      y="0"
                      width={(segment.count / Math.max(1, total)) * 200}
                      height="18"
                      fill={segment.color}
                    >
                      <title>{num(segment.count)}</title>
                    </rect>
                  ))}
                </svg>
                <span className="flex flex-wrap gap-x-2 gap-y-1 text-[10px]">
                  {segments.map((segment) => (
                    <Legend
                      key={segment.key}
                      color={segment.color}
                      label={`${t(
                        `progress.v2.dashboard.yard.${
                          segment.key as "onBed" | "ready" | "erected" | "notStarted"
                        }`,
                      )}: ${num(segment.count)}`}
                    />
                  ))}
                </span>
              </button>
            );
          })}
        </Chart>
        <Chart title={t("progress.v2.dashboard.statusChart")}>
          <StatusPie counts={counts} onSelect={(status) => toggle("statuses", status)} />
          {(Object.keys(counts) as DashboardStatus[]).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filters.statuses.includes(key)}
              className="flex w-full items-center justify-between gap-2 rounded p-1 text-xs hover:bg-muted"
              onClick={() => toggle("statuses", key)}
            >
              <Legend
                color={DASHBOARD_STATUS_COLORS[key]}
                label={t(`progress.v2.dashboard.statuses.${key}`)}
              />
              <b>{num(counts[key])}</b>
            </button>
          ))}
        </Chart>
        <Chart title={t("progress.v2.dashboard.delays")}>
          {delayed.map((row) => (
            <button
              key={row.id}
              type="button"
              className="mb-1 flex w-full items-center justify-between gap-2 border-b border-border py-1 text-start text-xs hover:bg-muted"
              onClick={() => onOpen(row.target)}
            >
              <span className="min-w-0 truncate">
                {row.bridgeId
                  ? `${
                      state.bridges.find((bridge) => bridge.id === row.bridgeId)?.name ??
                      row.bridgeId
                    } · `
                  : ""}
                {row.target.id} · {t(`progress.v2.items.${row.key}`)}
              </span>
              <b className="shrink-0 text-red-600 dark:text-red-400">
                {pct(row.pct - row.planned)}
              </b>
            </button>
          ))}
          <h4 className="my-2 text-xs font-bold">{t("progress.v2.alerts")}</h4>
          {alerts.length ? (
            alerts.map((alert, index) => {
              const candidates = dashboardAlertRows(rows, alert);
              return (
                <button
                  key={`${alert.code}:${index}`}
                  type="button"
                  disabled={!candidates.length}
                  className="mb-1 block w-full rounded p-1 text-start text-xs hover:bg-muted disabled:opacity-60"
                  onClick={() =>
                    onFit(dashboardMapView(features ?? [], state, candidates, mode).indexes)
                  }
                >
                  <span
                    className={
                      alert.severity === 3
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-700 dark:text-amber-400"
                    }
                  >
                    {alertText(t, alert)}
                  </span>
                </button>
              );
            })
          ) : (
            <p className="text-xs text-muted-foreground">{t("progress.v2.noAlerts")}</p>
          )}
        </Chart>
      </div>
    </div>
  );
}

function Kpi({ label, value, late }: { label: string; value: string; late?: boolean }) {
  return (
    <div className="min-w-0 rounded border border-border bg-card p-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <strong
        className={`break-words text-xl tabular-nums ${
          late ? "text-red-600 dark:text-red-400" : "text-foreground"
        }`}
      >
        {value}
      </strong>
    </div>
  );
}
function Quantity({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2 py-1">
      <span>{label}</span>
      <b dir="ltr" className="shrink-0 tabular-nums">
        {value}
      </b>
    </div>
  );
}
function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm border border-black/10"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}
function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-xs">
      <input type="checkbox" className="accent-primary" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}
function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="mb-3 min-w-0 border-t border-border pt-2">
      <legend className="pe-2 text-xs font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}
function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="min-h-0 min-w-0 overflow-y-auto rounded border border-border bg-card p-3">
      <h3 className="mb-2 text-xs font-bold">{title}</h3>
      {children}
    </section>
  );
}
function BarLegend() {
  const { t } = useTranslation();
  return (
    <div className="mb-2 flex gap-3 text-[10px]">
      <Legend color={PROGRESS_V2_COLORS.done} label={t("progress.actual")} />
      <Legend color="#7b8ea4" label={t("progress.planned")} />
    </div>
  );
}
function Bars({
  name,
  actual,
  planned,
  active,
  onClick,
}: {
  name: string;
  actual: number;
  planned: number;
  active?: boolean;
  onClick: () => void;
}) {
  const { i18n } = useTranslation();
  const pct = (value: number) =>
    new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 1 }).format(
      value / 100,
    );
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`mb-2 block w-full rounded p-1 text-start text-[11px] hover:bg-muted ${
        active ? "ring-1 ring-primary" : ""
      }`}
      onClick={onClick}
    >
      <span className="flex justify-between gap-2">
        <span className="truncate">{name}</span>
        <span dir="ltr" className="shrink-0 tabular-nums">
          {pct(actual)} / {pct(planned)}
        </span>
      </span>
      <svg
        viewBox="0 0 100 8"
        preserveAspectRatio="none"
        className="mt-1 h-3 w-full"
        aria-hidden="true"
      >
        <rect width="100" height="8" fill="currentColor" opacity=".06" />
        <rect
          width={actual}
          height="4"
          fill={
            dashboardStatus(actual, planned) === "late"
              ? DASHBOARD_STATUS_COLORS.late
              : PROGRESS_V2_COLORS.done
          }
        />
        <rect y="5" width={planned} height="3" fill="#7b8ea4" />
      </svg>
    </button>
  );
}
function StatusPie({
  counts,
  onSelect,
}: {
  counts: Record<DashboardStatus, number>;
  onSelect: (status: DashboardStatus) => void;
}) {
  const { t, i18n } = useTranslation();
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  let start = 0;
  return (
    <svg
      viewBox="0 0 120 120"
      className="mx-auto mb-2 h-28 w-28"
      role="img"
      aria-label={t("progress.v2.dashboard.statusChart")}
    >
      {(Object.keys(counts) as DashboardStatus[]).map((status) => {
        const fraction = counts[status] / Math.max(1, total),
          offset = start;
        start += fraction;
        if (!fraction) return null;
        return (
          <circle
            key={status}
            cx="60"
            cy="60"
            r="42"
            fill="none"
            stroke={DASHBOARD_STATUS_COLORS[status]}
            strokeWidth="20"
            pathLength="100"
            strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`}
            strokeDashoffset={-offset * 100}
            transform="rotate(-90 60 60)"
            role="button"
            tabIndex={0}
            aria-label={t(`progress.v2.dashboard.statuses.${status}`)}
            className="cursor-pointer"
            onClick={() => onSelect(status)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(status);
              }
            }}
          >
            <title>
              {t(`progress.v2.dashboard.statuses.${status}`)}:{" "}
              {new Intl.NumberFormat(i18n.language).format(counts[status])}
            </title>
          </circle>
        );
      })}
      <text x="60" y="65" textAnchor="middle" className="fill-foreground" fontSize="18">
        {new Intl.NumberFormat(i18n.language).format(total)}
      </text>
    </svg>
  );
}
