import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import {
  dashboardRows,
  dashboardGroups,
  filterDashboardRows,
  reconcileDashboardFilters,
  summarizeDashboardRows,
  dashboardMapView,
  dashboardStatusCounts,
  dashboardStatus,
  dashboardYard,
  dashboardStationExtent,
  DASHBOARD_STATUS_COLORS,
  EMPTY_DASHBOARD_FILTERS,
  type DashboardFilters,
  type DashboardColorMode,
  type DashboardStatus,
} from "../../lib/progress-dashboard";
import {
  dashboardMatrix,
  dashboardStrip,
  dashboardAlertGroups,
  dashboardSchedule,
} from "../../lib/progress-dashboard-analysis";
import {
  progressReportSheets,
  downloadProgressWorkbook,
} from "../../lib/progress-dashboard-export";
import { captureDashboardMap, type DashboardCamera } from "../../lib/progress-dashboard-map";
import { PROGRESS_V2_COLORS, type ProgressFeatureTarget } from "../../lib/progress-colors";
import {
  PROGRESS_V2_ITEM_KEYS,
  type ProgressV2,
  type ProgressV2ItemKey,
} from "../../lib/progress-v2";
import { todayIso } from "../../lib/construction-progress";
import { usePercentFormat } from "./ProgressScreenBlocks";
import {
  CompactSelect,
  DashboardMatrix,
  ChainageStrip,
  HistoryCurve,
  GroupedAlerts,
} from "./ProgressDashboardViews";
import { DashboardMapViewport } from "./ProgressDashboardMap";

