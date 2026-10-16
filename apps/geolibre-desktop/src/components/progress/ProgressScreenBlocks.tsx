import { featureSelectionId, useAppStore, type GeoLibreLayer } from "@geolibre/core";
import { startFeatureSelection } from "@geolibre/map";
import { getGeometryEditTargetLayerId } from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { LassoSelect, Pentagon, SquareDashed } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { canEditAttributeValues } from "../../lib/attribute-table-source";
import {
  countedFeatureTest,
  featuresBounds,
  isoWeek,
  itemFeatureIndexes,
  progressStatusPaint,
  rowsThatFit,
  PROGRESS_STATUS_COLORS,
  type ConstructionProgress,
  type ItemProgress,
  type ProgressStatus,
  type WeekRecord,
} from "../../lib/construction-progress";
import { paintArea, paintSelection } from "../../lib/selection-actions";

/**
 * The side column of the construction progress screen: marking states on the
 * drawing, the work items, the weekly chart and the issues. None of them
 * scrolls: a block measures its own height and folds the rows that do not fit
 * into a "+N" line.
 */

const ITEM_ROW_MIN = 30;
const ISSUE_ROW_MIN = 22;
/** The lists' own vertical padding (`py-1`), which is not room for rows. */
const LIST_PADDING = 8;

type SweepShape = "rectangle" | "polygon" | "freehand";
type MarkTarget = SweepShape | "selection";

const pctFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** A percent or a percent-point figure, to one decimal in the user's locale. */
export const fmt = (value: number) => pctFormat.format(value);

/** The one camera call the screen makes; the app API provides it. */
export interface ProgressScreenCamera {
  fitBounds(bounds: [number, number, number, number]): void;
}

/** Height of an element, kept current with a ResizeObserver. */
function useHeight<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setHeight(element.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, height];
}

