import { useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { Button } from "@geolibre/ui";
import { CalendarCheck, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  computeProgress,
  progressStructures,
  isoWeek,
  progressConfigPatch,
  progressIssues,
  readProgressConfig,
  recordWeek,
  type ConstructionProgress,
} from "../../lib/construction-progress";
import {
  closeProgressScreen,
  getProgressScreenLayerId,
  PROGRESS_SCREEN_ATTRIBUTE,
  subscribeProgressScreen,
} from "../../lib/progress-screen";
import {
  HistoryBlock,
  IssuesBlock,
  ItemsBlock,
  MarkBlock,
  fmt,
  type ProgressScreenCamera,
} from "./ProgressScreenBlocks";
import { ProgressSettingsDialog } from "./ProgressSettingsDialog";
import { MatrixBlock, StructuresBlock } from "./ProgressStructureBlocks";

/**
 * Full-viewport construction progress screen over a drawing layer.
 *
 * The shell is left as it is: while open, `data-progress-screen` on the
 * document element makes `index.css` pin the map area into the map cell, and
 * this component draws the header band and the side column over the rest.
 */

export type { ProgressScreenCamera };

function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Mounts the screen while a drawing is open in it. Mounted beside the shell
 * (in `App`), so it reaches the map through the app API, not a shell ref.
 */
export function ConstructionProgressScreen({ camera }: { camera: ProgressScreenCamera | null }) {
  const layerId = useSyncExternalStore(subscribeProgressScreen, getProgressScreenLayerId);
  const layer = useAppStore((s) => (layerId ? s.layers.find((l) => l.id === layerId) : undefined));
  const config = useMemo(() => (layer ? readProgressConfig(layer) : null), [layer]);
  const open = Boolean(layer && config);

  useEffect(() => {
    // The drawing was removed, or its setup was: nothing left to show.
    if (layerId && !open) closeProgressScreen();
  }, [layerId, open]);

  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    root.setAttribute(PROGRESS_SCREEN_ATTRIBUTE, "");
    // MapLibre follows its container with a ResizeObserver; the event covers
    // engines that only listen to the window.
    window.dispatchEvent(new Event("resize"));
    return () => {
      root.removeAttribute(PROGRESS_SCREEN_ATTRIBUTE);
      window.dispatchEvent(new Event("resize"));
    };
  }, [open]);

  if (!layer || !config) return null;
  return <ProgressScreen layer={layer} config={config} camera={camera} />;
}

function ProgressScreen({
  layer,
  config,
  camera,
}: {
  layer: GeoLibreLayer;
  config: ConstructionProgress;
  camera: ProgressScreenCamera | null;
}) {
  const { t } = useTranslation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const features = useMemo(() => layer.geojson?.features ?? [], [layer.geojson]);
  const summary = useMemo(() => computeProgress(features, config), [features, config]);
  const structures = useMemo(() => progressStructures(features, config), [features, config]);
  // The structure the side column details; null is the whole project.
  const [scope, setScope] = useState<string | null>(null);
  const picked = structures.find((structure) => structure.name === scope) ?? null;
  const today = todayIso();
  const save = (next: ConstructionProgress) =>
    useAppStore.getState().updateLayer(layer.id, progressConfigPatch(layer, next));
  const behind = summary.deviation < -0.05;

  return (
    <>
      <header
        className="progress-screen-header flex items-center gap-4 border-b border-header bg-header px-4 text-header-foreground"
        aria-label={t("progress.title")}
      >
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-bold uppercase leading-tight tracking-wide">
            {config.title || layer.name}
          </div>
          {config.subtitle ? (
            <div className="truncate text-xs text-header-muted">{config.subtitle}</div>
          ) : null}
          <div className="truncate text-xs text-header-muted">
            {t("progress.week", { week: isoWeek(today), date: today })}
          </div>
        </div>
        <Kpi label={t("progress.actual")} value={`${fmt(summary.overallPct)}%`} strong />
        <Kpi label={t("progress.planned")} value={`${fmt(summary.plannedPct)}%`} />
        <Kpi
          label={t("progress.deviation")}
          value={`${summary.deviation > 0 ? "+" : ""}${fmt(summary.deviation)}`}
          className={behind ? "text-[#ffb4a0]" : undefined}
        />
        <div className="flex shrink-0 items-center gap-1">
          <HeaderButton
            label={t("progress.closeWeek")}
            onClick={() => save(recordWeek(config, today, summary))}
          >
            <CalendarCheck className="h-4 w-4" />
          </HeaderButton>
          <HeaderButton label={t("progress.settings")} onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-4 w-4" />
          </HeaderButton>
          <HeaderButton label={t("common.close")} onClick={closeProgressScreen} iconOnly>
            <X className="h-4 w-4" />
          </HeaderButton>
        </div>
      </header>
      <aside
        className="progress-screen-side flex flex-col gap-2 border-border bg-background p-2 text-foreground"
        aria-label={t("progress.title")}
      >
        <MarkBlock layer={layer} config={config} />
        {structures.length > 0 ? (
          <StructuresBlock
            layer={layer}
            project={summary}
            structures={structures}
            scope={picked?.name ?? null}
            onScope={setScope}
            camera={camera}
          />
        ) : null}
        {picked ? (
          <MatrixBlock
            layer={layer}
            config={config}
            structure={picked}
            summary={picked.summary}
            camera={camera}
            onClose={() => setScope(null)}
          />
        ) : (
          <ItemsBlock layer={layer} items={summary.items} camera={camera} />
        )}
        <div data-block="footer" className="grid min-h-0 flex-[1.6] grid-cols-2 gap-2">
          <HistoryBlock weekly={config.weekly} summary={summary} today={today} />
          <IssuesBlock issues={progressIssues(config)} />
        </div>
      </aside>
      {settingsOpen ? (
        <ProgressSettingsDialog
          layer={layer}
          config={config}
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

function Kpi({
  label,
  value,
  strong,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  // On a phone only the overall figure stays; the others need the room.
  return (
    <div
      className={`shrink-0 flex-col items-end leading-tight ${strong ? "flex" : "hidden sm:flex"}`}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider text-header-muted">
        {label}
      </span>
      <span
        className={`font-bold tabular-nums ${strong ? "text-3xl" : "text-xl"} ${className ?? ""}`}
      >
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
      className="h-8 gap-1.5 rounded-none px-2 text-header-foreground hover:bg-white/10 hover:text-header-foreground"
    >
      {children}
      {iconOnly ? null : <span className="hidden xl:inline">{label}</span>}
    </Button>
  );
}
