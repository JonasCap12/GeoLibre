import { progressDashboardFeature, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { Maximize2, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { DashboardCamera } from "../../lib/progress-dashboard-map";
import {
  categoryColors,
  collectSegments,
  fieldValues,
  isNetworkCandidate,
  layerView,
  NO_FILTERS,
  passesFilters,
  readLayerConfig,
  segmentsBounds,
  shownIndexes,
  summarize,
  yearBounds,
  type NetworkColorMode,
  type NetworkFilters,
  type NetworkSegment,
} from "../../lib/network-dashboard";
import {
  closeNetworkDashboard,
  isNetworkDashboardOpen,
  NETWORK_DASHBOARD_ATTRIBUTE,
  subscribeNetworkDashboard,
} from "../../lib/network-dashboard-screen";
import { NetworkLayersDialog } from "./NetworkLayersDialog";
import { BarList, CategoryFilter, YearBars, useKmFormat } from "./NetworkDashboardBlocks";

/**
 * Full-page road and bridge network dashboard: filters on the start side, the
 * map in the middle, the legend and the total kilometres on the end side, and
 * the charts under the map. While it is open, `data-network-dashboard` on the
 * document element makes `index.css` pin the shell's map into the middle cell,
 * so it is the same live map with the same layers.
 */
export function NetworkDashboardScreen({ camera }: { camera: DashboardCamera | null }) {
  const open = useSyncExternalStore(subscribeNetworkDashboard, isNetworkDashboardOpen);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.setAttribute(NETWORK_DASHBOARD_ATTRIBUTE, "");
    // MapLibre follows its container with a ResizeObserver; the event covers
    // engines that only listen to the window.
    window.dispatchEvent(new Event("resize"));
    return () => {
      root.removeAttribute(NETWORK_DASHBOARD_ATTRIBUTE);
      window.dispatchEvent(new Event("resize"));
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog]"))
        closeNetworkDashboard();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return open ? <Dashboard camera={camera} /> : null;
}

function Dashboard({ camera }: { camera: DashboardCamera | null }) {
  const { t } = useTranslation();
  const km = useKmFormat();
  const layers = useAppStore((state) => state.layers);
  const [mode, setMode] = useState<NetworkColorMode>("status");
  const [filters, setFilters] = useState<NetworkFilters>(NO_FILTERS);
  const [layersOpen, setLayersOpen] = useState(false);

  const candidates = useMemo(() => layers.filter(isNetworkCandidate), [layers]);
  const segments = useMemo(() => collectSegments(candidates), [candidates]);
  // Colours come from the whole network, so filtering never repaints a line.
  const statusValues = useMemo(() => fieldValues(segments, "status"), [segments]);
  const typeValues = useMemo(() => fieldValues(segments, "type"), [segments]);
  const colors = useMemo(
    () =>
      categoryColors(
        mode,
        (mode === "status" ? statusValues : typeValues).map((entry) => entry.value),
      ),
    [mode, statusValues, typeValues],
  );
  const summary = useMemo(
    () => summarize(segments, mode, filters, colors),
    [segments, mode, filters, colors],
  );
  const years = useMemo(() => yearBounds(segments), [segments]);
  const hasStatus = statusValues.some((entry) => entry.value !== "");
  const hasType = typeValues.some((entry) => entry.value !== "");

  useDashboardViews(candidates, segments, mode, colors, filters);

  const fitTo = (shown: readonly NetworkSegment[]) => {
    const bounds = segmentsBounds(candidates, shown);
    const map = camera?.getMap?.();
    if (!bounds) return;
    if (map) {
      map.resize();
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        { padding: 40, maxZoom: 14, duration: 400 },
      );
    } else camera?.fitBounds(bounds);
  };
  // Frame the whole network once, when the dashboard opens.
  const framed = useRef(false);
  useEffect(() => {
    if (framed.current || segments.length === 0) return;
    framed.current = true;
    // After the map has been resized into its cell.
    const timer = window.setTimeout(() => fitTo(segments), 50);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first lines
  }, [segments]);

  const hover = useLineHover(camera, candidates, segments);
  const filtered = filters !== NO_FILTERS;

  return (
    <>
      <header className="network-dashboard-header flex items-center gap-3 border-b border-header bg-header px-4 text-header-foreground">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold uppercase leading-tight tracking-wide">
            {t("roadNetwork.title")}
          </h1>
          <p className="truncate text-xs opacity-80">{t("roadNetwork.subtitle")}</p>
        </div>
        <div
          role="radiogroup"
          aria-label={t("roadNetwork.colorBy")}
          className="flex overflow-hidden rounded-md border border-header-foreground/40 text-xs"
        >
          {(["status", "type"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              className={`px-3 py-1.5 font-medium ${
                mode === value
                  ? "bg-header-foreground text-header"
                  : "hover:bg-header-foreground/10"
              }`}
              onClick={() => setMode(value)}
            >
              {t(`roadNetwork.mode.${value}`)}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            const shown = segments.filter((segment) => passesFilters(segment, filters));
            fitTo(shown.length > 0 ? shown : segments);
          }}
          disabled={segments.length === 0}
        >
          <Maximize2 className="h-3.5 w-3.5 lg:me-1.5" />
          <span className="sr-only lg:not-sr-only">{t("roadNetwork.fitAll")}</span>
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setLayersOpen(true)}>
          <Settings2 className="h-3.5 w-3.5 lg:me-1.5" />
          <span className="sr-only lg:not-sr-only">{t("roadNetwork.layers.open")}</span>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="text-header-foreground hover:bg-header-foreground/10"
          aria-label={t("roadNetwork.close")}
          onClick={closeNetworkDashboard}
        >
          <X className="h-5 w-5" />
        </Button>
      </header>

      <div className="network-dashboard-body">
        <aside className="network-dashboard-start space-y-4 overflow-y-auto border-e bg-card p-3 text-sm">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("roadNetwork.filters")}</h2>
            {filtered && (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setFilters(NO_FILTERS)}
              >
                {t("roadNetwork.clearFilters")}
              </button>
            )}
          </div>
          {hasStatus && (
            <CategoryFilter
              title={t("roadNetwork.mode.status")}
              entries={statusValues}
              colors={mode === "status" ? colors : null}
              selected={filters.statuses}
              onChange={(statuses) => setFilters({ ...filters, statuses })}
            />
          )}
          {hasType && (
            <CategoryFilter
              title={t("roadNetwork.mode.type")}
              entries={typeValues}
              colors={mode === "type" ? colors : null}
              selected={filters.types}
              onChange={(types) => setFilters({ ...filters, types })}
            />
          )}
          {years && (
            <YearRange
              bounds={years}
              value={filters.years}
              onChange={(range) => setFilters({ ...filters, years: range })}
            />
          )}
          {!hasStatus && !hasType && !years && segments.length > 0 && (
            <p className="text-xs text-muted-foreground">{t("roadNetwork.noFields")}</p>
          )}
        </aside>

        <aside className="network-dashboard-end space-y-4 overflow-y-auto border-s bg-card p-3 text-sm">
          <section className="rounded-lg border bg-background p-3 text-center">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("roadNetwork.totalKm")}
            </h2>
            <p className="text-4xl font-bold tabular-nums text-primary">{km(summary.totalKm)}</p>
            <p className="text-xs text-muted-foreground">
              {t("roadNetwork.lineCount", { count: summary.lineCount })}
            </p>
          </section>
          <section>
            <h2 className="mb-2 font-semibold">{t(`roadNetwork.legend.${mode}`)}</h2>
            {summary.byColor.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("roadNetwork.empty.filtered")}</p>
            ) : (
              <ul className="space-y-1.5">
                {summary.byColor.map((entry) => (
                  <li key={entry.value} className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-6 shrink-0 rounded-full"
                      style={{ background: entry.color }}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {entry.value.trim() || t("roadNetwork.unclassified")}
                    </span>
                    <span className="tabular-nums text-muted-foreground">{km(entry.km)} km</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>

        <section
          className="network-dashboard-strip grid gap-3 overflow-y-auto border-t bg-card p-3"
          aria-label={t("roadNetwork.charts")}
        >
          <figure className="min-w-0 rounded-lg border bg-background p-3">
            <figcaption className="mb-2 text-sm font-semibold">
              {t("roadNetwork.chart.byYear")}
            </figcaption>
            {summary.byYear.length > 0 ? (
              <YearBars data={summary.byYear} format={km} />
            ) : (
              <p className="text-xs text-muted-foreground">{t("roadNetwork.chart.noYear")}</p>
            )}
          </figure>
          <figure className="min-w-0 rounded-lg border bg-background p-3">
            <figcaption className="mb-2 text-sm font-semibold">
              {t(`roadNetwork.chart.by.${mode}`)}
            </figcaption>
            <BarList
              entries={summary.byColor.map((entry) => ({
                label: entry.value.trim() || t("roadNetwork.unclassified"),
                color: entry.color,
                value: entry.km,
              }))}
              format={km}
            />
          </figure>
        </section>
      </div>

      {segments.length === 0 && (
        <div className="network-dashboard-empty pointer-events-none flex items-center justify-center p-6">
          <div className="pointer-events-auto max-w-sm rounded-lg border bg-card p-4 text-center text-sm shadow-lg">
            <p className="font-semibold">{t("roadNetwork.empty.title")}</p>
            <p className="mt-1 text-muted-foreground">
              {candidates.length === 0
                ? t("roadNetwork.empty.noLines")
                : t("roadNetwork.empty.noneIncluded")}
            </p>
            {candidates.length > 0 && (
              <Button size="sm" className="mt-3" onClick={() => setLayersOpen(true)}>
                {t("roadNetwork.layers.open")}
              </Button>
            )}
          </div>
        </div>
      )}

      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-xs rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
          style={{ left: hover.x + 12, top: hover.y + 12 }}
        >
          <p className="font-semibold">{hover.segment.name}</p>
          {hover.segment.status.trim() && (
            <p>
              {t("roadNetwork.mode.status")}: {hover.segment.status.trim()}
            </p>
          )}
          {hover.segment.type.trim() && (
            <p>
              {t("roadNetwork.mode.type")}: {hover.segment.type.trim()}
            </p>
          )}
          {hover.segment.year !== null && (
            <p>
              {t("roadNetwork.year")}: {hover.segment.year}
            </p>
          )}
          <p>{km(hover.segment.km)} km</p>
        </div>
      )}

      <NetworkLayersDialog open={layersOpen} onOpenChange={setLayersOpen} layers={candidates} />
    </>
  );
}

