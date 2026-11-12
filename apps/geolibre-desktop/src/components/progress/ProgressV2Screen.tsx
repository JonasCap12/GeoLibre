import { featureSelectionId, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { startFeatureSelection } from "@geolibre/map";
import { Button, Select } from "@geolibre/ui";
import { CalendarCheck, LayoutDashboard, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { featuresBounds, isoWeek, todayIso } from "../../lib/construction-progress";
import {
  packageFeatureIndexes,
  progressFeatureTarget,
  progressV2LayerPatch,
  type ProgressFeatureTarget,
} from "../../lib/progress-colors";
import {
  bridgesInPackage,
  computeProgressV2,
  recordProgressV2Week,
  type ProgressV2,
} from "../../lib/progress-v2";
import { closeProgressScreen } from "../../lib/progress-screen";
import { fmt, type ProgressScreenCamera } from "./ProgressScreenBlocks";
import { ProgressV2Dashboard } from "./ProgressV2Dashboard";
import { ProgressV2Items } from "./ProgressV2Items";
import { ProgressV2Overview } from "./ProgressV2Overview";
import { ProgressV2Profile } from "./ProgressV2Profile";
import { ProgressV2SettingsDialog } from "./ProgressV2SettingsDialog";
import { ProgressV2Update } from "./ProgressV2Update";
import { ProgressV2Yard } from "./ProgressV2Yard";

export type ProgressV2Tab = "overview" | "items" | "yard" | "update";

export function ProgressV2Screen({
  layer,
  config,
  camera,
}: {
  layer: GeoLibreLayer;
  config: ProgressV2;
  camera: ProgressScreenCamera | null;
}) {
  const { t, i18n } = useTranslation();
  const features = useMemo(() => layer.geojson?.features ?? [], [layer.geojson]);
  const [packageId, setPackageId] = useState<string | null>(null);
  const [tab, setTab] = useState<ProgressV2Tab>("overview");
  const [target, setTarget] = useState<ProgressFeatureTarget | null>(null);
  const [bridgeId, setBridgeId] = useState(config.bridges[0]?.id ?? "");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dashboard, setDashboard] = useState(false);
  const [throughDate, setThroughDate] = useState("");
  const activePackageId =
    packageId && config.packages.some((item) => item.id === packageId) ? packageId : null;
  useEffect(() => {
    if (packageId !== activePackageId) setPackageId(activePackageId);
  }, [packageId, activePackageId]);
  useEffect(() => setThroughDate(""), [activePackageId]);
  const summary = useMemo(
    () => computeProgressV2(config, activePackageId),
    [config, activePackageId],
  );
  const bridges = useMemo(
    () => bridgesInPackage(config, activePackageId),
    [config, activePackageId],
  );
  const selectedBridge = bridges.find((bridge) => bridge.id === bridgeId) ?? bridges[0] ?? null;

  useEffect(() => {
    document.documentElement.setAttribute("data-progress-v2", "");
    window.dispatchEvent(new Event("resize"));
    return () => {
      document.documentElement.removeAttribute("data-progress-v2");
      window.dispatchEvent(new Event("resize"));
    };
  }, []);

  const save = (next: ProgressV2) =>
    useAppStore.getState().updateLayer(layer.id, progressV2LayerPatch(layer, next));

  const fitIndexes = useCallback(
    (indexes: number[]) => {
      const bounds = featuresBounds(indexes.map((index) => features[index]).filter(Boolean));
      if (bounds) camera?.fitBounds(bounds);
    },
    [features, camera],
  );

  const lastFit = useRef<{
    packageId: string | null;
    camera: ProgressScreenCamera;
    layerId: string;
  } | null>(null);
  useEffect(() => {
    if (!camera) return;
    if (
      lastFit.current?.packageId === activePackageId &&
      lastFit.current?.camera === camera &&
      lastFit.current?.layerId === layer.id
    )
      return;
    lastFit.current = { packageId: activePackageId, camera, layerId: layer.id };
    const indexes = packageFeatureIndexes(features, config, activePackageId);
    fitIndexes(indexes);
    const first = bridgesInPackage(config, activePackageId)[0];
    if (
      first &&
      !bridgesInPackage(config, activePackageId).some((bridge) => bridge.id === bridgeId)
    )
      setBridgeId(first.id);
  }, [activePackageId, bridgeId, camera, config, features, fitIndexes, layer.id]);

  // Every save rebuilds the drawing's features, so the selection reads them
  // through a ref: re-arming on each edit would clear the user's selection and
  // send Escape to whatever else is open.
  const featuresRef = useRef(features);
  featuresRef.current = features;

  useEffect(() => {
    const store = useAppStore.getState();
    if (store.identifyLayerId !== null) store.setIdentifyLayer(null);
    store.selectFeature(null);
    startFeatureSelection({ layerId: layer.id, shape: "single" });
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.selectedFeatureIds === previous.selectedFeatureIds) return;
      if (state.selectedLayerId !== layer.id || state.selectedFeatureIds.length === 0) return;
      const current = featuresRef.current;
      const wanted = new Set(state.selectedFeatureIds);
      const index = current.findIndex((feature, featureIndex) =>
        wanted.has(featureSelectionId(feature, featureIndex)),
      );
      const next = index >= 0 ? progressFeatureTarget(current[index]) : null;
      if (!next) return;
      setTarget(next);
      if ("bridgeId" in next) setBridgeId(next.bridgeId);
      setTab("update");
    });
    return () => {
      unsubscribe();
      // The map's click selection ends on Escape; this screen armed it above.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    };
  }, [layer.id]);

  const openTarget = (next: ProgressFeatureTarget) => {
    setTarget(next);
    if ("bridgeId" in next) setBridgeId(next.bridgeId);
    setTab("update");
    const indexes: number[] = [];
    features.forEach((feature, index) => {
      const found = progressFeatureTarget(feature);
      if (found?.kind !== next.kind || found.id !== next.id) return;
      if ("bridgeId" in next && (!("bridgeId" in found) || found.bridgeId !== next.bridgeId))
        return;
      indexes.push(index);
    });
    fitIndexes(indexes);
  };

  const deviationClass = summary.deviation < -0.5 ? "text-[#ffb4a0]" : "";
  return (
    <>
      <header
        className="progress-screen-header flex items-center gap-3 border-b border-header bg-header px-3 text-header-foreground"
        aria-label={t("progress.title")}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-bold uppercase leading-tight tracking-wide">
            {config.meta.title || layer.name}
          </div>
          <div className="truncate text-[11px] text-header-muted">
            {config.meta.cdt || config.meta.subtitle} ·{" "}
            {t("progress.week", {
              week: isoWeek(config.meta.reportDate),
              date: Number.isFinite(Date.parse(config.meta.reportDate))
                ? new Intl.DateTimeFormat(i18n.language, {
                    dateStyle: "medium",
                    timeZone: "UTC",
                  }).format(new Date(config.meta.reportDate))
                : "?",
            })}
          </div>
        </div>
        <Select
          aria-label={t("progress.v2.package")}
          className="h-8 w-36 border-white/20 bg-header text-xs text-header-foreground"
          value={activePackageId ?? ""}
          onChange={(event) => setPackageId(event.target.value || null)}
        >
          <option value="">{t("progress.wholeProject")}</option>
          {config.packages.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        {dashboard ? (
          <Select
            aria-label={t("progress.v2.dashboard.week")}
            className="h-8 w-32 border-white/20 bg-header text-xs text-header-foreground"
            value={throughDate}
            onChange={(event) => setThroughDate(event.target.value)}
          >
            <option value="">{t("progress.v2.dashboard.current")}</option>
            {config.history
              .filter((point) => point.packageId === activePackageId)
              .map((point) => (
                <option key={point.week} value={point.date}>
                  {point.week}
                </option>
              ))}
          </Select>
        ) : null}
        <HeaderButton
          label={t(dashboard ? "progress.v2.dashboard.edit" : "progress.v2.dashboard.title")}
          onClick={() => setDashboard((value) => !value)}
        >
          <LayoutDashboard className="h-4 w-4" />
        </HeaderButton>
        {!dashboard ? (
          <>
            <HeaderKpi label={t("progress.actual")} value={`${fmt(summary.overallPct)}%`} strong />
            <HeaderKpi label={t("progress.planned")} value={`${fmt(summary.plannedPct)}%`} />
            <HeaderKpi
              label={t("progress.deviation")}
              value={`${summary.deviation > 0 ? "+" : ""}${fmt(summary.deviation)}%`}
              className={deviationClass}
            />
          </>
        ) : null}
        <HeaderButton
          label={t("progress.closeWeek")}
          onClick={() => save(recordProgressV2Week(config, todayIso(), activePackageId))}
        >
          <CalendarCheck className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton label={t("progress.settings")} onClick={() => setSettingsOpen(true)}>
          <Settings2 className="h-4 w-4" />
        </HeaderButton>
        <HeaderButton label={t("common.close")} onClick={closeProgressScreen} iconOnly>
          <X className="h-4 w-4" />
        </HeaderButton>
      </header>

      {dashboard ? (
        <ProgressV2Dashboard
          layer={layer}
          state={config}
          packageId={activePackageId}
          throughDate={throughDate}
          onPackage={setPackageId}
          onOpen={openTarget}
          onFit={fitIndexes}
        />
      ) : (
        <>
          <ProgressV2Profile
            state={config}
            packageId={packageId}
            bridges={bridges}
            bridge={selectedBridge}
            onBridge={setBridgeId}
            onOpen={openTarget}
          />

          <aside className="progress-screen-side flex min-h-0 flex-col border-border bg-background text-foreground">
            <div className="grid shrink-0 grid-cols-4 border-b border-border text-[11px] font-semibold">
              {(["overview", "items", "yard", "update"] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  aria-pressed={tab === item}
                  onClick={() => setTab(item)}
                  className={`min-h-10 px-1 py-1 ${
                    tab === item ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                  }`}
                >
                  {t(`progress.v2.tabs.${item}`)}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden p-2">
              {tab === "overview" ? (
                <ProgressV2Overview state={config} packageId={packageId} onOpen={openTarget} />
              ) : tab === "items" ? (
                <ProgressV2Items
                  state={config}
                  packageId={packageId}
                  onChange={save}
                  onOpen={openTarget}
                />
              ) : tab === "yard" ? (
                <ProgressV2Yard
                  state={config}
                  bridge={selectedBridge}
                  onChange={save}
                  onOpen={openTarget}
                />
              ) : (
                <ProgressV2Update state={config} target={target} onChange={save} />
              )}
            </div>
          </aside>
        </>
      )}

      {settingsOpen ? (
        <ProgressV2SettingsDialog
          state={config}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            save(next);
            setSettingsOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function HeaderKpi({
  label,
  value,
  strong,
  className = "",
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`shrink-0 flex-col items-end leading-tight ${strong ? "flex" : "hidden sm:flex"}`}
    >
      <span className="text-[10px] font-semibold uppercase tracking-wider text-header-muted">
        {label}
      </span>
      <span className={`${strong ? "text-2xl" : "text-lg"} font-bold tabular-nums ${className}`}>
        {value}
      </span>
    </div>
  );
}

function HeaderButton({
  label,
  onClick,
  iconOnly,
  children,
}: {
  label: string;
  onClick: () => void;
  iconOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="h-8 px-2 text-header-foreground hover:bg-white/10 hover:text-header-foreground"
    >
      {children}
      {iconOnly ? null : <span className="hidden 2xl:inline">{label}</span>}
    </Button>
  );
}
