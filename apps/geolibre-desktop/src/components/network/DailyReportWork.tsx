import { MapPin } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  frontRange,
  workByFront,
  workRate,
  type BoardFront,
  type BoardReport,
  type BoardWorkItem,
} from "../../lib/daily-report-data";
import {
  workAtStations,
  workLocationText,
  type ReportLocation,
  type ReportSelection,
} from "../../lib/report-map-interaction";

export interface ReportWorkActions {
  selection: ReportSelection | null;
  canShowFront: (pkg: string, front: BoardFront) => boolean;
  onShowFront: (pkg: string, front: BoardFront) => void;
  onHoverFront: (front: BoardFront | null) => void;
  locate: (text: string) => ReportLocation | null;
  onLocate: (location: ReportLocation) => void;
}

export function DailyReportWork({
  report,
  selection,
  canShowFront,
  onShowFront,
  onHoverFront,
  locate,
  onLocate,
  number,
}: ReportWorkActions & {
  report: BoardReport | null;
  number: (value: number) => string;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLElement>(null);
  const groups = useMemo(() => (report ? workByFront(report) : []), [report]);
  useEffect(() => {
    const target =
      root.current?.querySelector<HTMLElement>('[data-selected-work="true"]') ??
      root.current?.querySelector<HTMLElement>('[aria-current="true"]');
    target?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [selection, report]);
  return (
    <section
      ref={root}
      className="daily-report-work overflow-y-auto border-e bg-card p-3 text-sm"
      aria-label={t("roadNetwork.report.work")}
    >
      <h2 className="mb-2 font-semibold">{t("roadNetwork.report.work")}</h2>
      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("roadNetwork.report.none")}</p>
      )}
      {groups.map((group) => {
        const samePackage = !!selection && selection.pkg === report?.pkg;
        const selected =
          samePackage &&
          (selection.frontId === group.id ||
            (!!selection.stations &&
              group.items.some((item) => workAtStations(item, selection.stations!))));
        const show = group.front && report && canShowFront(report.pkg, group.front);
        const label =
          group.front?.name ??
          t(group.isOffice ? "roadNetwork.report.office" : "roadNetwork.report.general");
        const choose = () => group.front && report && onShowFront(report.pkg, group.front);
        return (
          <section
            key={group.id}
            data-front={group.id}
            aria-current={selected ? "true" : undefined}
            className={`mb-3 rounded-md ${selected ? "outline outline-2 outline-primary outline-offset-2" : ""}`}
          >
            <header
              role="group"
              aria-label={label}
              className="sticky top-0 z-10 mb-1 flex items-center gap-2 border-b bg-card py-1"
              onMouseEnter={() => group.front && onHoverFront(group.front)}
              onMouseLeave={() => onHoverFront(null)}
            >
              <h3 className="min-w-0 flex-1 text-xs font-bold uppercase tracking-wide text-primary">
                <button
                  type="button"
                  disabled={!show}
                  aria-label={t("roadNetwork.report.selectFront", { name: label })}
                  className="w-full truncate text-start disabled:cursor-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                  onFocus={() => group.front && onHoverFront(group.front)}
                  onBlur={() => onHoverFront(null)}
                  onClick={choose}
                >
                  {label}
                  {group.front && (
                    <span className="ms-2 font-normal normal-case text-muted-foreground">
                      {frontRange(group.front)}
                    </span>
                  )}
                </button>
              </h3>
              {show && (
                <button
                  type="button"
                  className="shrink-0 text-xs text-primary hover:underline"
                  onClick={choose}
                >
                  {t("roadNetwork.report.showOnMap")}
                </button>
              )}
            </header>
            <ul className="space-y-2">
              {group.items.map((item, i) => (
                <WorkRow
                  key={`${item.group}|${item.name}|${i}`}
                  item={item}
                  number={number}
                  selected={
                    !!selected && !!selection?.stations && workAtStations(item, selection.stations)
                  }
                  location={locate(workLocationText(item))}
                  onLocate={onLocate}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

function WorkRow({
  item,
  number,
  selected,
  location,
  onLocate,
}: {
  item: BoardWorkItem;
  number: (value: number) => string;
  selected: boolean;
  location: ReportLocation | null;
  onLocate: (location: ReportLocation) => void;
}) {
  const { t } = useTranslation();
  const rate = workRate(item);
  const done =
    item.done !== null
      ? `${number(item.done)}${item.planned ? ` / ${number(item.planned)}` : ""} ${item.unit}`.trim()
      : item.doneText;
  return (
    <li
      data-selected-work={selected ? "true" : undefined}
      className={`rounded-md border bg-background p-2 ${selected ? "ring-2 ring-primary" : ""}`}
    >
      {item.group && item.group !== item.name && (
        <p className="truncate text-[11px] font-semibold text-muted-foreground">{item.group}</p>
      )}
      <div className="flex items-start gap-1">
        <p className="min-w-0 flex-1 font-medium leading-snug">{item.name}</p>
        {location && (
          <button
            type="button"
            className="shrink-0 rounded p-1 text-primary hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t("roadNetwork.report.locateWork", { name: item.name })}
            title={t("roadNetwork.report.showOnMap")}
            onClick={() => onLocate(location)}
          >
            <MapPin className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {(done || rate !== null) && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {done && `${t("roadNetwork.report.cumulative")}: ${done}`}
          </span>
          {rate !== null && (
            <>
              <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${Math.min(Math.max(rate, 0), 1) * 100}%` }}
                />
              </span>
              <span className="w-10 text-end font-semibold tabular-nums">
                {number(rate * 100)}%
              </span>
            </>
          )}
        </div>
      )}
      {item.today && (
        <p className="mt-1 text-xs">
          <span className="font-semibold">{t("roadNetwork.report.today")}: </span>
          {item.today}
        </p>
      )}
      {item.tomorrow && (
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold">{t("roadNetwork.report.tomorrow")}: </span>
          {item.tomorrow}
        </p>
      )}
    </li>
  );
}
