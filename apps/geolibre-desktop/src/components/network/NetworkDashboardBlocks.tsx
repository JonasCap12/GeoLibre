import { RangeSlider } from "@geolibre/ui";
import { useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  compareNames,
  planGap,
  type NetworkCategory,
  type NetworkSegment,
  type NetworkSummary,
} from "../../lib/network-dashboard";

/** How many lines behind plan the end column lists. */
const BEHIND_LIST_SIZE = 8;

/**
 * Kilometres in the app language, so a Vietnamese report reads "1.234,5".
 * Like the construction progress screen, the figures here go into reports
 * written in the app language (see docs/i18n.md).
 */
export function useKmFormat(): (km: number) => string {
  const { i18n } = useTranslation();
  return useMemo(() => {
    const format = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
    return (km: number) => format.format(km);
  }, [i18n.language]);
}

/** A checkbox per value of a field, with its colour and kilometres. */
export function CategoryFilter({
  title,
  entries,
  colors,
  selected,
  onChange,
}: {
  title: string;
  entries: readonly NetworkCategory[];
  /** The map's colours when the map is coloured by this field, else null. */
  colors: ReadonlyMap<string, string> | null;
  /** The values shown; null is all of them. */
  selected: ReadonlySet<string> | null;
  onChange: (next: ReadonlySet<string> | null) => void;
}) {
  const { t } = useTranslation();
  const km = useKmFormat();
  const toggle = (value: string) => {
    const next = new Set(selected ?? entries.map((entry) => entry.value));
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next.size === entries.length ? null : next);
  };
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      {entries.map((entry) => (
        <label
          key={entry.value}
          className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-accent"
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-primary"
            checked={!selected || selected.has(entry.value)}
            onChange={() => toggle(entry.value)}
          />
          {colors && (
            <span
              aria-hidden="true"
              className="h-1.5 w-4 shrink-0 rounded-full"
              style={{ background: colors.get(entry.value) }}
            />
          )}
          <span className="min-w-0 flex-1 truncate">
            {entry.value.trim() || t("roadNetwork.unclassified")}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{km(entry.km)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** Kilometres per year as vertical bars. */
export function YearBars({
  data,
  format,
}: {
  data: readonly { year: number; km: number }[];
  format: (km: number) => string;
}) {
  const max = Math.max(...data.map((entry) => entry.km), 1);
  return (
    <div className="flex h-36 items-end gap-1.5" role="list">
      {data.map((entry) => (
        <div
          key={entry.year}
          role="listitem"
          className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
          title={`${entry.year}: ${format(entry.km)} km`}
        >
          <span className="text-[10px] tabular-nums text-muted-foreground">{format(entry.km)}</span>
          <div
            className="w-full max-w-10 rounded-t bg-primary/80"
            style={{ height: `${Math.max(2, (entry.km / max) * 100)}%` }}
          />
          <span className="text-[10px] tabular-nums">{entry.year}</span>
        </div>
      ))}
    </div>
  );
}

/** A two-thumb range filter; the full range means "no filter". */
export function RangeFilter({
  title,
  bounds,
  step,
  value,
  format,
  minLabel,
  maxLabel,
  onChange,
}: {
  title: string;
  bounds: readonly [number, number];
  step: number;
  value: readonly [number, number] | null;
  format: (value: number) => string;
  minLabel: string;
  maxLabel: string;
  onChange: (range: [number, number] | null) => void;
}) {
  const [from, to] = value ?? bounds;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      <div className="flex justify-between text-xs tabular-nums">
        <span className="rounded bg-primary px-1.5 py-0.5 text-primary-foreground">
          {format(from)}
        </span>
        <span className="rounded bg-primary px-1.5 py-0.5 text-primary-foreground">
          {format(to)}
        </span>
      </div>
      <RangeSlider
        min={bounds[0]}
        max={bounds[1]}
        step={step}
        value={[from, to]}
        minLabel={minLabel}
        maxLabel={maxLabel}
        onValueChange={([low, high]) =>
          onChange(low === bounds[0] && high === bounds[1] ? null : [low, high])
        }
      />
    </fieldset>
  );
}

/** The key figures: length, percent done against plan, kilometres done, lines behind. */
export function KpiCards({ summary }: { summary: NetworkSummary }) {
  const { t } = useTranslation();
  const fmt = useKmFormat();
  const gap =
    summary.progressPct !== null && summary.planPct !== null
      ? summary.progressPct - summary.planPct
      : null;
  return (
    <section className="grid grid-cols-2 gap-2" aria-label={t("roadNetwork.kpi.title")}>
      <div className="col-span-2 rounded-lg border bg-background p-3 text-center">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("roadNetwork.totalKm")}
        </h2>
        <p className="text-4xl font-bold tabular-nums text-primary">{fmt(summary.totalKm)}</p>
        <p className="text-xs text-muted-foreground">
          {t("roadNetwork.lineCount", { count: summary.lineCount })}
        </p>
      </div>
      {summary.progressPct !== null && (
        <Kpi label={t("roadNetwork.kpi.progress")} value={`${fmt(summary.progressPct)}%`}>
          <div className="mt-1 h-1.5 rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary"
              style={{ width: `${summary.progressPct}%` }}
            />
          </div>
        </Kpi>
      )}
      {summary.planPct !== null && (
        <Kpi label={t("roadNetwork.kpi.plan")} value={`${fmt(summary.planPct)}%`}>
          {gap !== null && (
            <p
              className={`text-xs font-medium tabular-nums ${gap < 0 ? "text-destructive" : "text-primary"}`}
            >
              {gap < 0 ? "▼ " : "▲ "}
              {t("roadNetwork.kpi.gap", { value: fmt(Math.abs(gap)) })}
            </p>
          )}
        </Kpi>
      )}
      {summary.doneKm !== null && (
        <Kpi label={t("roadNetwork.kpi.doneKm")} value={`${fmt(summary.doneKm)} km`} />
      )}
      {summary.progressPct !== null && (
        <Kpi
          label={t("roadNetwork.kpi.behind")}
          value={String(summary.behind.length)}
          tone={summary.behind.length > 0 ? "warn" : "ok"}
        />
      )}
    </section>
  );
}

function Kpi({
  label,
  value,
  tone,
  children,
}: {
  label: string;
  value: string;
  tone?: "ok" | "warn";
  children?: ReactNode;
}) {
  const color = tone === "warn" ? "text-destructive" : "text-foreground";
  return (
    <div className="rounded-lg border bg-background p-2.5">
      <p className="text-[11px] font-medium uppercase leading-tight tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={`text-xl font-bold tabular-nums ${color}`}>{value}</p>
      {children}
    </div>
  );
}

/** The lines most behind their plan; a click frames the line on the map. */
export function BehindList({
  lines,
  onPick,
}: {
  lines: readonly NetworkSegment[];
  onPick: (line: NetworkSegment) => void;
}) {
  const { t } = useTranslation();
  const fmt = useKmFormat();
  return (
    <section>
      <h2 className="mb-2 font-semibold">{t("roadNetwork.behind.title")}</h2>
      {lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("roadNetwork.behind.none")}</p>
      ) : (
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="text-muted-foreground">
              <th className="pb-1 text-start font-medium">{t("roadNetwork.behind.item")}</th>
              <th className="w-16 pb-1 text-end font-medium">
                {t("roadNetwork.behind.doneOfPlan")}
              </th>
              <th className="w-10 pb-1 text-end font-medium">{t("roadNetwork.behind.gap")}</th>
            </tr>
          </thead>
          <tbody>
            {lines.slice(0, BEHIND_LIST_SIZE).map((line) => (
              <tr key={`${line.layerId}:${line.index}`} className="border-t">
                <td className="py-1">
                  <button
                    type="button"
                    className="block w-full truncate text-start text-primary hover:underline"
                    title={line.name}
                    onClick={() => onPick(line)}
                  >
                    {line.name}
                  </button>
                </td>
                <td className="whitespace-nowrap py-1 text-end tabular-nums">
                  {fmt(line.progress ?? 0)}/{fmt(line.plan ?? 0)}%
                </td>
                <td className="whitespace-nowrap py-1 text-end font-semibold tabular-nums text-destructive">
                  {fmt(planGap(line) ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {lines.length > BEHIND_LIST_SIZE && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("roadNetwork.behind.more", { count: lines.length - BEHIND_LIST_SIZE })}
        </p>
      )}
    </section>
  );
}

/**
 * Percent done against percent planned, one row per line: the bar is done
 * (in the line's map colour), the dark tick is the plan.
 */
export function ProgressBullets({
  lines,
  colors,
  colorOf,
  onPick,
}: {
  lines: readonly NetworkSegment[];
  colors: ReadonlyMap<string, string>;
  colorOf: (line: NetworkSegment) => string;
  onPick: (line: NetworkSegment) => void;
}) {
  const { t } = useTranslation();
  const fmt = useKmFormat();
  const rows = useMemo(
    () => lines.filter((line) => line.progress !== null).sort(compareNames),
    [lines],
  );
  return (
    <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pe-1">
      <p className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2 w-3 rounded-sm bg-primary" aria-hidden="true" />
          {t("roadNetwork.kpi.progress")}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-0.5 bg-foreground" aria-hidden="true" />
          {t("roadNetwork.kpi.plan")}
        </span>
      </p>
      {rows.map((line) => (
        <button
          key={`${line.layerId}:${line.index}`}
          type="button"
          className="grid w-full grid-cols-[minmax(0,9rem)_minmax(0,1fr)_3rem] items-center gap-2 rounded px-1 text-start text-[11px] hover:bg-accent"
          title={`${line.name}: ${fmt(line.progress ?? 0)}%${line.plan !== null ? ` / ${fmt(line.plan)}%` : ""}`}
          onClick={() => onPick(line)}
        >
          <span className="truncate">{line.name}</span>
          <span className="relative h-2.5 rounded-sm bg-muted">
            <span
              className="absolute inset-y-0 start-0 rounded-sm"
              style={{
                width: `${line.progress}%`,
                background: colors.get(colorOf(line)) ?? "currentColor",
              }}
            />
            {line.plan !== null && (
              <span
                className="absolute -inset-y-0.5 w-0.5 bg-foreground"
                style={{ insetInlineStart: `calc(${line.plan}% - 1px)` }}
              />
            )}
          </span>
          <span className="text-end tabular-nums">{fmt(line.progress ?? 0)}%</span>
        </button>
      ))}
    </div>
  );
}

/** A ring chart with each slice's share, and a legend beside it. */
export function Donut({
  entries,
  format,
}: {
  entries: readonly { label: string; color: string; value: number }[];
  format: (value: number) => string;
}) {
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  // Circumference 100, so each dash length is the slice's percent.
  const radius = 15.915;
  let offset = 25; // start at 12 o'clock
  return (
    <div className="flex min-h-0 flex-1 items-center gap-3">
      <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0" aria-hidden="true">
        <circle cx="21" cy="21" r={radius} fill="none" className="stroke-muted" strokeWidth="7" />
        {total > 0 &&
          entries.map((entry) => {
            const share = (entry.value / total) * 100;
            const slice = (
              <circle
                key={entry.label}
                cx="21"
                cy="21"
                r={radius}
                fill="none"
                stroke={entry.color}
                strokeWidth="7"
                strokeDasharray={`${share} ${100 - share}`}
                strokeDashoffset={offset}
              />
            );
            offset -= share;
            return slice;
          })}
      </svg>
      <ul className="min-w-0 flex-1 space-y-1 text-[11px]">
        {entries.map((entry) => (
          <li key={entry.label} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: entry.color }}
            />
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {total > 0 ? format((entry.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