/** Start and end year pickers. */
function YearRange({
  bounds,
  value,
  onChange,
}: {
  bounds: [number, number];
  value: readonly [number, number] | null;
  onChange: (range: [number, number] | null) => void;
}) {
  const { t } = useTranslation();
  const [from, to] = value ?? bounds;
  const years: number[] = [];
  for (let year = bounds[0]; year <= bounds[1]; year += 1) years.push(year);
  const set = (next: [number, number]) => {
    const range: [number, number] = [Math.min(...next), Math.max(...next)];
    onChange(range[0] === bounds[0] && range[1] === bounds[1] ? null : range);
  };
  const select = "h-8 w-full rounded-md border bg-background px-2 text-sm";
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("roadNetwork.yearRange")}
      </legend>
      <div className="flex items-center gap-2">
        <select
          aria-label={t("roadNetwork.yearFrom")}
          className={select}
          value={from}
          onChange={(event) => set([Number(event.target.value), to])}
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
        <span aria-hidden="true">–</span>
        <select
          aria-label={t("roadNetwork.yearTo")}
          className={select}
          value={to}
          onChange={(event) => set([from, Number(event.target.value)])}
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year}
            </option>
          ))}
        </select>
      </div>
    </fieldset>
  );
}

/**
 * Keeps each included layer's transient renderer view in step with the
 * dashboard, and clears the views it set when the dashboard closes. The views
 * are excluded from saving and undo, so this never marks the project changed.
 */