export function ProgressV2Dashboard({
  layer,
  state,
  packageId,
  throughDate,
  onPackage,
  onOpen,
  onFit,
  camera,
}: {
  layer: GeoLibreLayer;
  state: ProgressV2;
  packageId: string | null;
  throughDate: string;
  onPackage: (id: string | null) => void;
  onOpen: (target: ProgressFeatureTarget) => void;
  onFit: (indexes: number[]) => void;
  camera?: DashboardCamera | null;
}) {
  const { t, i18n } = useTranslation(),
    num = usePercentFormat();
  const [filters, setFilters] = useState<DashboardFilters>(EMPTY_DASHBOARD_FILTERS),
    [mode, setMode] = useState<DashboardColorMode>("status"),
    [scope, setScope] = useState(packageId),
    [fitToken, setFitToken] = useState(0);
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState(""),
    [printing, setPrinting] = useState(false),
    [printImage, setPrintImage] = useState<string | null>(null);
  const features = layer.geojson?.features;
  const allRows = useMemo(() => dashboardRows(state, packageId), [state, packageId]);
  if (scope !== packageId) {
    setScope(packageId);
    setFilters(
      reconcileDashboardFilters(
        { ...filters, packageIds: packageId ? [] : filters.packageIds },
        allRows,
      ),
    );
  }
  const rows = useMemo(() => filterDashboardRows(allRows, filters), [allRows, filters]);
  const contextRows = useMemo(
    () =>
      filterDashboardRows(allRows, {
        ...filters,
        structureIds: [],
        bridgeIds: [],
        items: [],
        station: null,
      }),
    [allRows, filters],
  );
  const matrix = useMemo(() => dashboardMatrix(state, contextRows), [state, contextRows]);
  const summary = useMemo(() => summarizeDashboardRows(state, rows), [state, rows]);
  const packages = useMemo(() => dashboardGroups(state, rows, "package"), [state, rows]);
  const schedule = useMemo(
    () => dashboardSchedule(state, packageId, throughDate || undefined),
    [state, packageId, throughDate],
  );
  const selectedWeek = throughDate ? schedule.history.at(-1) : undefined;
  const actual = selectedWeek?.actual ?? summary.overallPct,
    planned = selectedWeek?.planned ?? summary.plannedPct,
    deviation = actual - planned;
  const strip = useMemo(() => dashboardStrip(state, contextRows), [state, contextRows]);
  const alertGroups = useMemo(
    () => dashboardAlertGroups(state, rows, packageId),
    [state, rows, packageId],
  );
  const counts = useMemo(() => dashboardStatusCounts(rows), [rows]);
  const yard = useMemo(() => dashboardYard(state, rows), [state, rows]);
  const extent = useMemo(() => dashboardStationExtent(allRows), [allRows]);
  const view = useMemo(
    () => dashboardMapView(features ?? [], state, rows, mode),
    [features, state, rows, mode],
  );
  const focus = useMemo(() => {
    const filtered =
      packageId ||
      filters.packageIds?.length ||
      filters.structureIds?.length ||
      filters.bridgeIds.length ||
      filters.kinds.length ||
      filters.items.length ||
      filters.statuses.length ||
      filters.girderTypes.length ||
      filters.station;
    if (filtered || !matrix.length) return null;
    const first = matrix[0];
    return {
      name: first.name,
      indexes: dashboardMapView(features ?? [], state, first.rows, mode).indexes,
    };
  }, [packageId, filters, matrix, features, state, mode]);
  const availableStructures = useMemo(() => dashboardMatrix(state, allRows), [state, allRows]);
  const girderTypes = useMemo(
    () => [...new Set(allRows.flatMap((r) => (r.girderType ? [r.girderType] : [])))].sort(),
    [allRows],
  );
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeZone: "UTC" }).format(
      new Date(`${value}T00:00:00Z`),
    );
  const toggle = <K extends "kinds" | "items" | "statuses" | "bridgeIds" | "girderTypes">(
    key: K,
    value: DashboardFilters[K][number],
  ) =>
    setFilters((p) => ({
      ...p,
      [key]: p[key].includes(value as never)
        ? p[key].filter((v) => v !== value)
        : [...p[key], value],
    }));
  const selectStructure = useCallback((id: string, key?: ProgressV2ItemKey) => {
    setFilters((p) => ({
      ...p,
      structureIds: [id],
      bridgeIds: [],
      items: key ? [key] : [],
      station: null,
    }));
    setFitToken((v) => v + 1);
  }, []);
  const selectedPackages = packageId ? [packageId] : (filters.packageIds ?? []);
  const togglePackage = (id: string) => {
    const next = selectedPackages.includes(id)
      ? selectedPackages.filter((value) => value !== id)
      : [...selectedPackages, id];
    onPackage(next.length === 1 ? next[0] : null);
    setFilters((p) => ({
      ...p,
      packageIds: next.length > 1 ? next : [],
      structureIds: [],
      bridgeIds: [],
      girderTypes: [],
      station: null,
    }));
  };
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
      progressDashboard: { filter: view.filter, colorExpression: view.colorExpression },
    });
  }, [layer.id, layer.progressDashboard, view]);
  useEffect(() => {
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done);
    return () => window.removeEventListener("afterprint", done);
  }, []);
  const exportWeek = async () => {
    setExporting(true);
    setError("");
    try {
      const sheets = progressReportSheets(state, rows, packageId, throughDate, t);
      await downloadProgressWorkbook(
        sheets,
        `progress-${packageId ?? "all"}-${throughDate || state.meta.reportDate}.xlsx`,
      );
    } catch {
      setError(t("progress.v2.dashboard.exportError"));
    } finally {
      setExporting(false);
    }
  };
  const print = async () => {
    setPrintImage(await captureDashboardMap(camera));
    setPrinting(true);
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
  };
  const chips = [
    ...filters.kinds.map((id) => ({
      key: `kind:${id}`,
      name: t(`progress.v2.dashboard.kinds.${id}`),
      remove: () => toggle("kinds", id),
    })),
    ...filters.items.map((id) => ({
      key: `item:${id}`,
      name: t(`progress.v2.items.${id}`),
      remove: () => toggle("items", id),
    })),
    ...filters.statuses.map((id) => ({
      key: `status:${id}`,
      name: t(`progress.v2.dashboard.statuses.${id}`),
      remove: () => toggle("statuses", id),
    })),
    ...filters.girderTypes.map((id) => ({
      key: `type:${id}`,
      name: id,
      remove: () => toggle("girderTypes", id),
    })),
    ...(filters.packageIds ?? []).map((id) => ({
      key: `package:${id}`,
      name: state.packages.find((p) => p.id === id)?.name ?? id,
      remove: () => togglePackage(id),
    })),
    ...(filters.structureIds ?? []).map((id) => ({
      key: id,
      name: availableStructures.find((s) => s.id === id)?.name ?? id,
      remove: () =>
        setFilters((p) => ({ ...p, structureIds: p.structureIds?.filter((v) => v !== id) })),
    })),
    ...filters.bridgeIds.map((id) => ({
      key: `bridge:${id}`,
      name: state.bridges.find((b) => b.id === id)?.name ?? id,
      remove: () => toggle("bridgeIds", id),
    })),
    ...(filters.station
      ? [
          {
            key: "station",
            name: `${num(filters.station[0])}–${num(filters.station[1])} m`,
            remove: () => setFilters((p) => ({ ...p, station: null })),
          },
        ]
      : []),
    ...(packageId
      ? [
          {
            key: "package",
            name: state.packages.find((p) => p.id === packageId)?.name ?? packageId,
            remove: () => onPackage(null),
          },
        ]
      : []),
  ];
  const reportDate = selectedWeek?.date ?? state.meta.reportDate;
  return (
    <div
      className="progress-dashboard-panels dashboard-v2"
      aria-label={t("progress.v2.dashboard.title")}
    >
      <aside
        className="dashboard-filters dashboard-card"
        aria-label={t("progress.v2.dashboard.filters")}
      >
        <div className="dashboard-filter-controls">
          <strong>{t("progress.v2.dashboard.filters")}</strong>
          <CompactSelect
            label={t("progress.v2.dashboard.kind")}
            options={(["bridge", "road", "underpass"] as const).map((id) => ({
              id,
              name: t(`progress.v2.dashboard.kinds.${id}`),
            }))}
            selected={filters.kinds}
            onToggle={(id) => toggle("kinds", id as DashboardFilters["kinds"][number])}
          />
          <CompactSelect
            label={t("progress.items")}
            options={PROGRESS_V2_ITEM_KEYS.map((id) => ({
              id,
              name: t(`progress.v2.items.${id}`),
            }))}
            selected={filters.items}
            onToggle={(id) => toggle("items", id as ProgressV2ItemKey)}
          />
          <CompactSelect
            label={t("progress.v2.dashboard.status")}
            options={(Object.keys(counts) as DashboardStatus[]).map((id) => ({
              id,
              name: t(`progress.v2.dashboard.statuses.${id}`),
            }))}
            selected={filters.statuses}
            onToggle={(id) => toggle("statuses", id as DashboardStatus)}
          />
          <CompactSelect
            label={t("progress.v2.dashboard.structure")}
            options={availableStructures.map((s) => ({ id: s.id, name: s.name }))}
            selected={filters.structureIds ?? []}
            onToggle={(id) =>
              setFilters((p) => ({
                ...p,
                structureIds: p.structureIds?.includes(id)
                  ? p.structureIds.filter((v) => v !== id)
                  : [...(p.structureIds ?? []), id],
              }))
            }
          />
          <CompactSelect
            label={t("progress.v2.dashboard.girderTypes")}
            options={girderTypes.map((id) => ({ id, name: id }))}
            selected={filters.girderTypes}
            onToggle={(id) => toggle("girderTypes", id)}
          />
          <CompactSelect
            label={t("progress.v2.dashboard.packageFilter")}
            options={state.packages.map((p) => ({ id: p.id, name: p.name }))}
            selected={selectedPackages}
            onToggle={togglePackage}
          />
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY_DASHBOARD_FILTERS);
              onPackage(null);
            }}
          >
            {t("progress.v2.dashboard.clear")}
          </button>
          <button type="button" disabled={exporting} onClick={() => void exportWeek()}>
            {t("progress.v2.dashboard.exportWeek")}
          </button>
          <button type="button" onClick={() => void print()}>
            {t("progress.v2.dashboard.print")}
          </button>
        </div>
        <div
          className="dashboard-filter-chips"
          aria-label={t("progress.v2.dashboard.activeFilters")}
        >
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.remove}
              aria-label={t("progress.v2.dashboard.removeFilter", { name: chip.name })}
            >
              {chip.name} ×
            </button>
          ))}
          {error ? <span role="alert">{error}</span> : null}
        </div>
      </aside>
      <div className="dashboard-kpis">
        <Kpi label={t("progress.actual")} value={`${num(actual)}%`} />
        <Kpi label={t("progress.planned")} value={`${num(planned)}%`} />
        <Kpi
          label={t("progress.deviation")}
          value={`${deviation >= 0 ? "+" : ""}${num(deviation)}%`}
          tone={deviation < -0.5 ? "behind" : "ahead"}
        />
        <Kpi
          label={t("progress.v2.dashboard.spi")}
          value={
            planned > 0
              ? new Intl.NumberFormat(i18n.language, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(actual / planned)
              : "—"
          }
        />
        <Kpi
          label={t("progress.v2.dashboard.forecast")}
          value={
            schedule.forecast
              ? date(schedule.forecast)
              : t("progress.v2.dashboard.insufficientHistory")
          }
        />
        <Kpi
          label={t("progress.v2.dashboard.days")}
          value={
            schedule.days === null ? "—" : `${schedule.days >= 0 ? "+" : ""}${num(schedule.days)}`
          }
          tone={schedule.days !== null && schedule.days < 0 ? "behind" : "ahead"}
        />
        <Kpi label={t("progress.v2.dashboard.reportDate")} value={date(reportDate)} />
      </div>
      <div className="dashboard-main-row">
        <DashboardMapViewport
          layer={layer}
          camera={camera}
          view={view}
          focus={focus}
          mode={mode}
          onMode={setMode}
          onFit={onFit}
          fitToken={fitToken}
          printImage={printImage}
        />
        <DashboardMatrix
          structures={matrix}
          selected={filters.structureIds ?? []}
          items={filters.items}
          onSelect={selectStructure}
          printing={printing}
        />
      </div>
      <ChainageStrip
        segments={strip}
        extent={extent}
        station={filters.station}
        onBrush={(station) => setFilters((p) => ({ ...p, station }))}
      />
      <div className="dashboard-insights">
        <Card title={t("progress.v2.dashboard.sCurve")} className="dashboard-history">
          <div className="dashboard-chart-key">
            <span>● {t("progress.actual")}</span>
            <span>● {t("progress.planned")}</span>
            <span>┄ {t("progress.v2.dashboard.forecast")}</span>
          </div>
          <HistoryCurve schedule={schedule} today={todayIso()} />
          <p className="dashboard-history-note">{t("progress.v2.dashboard.historyScope")}</p>
        </Card>
        <Card title={t("progress.v2.dashboard.delays")}>
          <GroupedAlerts groups={alertGroups} onSelect={selectStructure} onOpen={onOpen} />
        </Card>
        <Card title={t("progress.v2.dashboard.itemsChart")}>
          <div className="dashboard-scroll">
            <section aria-label={t("progress.v2.dashboard.packagesChart")}>
              <h3>{t("progress.v2.dashboard.packagesChart")}</h3>
              {packages.map((group) => (
                <Bars
                  key={group.id}
                  name={group.name}
                  actual={group.overallPct}
                  planned={group.plannedPct}
                  active={selectedPackages.includes(group.id)}
                  onClick={() => togglePackage(group.id)}
                />
              ))}
            </section>
            {summary.items
              .filter((i) => i.applicable)
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
          </div>
        </Card>
        <Card title={t("progress.v2.dashboard.yardChart")}>
          <div className="dashboard-scroll">
            {yard.map((entry) => {
              const total = Math.max(1, entry.total),
                segments = [
                  {
                    count: entry.onBed,
                    color: PROGRESS_V2_COLORS.girder[2],
                    name: t("progress.v2.dashboard.yard.onBed"),
                  },
                  {
                    count: entry.ready,
                    color: PROGRESS_V2_COLORS.girder[4],
                    name: t("progress.v2.dashboard.yard.ready"),
                  },
                  {
                    count: entry.erected,
                    color: PROGRESS_V2_COLORS.girder[5],
                    name: t("progress.v2.dashboard.yard.erected"),
                  },
                  {
                    count: entry.total - entry.onBed - entry.ready - entry.erected,
                    color: PROGRESS_V2_COLORS.empty,
                    name: t("progress.v2.dashboard.yard.notStarted"),
                  },
                ];
              return (
                <button
                  className="dashboard-yard"
                  key={entry.type}
                  type="button"
                  onClick={() => toggle("girderTypes", entry.type)}
                  aria-pressed={filters.girderTypes.includes(entry.type)}
                >
                  <b>{entry.type}</b>
                  <span>
                    {t("progress.v2.dashboard.castCount", { count: entry.cast })} ·{" "}
                    {t("progress.v2.dashboard.remainingCount", { count: entry.remaining })}
                  </span>
                  <span className="dashboard-yard-stack">
                    {segments.map((s) => (
                      <span
                        key={s.name}
                        style={{ width: `${(s.count / total) * 100}%`, background: s.color }}
                        title={`${s.name}: ${s.count}`}
                      />
                    ))}
                  </span>
                </button>
              );
            })}
            <p className="dashboard-history-note">{t("progress.v2.dashboard.yardNote")}</p>
            <h3>{t("progress.v2.dashboard.statusChart")}</h3>
            <StatusPie counts={counts} onSelect={(status) => toggle("statuses", status)} />
            <div className="dashboard-status-key">
              {(Object.keys(counts) as DashboardStatus[]).map((status) => (
                <button key={status} type="button" onClick={() => toggle("statuses", status)}>
                  <i style={{ background: DASHBOARD_STATUS_COLORS[status] }} />
                  {t(`progress.v2.dashboard.statuses.${status}`)} {num(counts[status])}
                </button>
              ))}
            </div>
          </div>
        </Card>
      </div>
      <p className="dashboard-print-note">
        {state.meta.title} · {t("progress.v2.dashboard.detailsAsOf")}: {date(state.meta.reportDate)}{" "}
        · {chips.map((c) => c.name).join(" · ")}
      </p>
    </div>
  );
}
function Kpi({ label, value, tone }: { label: string; value: string; tone?: "behind" | "ahead" }) {
  return (
    <div className="dashboard-card dashboard-kpi">
      <span>{label}</span>
      <strong className={tone ? `dashboard-${tone}` : ""}>{value}</strong>
    </div>
  );
}
function Card({
  title,
  children,
  className = "",
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`dashboard-card dashboard-insight ${className}`}>
      <h2>{title}</h2>
      {children}
    </section>
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
