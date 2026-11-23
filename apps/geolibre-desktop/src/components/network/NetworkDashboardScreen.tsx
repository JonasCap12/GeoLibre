import { progressDashboardFeature, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { Maximize2, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { DashboardCamera } from "../../lib/progress-dashboard-map";
import {
  collectSegments,
  fieldValues,
  isNetworkCandidate,
  layerView,
  readLayerConfig,
  segmentsBounds,
  shownIndexes,
  type NetworkColorMode,
  type NetworkSegment,
} from "../../lib/network-dashboard";
import {
  closeNetworkDashboard,
  isNetworkDashboardOpen,
  NETWORK_DASHBOARD_ATTRIBUTE,
  subscribeNetworkDashboard,
} from "../../lib/network-dashboard-screen";
import { NetworkLayersDialog } from "./NetworkLayersDialog";
import { DailyReportBoard } from "./DailyReportBoard";
import {
  dashboardView,
  dashboardRatio,
  dashboardPointerRatio,
  clampDashboardRatio,
  NETWORK_VIEW_STORAGE,
  NETWORK_RATIO_STORAGE,
  paddingBesideBoard,
  type NetworkDashboardView,
} from "../../lib/network-dashboard-layout";

/** The daily report board beside the shell's live progress map. */
export function NetworkDashboardScreen({ camera }: { camera: DashboardCamera | null }) {
  const open = useSyncExternalStore(subscribeNetworkDashboard, isNetworkDashboardOpen);
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    // MapLibre follows its container with a ResizeObserver; the event covers
    // engines that only listen to the window.
    window.dispatchEvent(new Event("resize"));
    return () => {
      root.removeAttribute(NETWORK_DASHBOARD_ATTRIBUTE);
      root.style.removeProperty("--nd-split-w");
      window.dispatchEvent(new Event("resize"));
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("[role=dialog]")) {
        closeNetworkDashboard();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return open ? <Dashboard camera={camera} /> : null;
}

function Dashboard({ camera }: { camera: DashboardCamera | null }) {
  const { t, i18n } = useTranslation();
  const km = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format,
    [i18n.language],
  );
  const narrow = useDashboardMedia("(max-width: 899px)");
  const wide = useDashboardMedia("(min-width: 1400px)");
  const [preferredView, setView] = useState<NetworkDashboardView | null>(() => {
    try {
      const saved = localStorage.getItem(NETWORK_VIEW_STORAGE);
      if (saved === "split" || saved === "report" || saved === "map") return saved;
    } catch {
      /* Storage can be disabled by the browser. */
    }
    return null;
  });
  const view = dashboardView(preferredView, narrow);
  const [ratio, setRatio] = useState(() => {
    try {
      return dashboardRatio(localStorage.getItem(NETWORK_RATIO_STORAGE));
    } catch {
      return null;
    }
  });
  const currentRatio = ratio ?? (wide ? 60 : 55);
  const ratioRef = useRef(currentRatio);
  ratioRef.current = currentRatio;
  const dragging = useRef(false);
  const [refitRevision, setRefitRevision] = useState(0);
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute(NETWORK_DASHBOARD_ATTRIBUTE, view);
    window.dispatchEvent(new Event("resize"));
  }, [view]);
  useEffect(() => {
    try {
      if (preferredView) localStorage.setItem(NETWORK_VIEW_STORAGE, preferredView);
    } catch {
      /* Optional preference. */
    }
  }, [preferredView]);
  useEffect(() => {
    const style = document.documentElement.style;
    if (ratio === null) style.removeProperty("--nd-split-w");
    else style.setProperty("--nd-split-w", `${ratio}vw`);
  }, [ratio]);
  const finishDivider = () => {
    dragging.current = false;
    try {
      localStorage.setItem(NETWORK_RATIO_STORAGE, String(ratioRef.current));
    } catch {
      /* Optional preference. */
    }
    setRefitRevision((value) => value + 1);
  };
  const layers = useAppStore((state) => state.layers);
  const [mode, setMode] = useState<NetworkColorMode>("status");
  const [layersOpen, setLayersOpen] = useState(false);

  const candidates = useMemo(() => layers.filter(isNetworkCandidate), [layers]);
  const segments = useMemo(() => collectSegments(candidates), [candidates]);
  const entries = useMemo(() => fieldValues(segments, mode), [segments, mode]);
  const colors = useMemo(
    () => new Map(entries.map((entry) => [entry.value, entry.color])),
    [entries],
  );
  useDashboardViews(candidates, segments, mode, colors);

  const fitTo = useCallback(
    (lines: readonly NetworkSegment[]) => {
      const bounds = segmentsBounds(candidates, lines);
      const map = camera?.getMap?.();
      if (!bounds) return;
      if (map) {
        map.resize();
        map.fitBounds(
          [
            [bounds[0], bounds[1]],
            [bounds[2], bounds[3]],
          ],
          {
            // In split view the report floats over the map's corner: frame the
            // lines in the part of the map that stays visible.
            padding: paddingBesideBoard(
              map.getContainer().getBoundingClientRect(),
              document
                .querySelector<HTMLElement>(".network-dashboard-board:not([hidden])")
                ?.getBoundingClientRect() ?? null,
              document.documentElement.dir === "rtl",
            ),
            maxZoom: 16,
            duration: 500,
          },
        );
      } else camera?.fitBounds(bounds);
    },
    [candidates, camera],
  );
  const userMoved = useRef(false);
  const framed = useRef<string | null>(null);
  const lastLayout = useRef<string | null>(null);
  useEffect(() => {
    const map = camera?.getMap?.();
    if (!map) return;
    const manual = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) userMoved.current = true;
    };
    map.on("movestart", manual);
    return () => {
      map.off("movestart", manual);
    };
  }, [camera]);
  useEffect(() => {
    const key = `${view}:${refitRevision}`;
    if (lastLayout.current !== key) {
      lastLayout.current = key;
      framed.current = null;
    }
    if (
      framed.current === key ||
      userMoved.current ||
      !camera ||
      segments.length === 0 ||
      view === "report"
    )
      return;
    // After the map has been resized into its cell.
    const timer = window.setTimeout(() => {
      if (userMoved.current) return;
      framed.current = key;
      fitTo(segments);
    }, 50);
    return () => window.clearTimeout(timer);
  }, [segments, view, camera, refitRevision, fitTo]);

  const hover = useLineHover(camera, candidates, segments);
  const label = (value: string) => value.trim() || t("roadNetwork.unclassified");

  return (
    <>
      <header className="network-dashboard-header flex items-center gap-2 border-b border-header bg-header px-3 text-header-foreground">
        <div className="network-dashboard-heading min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold uppercase leading-tight tracking-wide">
            {t("roadNetwork.title")}
          </h1>
          <p className="truncate text-xs opacity-80">{t("roadNetwork.subtitle")}</p>
        </div>
        <div
          role="group"
          aria-label={t("roadNetwork.view.title")}
          className="network-dashboard-view flex rounded-md border border-header-foreground/40 text-xs"
        >
          {(narrow ? (["report", "map"] as const) : (["split", "report", "map"] as const)).map(
            (value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                className={`px-2 py-1.5 font-medium ${view === value ? "bg-header-foreground text-header" : "hover:bg-header-foreground/10"}`}
                onClick={() => setView(value)}
              >
                {t(`roadNetwork.view.${value}`)}
              </button>
            ),
          )}
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
            userMoved.current = false;
            framed.current = `${view}:${refitRevision}`;
            fitTo(segments);
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

      <DailyReportBoard hidden={view === "map"} />
      {view === "split" && !narrow && (
        <div
          className="network-dashboard-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("roadNetwork.splitter")}
          tabIndex={0}
          aria-valuemin={35}
          aria-valuemax={80}
          aria-valuenow={Math.round(currentRatio)}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (!dragging.current) return;
            const value = dashboardPointerRatio(
              event.clientX,
              window.innerWidth,
              document.documentElement.dir === "rtl",
            );
            ratioRef.current = value;
            setRatio(value);
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            finishDivider();
          }}
          onPointerCancel={() => {
            if (dragging.current) finishDivider();
          }}
          onKeyDown={(event) => {
            const direction = document.documentElement.dir === "rtl" ? -1 : 1;
            let value: number;
            if (event.key === "ArrowLeft") value = currentRatio - 2 * direction;
            else if (event.key === "ArrowRight") value = currentRatio + 2 * direction;
            else if (event.key === "Home") value = 35;
            else if (event.key === "End") value = 80;
            else return;
            event.preventDefault();
            ratioRef.current = clampDashboardRatio(value);
            setRatio(ratioRef.current);
            finishDivider();
          }}
        />
      )}
      {view !== "report" && entries.length > 0 && (
        <section
          className="network-dashboard-legend rounded-md border bg-card/95 p-2 text-xs shadow-sm"
          aria-label={t(`roadNetwork.legend.${mode}`)}
        >
          <h2 className="mb-1 font-semibold">{t(`roadNetwork.legend.${mode}`)}</h2>
          <ul className="space-y-1">
            {entries.map((entry) => (
              <li key={entry.value} className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-5 shrink-0 rounded-full"
                  style={{ background: colors.get(entry.value) }}
                />
                <span className="min-w-0 flex-1 truncate">{label(entry.value)}</span>
                <span className="tabular-nums text-muted-foreground">{km(entry.km)} km</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view !== "report" && segments.length === 0 && (
        <div className="network-dashboard-empty pointer-events-none flex items-center justify-center p-6">
          <div className="pointer-events-auto max-w-sm rounded-lg border bg-card p-4 text-center text-sm shadow-lg">
            <p className="font-semibold">{t("roadNetwork.empty.title")}</p>
            <p className="mt-1 text-muted-foreground">
              {candidates.length === 0
                ? t("roadNetwork.empty.noLines")
                : t("roadNetwork.empty.noneIncluded")}
            </p>
            <Button size="sm" className="mt-3" onClick={() => setLayersOpen(true)}>
              {t("roadNetwork.layers.open")}
            </Button>
          </div>
        </div>
      )}

      {view !== "report" && hover && (
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
          {hover.segment.progress !== null && (
            <p>
              {t("roadNetwork.kpi.progress")}: {km(hover.segment.progress)}%
              {hover.segment.plan !== null &&
                ` · ${t("roadNetwork.kpi.plan")}: ${km(hover.segment.plan)}%`}
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
) {
  const applied = useRef(new Set<string>());
  useEffect(() => {
    const shown = shownIndexes(segments);
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
  }, [candidates, segments, mode, colors]);
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

function useDashboardMedia(query: string) {
  const media = useMemo(() => window.matchMedia(query), [query]);
  const subscribe = useCallback(
    (listener: () => void) => {
      media.addEventListener("change", listener);
      return () => media.removeEventListener("change", listener);
    },
    [media],
  );
  return useSyncExternalStore(subscribe, () => media.matches);
}