function Block({
  kind,
  title,
  className,
  children,
}: {
  /** Names the block for the narrow-screen grid in `index.css`. */
  kind: "mark" | "items" | "history" | "issues";
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-block={kind}
      className={`flex min-h-0 flex-col overflow-hidden rounded-sm border border-border bg-card ${className ?? ""}`}
    >
      <h2 className="shrink-0 border-b border-border px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function MarkBlock({
  layer,
  config,
}: {
  layer: GeoLibreLayer;
  config: ConstructionProgress;
}) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<MarkTarget>("rectangle");
  const selectedCount = useAppStore((s) =>
    s.selectedLayerId === layer.id ? s.selectedFeatureIds.length : 0,
  );
  const canEdit = canEditAttributeValues(layer, getGeometryEditTargetLayerId());
  const chosen = target === "selection" && selectedCount === 0 ? "rectangle" : target;

  const mark = (status: ProgressStatus | null) => {
    const { color, extra } = progressStatusPaint(status);
    if (chosen === "selection") {
      paintSelection(color, extra);
      return;
    }
    const store = useAppStore.getState();
    // A sweep takes over map clicks, so Identify has to let go of them.
    if (store.identifyLayerId !== null) store.setIdentifyLayer(null);
    startFeatureSelection({
      layerId: layer.id,
      shape: chosen,
      onArea: (area) => paintArea(layer.id, area, color, extra, countedFeatureTest(config)),
    });
  };

  const targets: Array<[MarkTarget, ReactNode, string]> = [
    [
      "rectangle",
      <SquareDashed key="r" className="h-3.5 w-3.5" />,
      t("layers.featureColor.areaRectangle"),
    ],
    ["polygon", <Pentagon key="p" className="h-3.5 w-3.5" />, t("layers.featureColor.areaPolygon")],
    [
      "freehand",
      <LassoSelect key="f" className="h-3.5 w-3.5" />,
      t("layers.featureColor.areaFreehand"),
    ],
  ];

  return (
    <Block kind="mark" title={t("progress.mark")} className="shrink-0">
      <div className="flex flex-wrap items-center gap-1 p-1.5" title={t("progress.markHint")}>
        <div className="flex items-center rounded-sm border border-border" role="radiogroup">
          {targets.map(([value, icon, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={chosen === value}
              aria-label={label}
              title={label}
              onClick={() => setTarget(value)}
              className={`flex h-7 w-7 items-center justify-center ${
                chosen === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              {icon}
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={chosen === "selection"}
            disabled={selectedCount === 0}
            onClick={() => setTarget("selection")}
            className={`h-7 px-2 text-xs disabled:opacity-50 ${
              chosen === "selection" ? "bg-primary text-primary-foreground" : "hover:bg-muted"
            }`}
          >
            {t("progress.markSelection", { count: selectedCount })}
          </button>
        </div>
        {(["done", "wip", null] as const).map((status) => (
          <Button
            key={status ?? "clear"}
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={() => mark(status)}
            className="h-7 gap-1.5 px-2 text-xs"
          >
            <span
              aria-hidden="true"
              className="h-3 w-3 rounded-sm border border-border"
              style={{ backgroundColor: status ? PROGRESS_STATUS_COLORS[status] : "transparent" }}
            />
            {t(status ? `progress.status.${status}` : "progress.status.clear")}
          </Button>
        ))}
      </div>
    </Block>
  );
}

export function ItemsBlock({
  layer,
  items,
  camera,
}: {
  layer: GeoLibreLayer;
  items: ItemProgress[];
  camera: ProgressScreenCamera | null;
}) {
  const { t } = useTranslation();
  const [listRef, height] = useHeight<HTMLDivElement>();
  const shown = rowsThatFit(items.length, height - LIST_PADDING, ITEM_ROW_MIN);
  const hidden = items.length - shown;

  const selectItem = (entry: ItemProgress) => {
    const all = layer.geojson?.features ?? [];
    const indexes = itemFeatureIndexes(all, entry.item);
    const store = useAppStore.getState();
    // Selecting shows the item on the drawing and makes it the mark target.
    store.selectLayer(layer.id);
    if (indexes.length === 0) return;
    store.selectFeatures(indexes.map((index) => featureSelectionId(all[index], index)));
    const bounds = featuresBounds(indexes.map((index) => all[index]));
    if (bounds) camera?.fitBounds(bounds);
  };

  return (
    <Block kind="items" title={t("progress.items")} className="flex-[4]">
      <div ref={listRef} className="flex min-h-0 flex-1 flex-col px-2 py-1">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("progress.itemsEmpty")}</p>
        ) : null}
        {items.slice(0, shown).map((entry) => (
          <ItemRow key={entry.item.key} entry={entry} onSelect={() => selectItem(entry)} />
        ))}
        {hidden > 0 ? (
          <div className="flex min-h-[22px] items-center text-xs text-muted-foreground">
            {t("progress.more", { count: hidden })}
          </div>
        ) : null}
      </div>
    </Block>
  );
}

function ItemRow({ entry, onSelect }: { entry: ItemProgress; onSelect: () => void }) {
  const { t } = useTranslation();
  const { item, pct } = entry;
  const behind = pct + 0.05 < item.plannedPct;
  return (
    <button
      type="button"
      onClick={onSelect}
      title={t("progress.itemTitle", { name: item.name, plan: fmt(item.plannedPct) })}
      className="flex max-h-12 min-h-[30px] flex-1 flex-col justify-center gap-0.5 text-start hover:bg-muted/60"
    >
      <span className="flex w-full items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate font-semibold">{item.name}</span>
        {item.overridePct !== null ? (
          <span className="shrink-0 text-[10px] uppercase text-muted-foreground">
            {t("progress.overridden")}
          </span>
        ) : null}
        <span className="shrink-0 tabular-nums font-bold">{fmt(pct)}%</span>
      </span>
      <span className="relative block h-2 w-full overflow-hidden rounded-sm bg-muted">
        <span
          className="absolute inset-y-0 start-0"
          style={{
            width: `${pct}%`,
            backgroundColor: behind ? PROGRESS_STATUS_COLORS.wip : PROGRESS_STATUS_COLORS.done,
          }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 bg-foreground/70"
          style={{ insetInlineStart: `calc(${item.plannedPct}% - 1px)` }}
        />
      </span>
    </button>
  );
}

export function HistoryBlock({
  weekly,
  summary,
  today,
}: {
  weekly: WeekRecord[];
  summary: { overallPct: number; plannedPct: number };
  today: string;
}) {
  const { t } = useTranslation();
  const week = isoWeek(today);
  // The live figures stand in for this week until it is recorded.
  const points: WeekRecord[] = [
    ...weekly.filter((w) => w.week !== week),
    { week, date: today, actualPct: summary.overallPct, plannedPct: summary.plannedPct },
  ];
  const x = (i: number) => (points.length === 1 ? 50 : (i / (points.length - 1)) * 100);
  const y = (pct: number) => 40 - (pct / 100) * 38 - 1;
  const line = (pick: (w: WeekRecord) => number) =>
    points.map((w, i) => `${x(i)},${y(pick(w))}`).join(" ");
  return (
    <Block kind="history" title={t("progress.history")} className="flex-[2]">
      <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
        <div className="flex shrink-0 gap-3 text-[11px]">
          <span className="flex items-center gap-1">
            <span className="h-0.5 w-3" style={{ backgroundColor: PROGRESS_STATUS_COLORS.done }} />
            {t("progress.actual")}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-0 w-3 border-t border-dashed border-muted-foreground" />
            {t("progress.planned")}
          </span>
        </div>
        <div className="relative min-h-0 flex-1">
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            role="img"
            aria-label={t("progress.history")}
          >
            {[0, 50, 100].map((v) => (
              <line
                key={v}
                x1={0}
                x2={100}
                y1={y(v)}
                y2={y(v)}
                className="stroke-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <polyline
              points={line((w) => w.plannedPct)}
              fill="none"
              strokeDasharray="4 3"
              className="stroke-muted-foreground"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <polyline
              points={line((w) => w.actualPct)}
              fill="none"
              stroke={PROGRESS_STATUS_COLORS.done}
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {/* Dots are HTML so the stretched viewBox does not squash them, and so
            a single week still shows. The chart's x runs left to right in
            every locale, like its week labels. */}
          {points.map((w, i) => (
            <span
              key={w.week}
              title={`${w.week}: ${fmt(w.actualPct)}% / ${fmt(w.plannedPct)}%`}
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-card"
              style={{
                left: `${x(i)}%`,
                top: `${(y(w.actualPct) / 40) * 100}%`,
                backgroundColor: PROGRESS_STATUS_COLORS.done,
              }}
            />
          ))}
        </div>
        <div className="flex shrink-0 justify-between text-[10px] tabular-nums text-muted-foreground">
          <span>{points[0].week}</span>
          {points.length > 1 ? <span>{points[points.length - 1].week}</span> : null}
        </div>
        {weekly.length === 0 ? (
          <p className="shrink-0 truncate text-[11px] text-muted-foreground">
            {t("progress.historyEmpty")}
          </p>
        ) : null}
      </div>
    </Block>
  );
}

export function IssuesBlock({ issues }: { issues: string[] }) {
  const { t } = useTranslation();
  const [listRef, height] = useHeight<HTMLUListElement>();
  const shown = rowsThatFit(issues.length, height - LIST_PADDING, ISSUE_ROW_MIN);
  const hidden = issues.length - shown;
  return (
    <Block kind="issues" title={t("progress.issues")} className="flex-[1.2]">
      <ul ref={listRef} className="flex min-h-0 flex-1 flex-col px-2 py-1 text-xs">
        {issues.length === 0 ? (
          <li className="text-muted-foreground">{t("progress.issuesEmpty")}</li>
        ) : null}
        {issues.slice(0, shown).map((issue, index) => (
          <li key={index} className="flex min-h-[22px] items-center gap-1.5" title={issue}>
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#e2401c]" />
            <span className="truncate">{issue}</span>
          </li>
        ))}
        {hidden > 0 ? (
          <li className="flex min-h-[22px] items-center text-muted-foreground">
            {t("progress.more", { count: hidden })}
          </li>
        ) : null}
      </ul>
    </Block>
  );
}
