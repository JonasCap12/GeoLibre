import { Button } from "@geolibre/ui";
import {
  ChevronLeft,
  ChevronRight,
  CloudSun,
  MapPin,
  Upload,
  Users,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { readPhotos, stepDate, type BoardReport } from "../../lib/daily-report-data";
import { orderedPhotos } from "../../lib/report-map-interaction";
import { DailyReportWork, type ReportWorkActions } from "./DailyReportWork";
import type { useBoardReports } from "./useBoardReports";

/** Object URLs for a report's photos, revoked when the report changes. */
function usePhotoUrls(report: BoardReport | null): Map<string, string> {
  const [urls, setUrls] = useState(new Map<string, string>());
  const ids = useMemo(
    () => (report?.photos ?? []).flatMap((photo) => (photo.id ? [photo.id] : [])),
    [report],
  );
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    void readPhotos(window, ids).then((blobs) => {
      if (!live) return;
      const next = new Map<string, string>();
      for (const [id, blob] of blobs) {
        const url = URL.createObjectURL(blob);
        made.push(url);
        next.set(id, url);
      }
      setUrls(next);
    });
    return () => {
      live = false;
      made.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [ids]);
  return urls;
}

interface DailyReportPanelsProps extends ReportWorkActions {
  reports: ReturnType<typeof useBoardReports>;
  /** Open the original board, where reports are loaded. */
  onLoadReports: () => void;
}

/** The daily report laid out around the map: top bar, work, resources, photos. */
export function DailyReportPanels({
  onLoadReports,
  canShowFront,
  onShowFront,
  reports,
  selection,
  onHoverFront,
  locate,
  onLocate,
}: DailyReportPanelsProps) {
  const { t, i18n } = useTranslation();
  const { index, pkg, date, report, choosePackage, chooseDate } = reports;
  const photoUrls = usePhotoUrls(report);
  const [enlarged, setEnlarged] = useState<number | null>(null);
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format,
    [i18n.language],
  );
  const day = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language, {
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    });
    return (iso: string) => format.format(new Date(`${iso}T00:00:00Z`));
  }, [i18n.language]);
  const photos = useMemo(
    () => (report ? orderedPhotos(report, selection?.pkg === pkg ? selection.frontId : null) : []),
    [report, selection, pkg],
  );
  const packages = Object.keys(index ?? {}).sort();
  const earlier = stepDate(index ?? {}, pkg, date, -1);
  const later = stepDate(index ?? {}, pkg, date, 1);

  useEffect(() => setEnlarged(null), [report]);
  useEffect(() => {
    if (enlarged === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setEnlarged(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enlarged]);

  const loadButton = (
    <Button size="sm" variant="secondary" onClick={onLoadReports}>
      <Upload className="h-3.5 w-3.5 me-1.5" />
      {t("roadNetwork.report.load")}
    </Button>
  );

  if (index !== null && packages.length === 0) {
    return (
      <section className="daily-report-top flex items-center gap-3 border-b bg-card px-4 text-sm">
        <p className="min-w-0 flex-1 text-muted-foreground">{t("roadNetwork.report.empty")}</p>
        {loadButton}
      </section>
    );
  }

  const photo = enlarged !== null ? report?.photos[enlarged] : undefined;
  const photoLocation = photo ? locate(photo.caption) : null;
  return (
    <>
      <section
        className="daily-report-top flex items-center gap-4 border-b bg-card px-4 text-sm"
        aria-label={t("roadNetwork.report.title")}
      >
        <div
          role="group"
          aria-label={t("roadNetwork.report.package")}
          className="flex rounded-md border"
        >
          {packages.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={code === pkg}
              className={`px-2.5 py-1 text-xs font-semibold ${code === pkg ? "bg-primary text-primary-foreground" : "hover:bg-accent"}`}
              onClick={() => choosePackage(code)}
            >
              {code}
            </button>
          ))}
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-bold">{report?.section || pkg}</p>
          <p className="text-xs text-muted-foreground">
            {t("roadNetwork.report.packageCode", { code: pkg })}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={!earlier}
            aria-label={t("roadNetwork.report.earlier")}
            onClick={() => earlier && chooseDate(earlier)}
          >
            <ChevronLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
          <span className="min-w-[8.5rem] text-center font-semibold tabular-nums">
            {date ? day(date) : "—"}
          </span>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            disabled={!later}
            aria-label={t("roadNetwork.report.later")}
            onClick={() => later && chooseDate(later)}
          >
            <ChevronRight className="h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>
        <div className="ms-auto flex items-center gap-5">
          <Figure icon={<CloudSun className="h-4 w-4" />} label={t("roadNetwork.report.weather")}>
            {weatherText(
              report,
              t("roadNetwork.report.morning"),
              t("roadNetwork.report.afternoon"),
            )}
          </Figure>
          <Figure icon={<Users className="h-4 w-4" />} label={t("roadNetwork.report.staff")}>
            {report?.staffTotal == null ? "—" : number(report.staffTotal)}
          </Figure>
          <Figure icon={<Wrench className="h-4 w-4" />} label={t("roadNetwork.report.equipment")}>
            {report?.equipmentTotal == null ? "—" : number(report.equipmentTotal)}
          </Figure>
          {loadButton}
        </div>
      </section>

      <DailyReportWork
        report={report}
        selection={selection}
        canShowFront={canShowFront}
        onShowFront={onShowFront}
        onHoverFront={onHoverFront}
        locate={locate}
        onLocate={onLocate}
        number={number}
      />

      <section
        className="daily-report-side space-y-4 overflow-y-auto border-s bg-card p-3 text-sm"
        aria-label={t("roadNetwork.report.resources")}
      >
        <CountList
          title={t("roadNetwork.report.staff")}
          rows={report?.staff ?? []}
          number={number}
          empty={t("roadNetwork.report.none")}
        />
        <section>
          <h2 className="mb-1 font-semibold">{t("roadNetwork.report.equipment")}</h2>
          {(report?.equipment.length ?? 0) === 0 && (
            <p className="text-xs text-muted-foreground">{t("roadNetwork.report.none")}</p>
          )}
          {report?.equipment.map((group) => (
            <div key={group.name} className="mb-2">
              {group.name && (
                <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                  {group.name}
                </h3>
              )}
              <CountRows rows={group.rows} number={number} />
            </div>
          ))}
        </section>
        <section>
          <h2 className="mb-1 font-semibold">{t("roadNetwork.report.issues")}</h2>
          {(report?.issues.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground">{t("roadNetwork.report.none")}</p>
          ) : (
            <ul className="list-disc space-y-1 ps-4 text-xs">
              {report?.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          )}
        </section>
      </section>

      <section
        className="daily-report-photos flex min-w-0 flex-col border-t bg-card px-3 py-2"
        aria-label={t("roadNetwork.report.photos")}
      >
        <h2 className="mb-1 text-sm font-semibold">{t("roadNetwork.report.photos")}</h2>
        {(report?.photos.length ?? 0) === 0 ? (
          <p className="text-xs text-muted-foreground">{t("roadNetwork.report.noPhotos")}</p>
        ) : (
          <ul className="flex min-h-0 flex-1 gap-2 overflow-x-auto">
            {photos.map(({ photo: item, index: i, dimmed }) => {
              const url = item.id ? photoUrls.get(item.id) : undefined;
              return (
                <li
                  key={`${item.id ?? "photo"}-${i}`}
                  className={`h-full shrink-0 ${dimmed ? "opacity-35" : ""}`}
                >
                  <button
                    type="button"
                    className="flex h-full w-48 flex-col overflow-hidden rounded-md border bg-background text-start"
                    onClick={() => setEnlarged(i)}
                    disabled={!url}
                  >
                    {url ? (
                      <img
                        src={url}
                        alt={item.caption}
                        className="min-h-0 w-full flex-1 object-cover"
                      />
                    ) : (
                      <span className="flex-1 bg-muted" />
                    )}
                    <span className="truncate px-1.5 py-0.5 text-[11px]">
                      {item.caption || "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {photo && photo.id && photoUrls.get(photo.id) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={photo.caption || t("roadNetwork.report.photos")}
          className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/80 p-6"
          onClick={() => setEnlarged(null)}
        >
          <img
            src={photoUrls.get(photo.id)}
            alt={photo.caption}
            className="max-h-[85vh] max-w-full rounded"
          />
          {photo.caption && (
            <p className="max-w-3xl text-center text-sm text-white">{photo.caption}</p>
          )}
          {photoLocation && (
            <Button
              variant="secondary"
              onClick={(event) => {
                event.stopPropagation();
                onLocate(photoLocation);
                setEnlarged(null);
              }}
              aria-label={t("roadNetwork.report.locatePhoto")}
            >
              <MapPin className="h-4 w-4 me-1.5" />
              {t("roadNetwork.report.showOnMap")}
            </Button>
          )}
          <Button
            size="icon"
            variant="secondary"
            className="absolute end-4 top-4"
            aria-label={t("roadNetwork.report.closePhoto")}
            onClick={() => setEnlarged(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </>
  );
}

/** One condition when morning and afternoon agree, otherwise both, labelled. */
function weatherText(
  report: BoardReport | null,
  morningLabel: string,
  afternoonLabel: string,
): string {
  const { morning, afternoon } = report?.weather ?? { morning: "", afternoon: "" };
  if (!morning || !afternoon || morning === afternoon) return morning || afternoon || "—";
  return `${morningLabel} ${morning} · ${afternoonLabel} ${afternoon}`;
}

function Figure({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <div>
        <p className="text-[11px] uppercase leading-none text-muted-foreground">{label}</p>
        <p className="font-semibold tabular-nums">{children}</p>
      </div>
    </div>
  );
}

function CountRows({
  rows,
  number,
}: {
  rows: readonly { name: string; total: number }[];
  number: (value: number) => string;
}) {
  return (
    <ul className="text-xs">
      {rows.map((row, i) => (
        <li
          key={`${row.name}-${i}`}
          className="flex justify-between gap-2 border-b border-border/50 py-0.5"
        >
          <span className="min-w-0 truncate">{row.name}</span>
          <span className="font-semibold tabular-nums">{number(row.total)}</span>
        </li>
      ))}
    </ul>
  );
}

function CountList({
  title,
  rows,
  number,
  empty,
}: {
  title: string;
  rows: readonly { name: string; total: number }[];
  number: (value: number) => string;
  empty: string;
}) {
  return (
    <section>
      <h2 className="mb-1 font-semibold">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <CountRows rows={rows} number={number} />
      )}
    </section>
  );
}
