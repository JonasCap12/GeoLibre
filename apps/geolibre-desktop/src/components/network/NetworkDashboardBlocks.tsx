import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { NetworkCategory } from "../../lib/network-dashboard";

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

/** Kilometres per category as horizontal bars, in the map's colours. */
export function BarList({
  entries,
  format,
}: {
  entries: readonly { label: string; color: string; value: number }[];
  format: (km: number) => string;
}) {
  const max = Math.max(...entries.map((entry) => entry.value), 1);
  return (
    <ul className="space-y-1.5">
      {entries.map((entry) => (
        <li key={entry.label} className="text-xs">
          <div className="flex justify-between gap-2">
            <span className="truncate">{entry.label}</span>
            <span className="tabular-nums text-muted-foreground">{format(entry.value)} km</span>
          </div>
          <div className="mt-0.5 h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full"
              style={{ width: `${(entry.value / max) * 100}%`, background: entry.color }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
