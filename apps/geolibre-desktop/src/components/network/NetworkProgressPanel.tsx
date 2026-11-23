import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { NetworkSegment } from "../../lib/network-dashboard";
import { progressGroups } from "../../lib/network-progress-panel";

interface NetworkProgressPanelProps {
  segments: readonly NetworkSegment[];
  /** The package the report board shows, highlighted here. */
  boardPackage: string | null;
  /** Show this line on the map. */
  onSelect: (segment: NetworkSegment) => void;
}

/**
 * The project lines, grouped by their type field (a contract package, say),
 * with percent done: fills the space the 16:9 report board leaves below it and
 * ties what the report says to where it is on the map.
 */
export function NetworkProgressPanel({
  segments,
  boardPackage,
  onSelect,
}: NetworkProgressPanelProps) {
  const { t, i18n } = useTranslation();
  const format = useMemo(() => {
    const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
    return (value: number) => number.format(value);
  }, [i18n.language]);
  const groups = useMemo(() => progressGroups(segments, boardPackage), [segments, boardPackage]);
  if (groups.length === 0) return null;
  return (
    <section
      className="network-dashboard-progress"
      aria-label={t("roadNetwork.progressPanel.title")}
    >
      <div className="network-dashboard-progress-inner flex h-full min-h-0 flex-col gap-2 border-t bg-card p-3">
        <header className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("roadNetwork.progressPanel.title")}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {t("roadNetwork.progressPanel.hint")}
          </p>
        </header>
        <div className="network-dashboard-progress-grid min-h-0 flex-1 overflow-y-auto">
          {groups.map((group) => (
            <section
              key={group.key}
              data-active={group.active || undefined}
              className="network-dashboard-progress-group rounded-md border bg-background p-2"
            >
              <h3 className="mb-1 flex items-baseline gap-2 text-xs font-semibold">
                <span className="min-w-0 flex-1 truncate">
                  {group.label || t("roadNetwork.unclassified")}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {group.progress === null ? "" : `${format(group.progress)}% · `}
                  {format(group.km)} km
                </span>
              </h3>
              <ul className="space-y-0.5">
                {group.rows.map(({ segment, label }) => (
                  <li key={`${segment.layerId}:${segment.index}`}>
                    <button
                      type="button"
                      className="grid w-full grid-cols-[minmax(0,1fr)_4.5rem_3rem] items-center gap-2 rounded px-1 py-0.5 text-start text-xs hover:bg-accent focus-visible:bg-accent"
                      title={t("roadNetwork.progressPanel.show", { name: segment.name })}
                      onClick={() => onSelect(segment)}
                    >
                      <span className="truncate">{label}</span>
                      <span
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="img"
                        aria-label={
                          segment.progress === null
                            ? t("roadNetwork.progressPanel.noProgress")
                            : `${format(segment.progress)}%`
                        }
                      >
                        {segment.progress !== null && (
                          <span
                            className="block h-full rounded-full bg-primary"
                            style={{ width: `${Math.min(Math.max(segment.progress, 0), 100)}%` }}
                          />
                        )}
                      </span>
                      <span className="text-end tabular-nums text-muted-foreground">
                        {segment.progress === null ? "—" : `${format(segment.progress)}%`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </section>
  );
}
