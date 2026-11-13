import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GeoLibreLayer } from "@geolibre/core";
import {
  fitDashboardMap,
  watchDashboardMap,
  type DashboardCamera,
} from "../../lib/progress-dashboard-map";
import type { dashboardMapView, DashboardColorMode } from "../../lib/progress-dashboard";
import { propertyText } from "../../lib/progress-colors";
import { usePercentFormat } from "./ProgressScreenBlocks";

export function DashboardMapViewport({
  layer,
  camera,
  view,
  focus,
  mode,
  onMode,
  onFit,
  fitToken,
  printImage,
}: {
  layer: GeoLibreLayer;
  camera?: DashboardCamera | null;
  view: ReturnType<typeof dashboardMapView>;
  focus: { name: string; indexes: number[] } | null;
  mode: DashboardColorMode;
  onMode: (mode: DashboardColorMode) => void;
  onFit: (indexes: number[]) => void;
  fitToken: number;
  printImage: string | null;
}) {
  const { t } = useTranslation(),
    fmt = usePercentFormat();
  const slot = useRef<HTMLElement>(null),
    latest = useRef(layer),
    manual = useRef(false),
    wholeRoute = useRef(false),
    lastToken = useRef(fitToken);
  latest.current = layer;
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const [viewingName, setViewingName] = useState<string | null>(null);
  useEffect(
    () =>
      watchDashboardMap(
        camera,
        () => latest.current,
        () => {
          manual.current = true;
          setViewingName(null);
        },
        setHover,
      ),
    [camera, layer.id],
  );
  useEffect(() => {
    if (lastToken.current !== fitToken) {
      manual.current = false;
      wholeRoute.current = false;
      lastToken.current = fitToken;
    }
    if (manual.current) return;
    let inner = 0;
    const frame = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (manual.current) return;
        const framed = wholeRoute.current ? null : focus;
        const indexes = framed?.indexes ?? view.indexes;
        if (camera) fitDashboardMap(camera, latest.current, indexes);
        else onFit(indexes);
        setViewingName(framed?.name ?? null);
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(inner);
    };
  }, [camera, onFit, view.indexes, focus, fitToken]);
  useEffect(() => {
    const el = slot.current,
      panel = el?.closest(".progress-dashboard-panels");
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect(),
        root = document.documentElement.style;
      root.setProperty("--dashboard-map-left", `${r.left}px`);
      root.setProperty("--dashboard-map-top", `${r.top}px`);
      root.setProperty("--dashboard-map-w", `${r.width}px`);
      root.setProperty("--dashboard-map-h", `${r.height}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (panel) observer.observe(panel);
    panel?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    measure();
    window.dispatchEvent(new Event("resize"));
    return () => {
      observer.disconnect();
      panel?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      for (const key of ["left", "top", "w", "h"])
        document.documentElement.style.removeProperty(`--dashboard-map-${key}`);
    };
  }, []);
  const details = hover ? view.details.get(hover.index) : null,
    feature = hover ? layer.geojson?.features[hover.index] : null;
  const fitResults = () => {
    manual.current = false;
    wholeRoute.current = true;
    setViewingName(null);
    if (camera) fitDashboardMap(camera, latest.current, view.indexes);
    else onFit(view.indexes);
  };
  return (
    <section ref={slot} className="dashboard-map-slot">
      <div className="dashboard-map-tools">
        <label>
          {t("progress.v2.dashboard.colorMode")}{" "}
          <select
            aria-label={t("progress.v2.dashboard.colorMode")}
            value={mode}
            onChange={(e) => onMode(e.target.value as DashboardColorMode)}
          >
            {(["status", "deviation", "girder"] as const).map((k) => (
              <option key={k} value={k}>
                {t(`progress.v2.dashboard.colorModes.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={fitResults}>
          {t("progress.v2.dashboard.fit")}
        </button>
        <span aria-live="polite">
          {t("progress.v2.dashboard.visible", { count: view.indexes.length })}
        </span>
        {viewingName ? (
          <span className="dashboard-map-viewing">
            {t("progress.v2.dashboard.viewing", { name: viewingName })} ·{" "}
            <button type="button" onClick={fitResults}>
              {t("progress.v2.dashboard.fullRoute")}
            </button>
          </span>
        ) : null}
      </div>
      {printImage ? (
        <img
          src={printImage}
          className="dashboard-print-map"
          alt={t("progress.v2.dashboard.map")}
        />
      ) : null}
      {hover && details && feature ? (
        <div
          role="tooltip"
          className="dashboard-hover"
          style={{
            left: Math.max(8, Math.min(hover.x + 14, window.innerWidth - 290)),
            top: Math.max(10, Math.min(hover.y + 14, window.innerHeight - 120)),
          }}
        >
          <strong>
            {["cong_trinh", "cau_kien", "bo_phan"]
              .map((k) => propertyText(feature, k))
              .filter(Boolean)
              .join(" · ") || String(feature.id ?? hover.index)}
          </strong>
          <span>{details.items.map((k) => t(`progress.v2.items.${k}`)).join(" · ")}</span>
          <b>
            {fmt(details.pct)}% / {fmt(details.planned)}% ·{" "}
            {t(`progress.v2.dashboard.statuses.${details.status}`)}
          </b>
        </div>
      ) : null}
    </section>
  );
}