function useDashboardViews(
  candidates: readonly GeoLibreLayer[],
  segments: readonly NetworkSegment[],
  mode: NetworkColorMode,
  colors: ReadonlyMap<string, string>,
  filters: NetworkFilters,
) {
  const applied = useRef(new Set<string>());
  useEffect(() => {
    const shown = shownIndexes(segments, filters);
    const store = useAppStore.getState();
    for (const layer of candidates) {
      const config = readLayerConfig(layer);
      const view = config.included
        ? layerView(config, mode, colors, shown.get(layer.id) ?? [])
        : undefined;
      if (JSON.stringify(view) === JSON.stringify(layer.progressDashboard)) continue;
      store.updateLayer(layer.id, { progressDashboard: view });
      if (view) applied.current.add(layer.id);
      else applied.current.delete(layer.id);
    }
  }, [candidates, segments, mode, colors, filters]);
  useEffect(
    () => () => {
      const store = useAppStore.getState();
      for (const id of applied.current) {
        if (store.layers.some((layer) => layer.id === id)) {
          store.updateLayer(id, { progressDashboard: undefined });
        }
      }
      applied.current.clear();
    },
    [],
  );
}

/** The project line under the pointer, for the tooltip. */
function useLineHover(
  camera: DashboardCamera | null,
  candidates: readonly GeoLibreLayer[],
  segments: readonly NetworkSegment[],
) {
  const [hover, setHover] = useState<{ segment: NetworkSegment; x: number; y: number } | null>(
    null,
  );
  const latest = useRef({ candidates, segments });
  latest.current = { candidates, segments };
  useEffect(() => {
    const map = camera?.getMap?.();
    if (!map) return;
    const move = (event: { point: { x: number; y: number } }) => {
      const { candidates: layers, segments: lines } = latest.current;
      const sources = new Map(layers.map((layer) => [`source-${layer.id}`, layer]));
      const hit = map
        .queryRenderedFeatures([event.point.x, event.point.y])
        .find((feature) => sources.has(feature.source));
      const layer = hit ? sources.get(hit.source) : undefined;
      const original = layer ? progressDashboardFeature(layer, hit?.properties) : null;
      const segment = original
        ? lines.find((line) => line.layerId === layer?.id && line.index === original.index)
        : undefined;
      if (!segment) {
        setHover(null);
        return;
      }
      const box = map.getCanvas().getBoundingClientRect();
      setHover({ segment, x: box.x + event.point.x, y: box.y + event.point.y });
    };
    const leave = () => setHover(null);
    map.on("mousemove", move);
    map.on("mouseout", leave);
    return () => {
      map.off("mousemove", move);
      map.off("mouseout", leave);
    };
  }, [camera]);
  return hover;
}
