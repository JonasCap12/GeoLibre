import { AlertTriangle, PauseCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { readPhotos } from "../../lib/daily-report-data";
import { placeCard, type StructureCard, type StructureItem } from "../../lib/structure-card";

/** An object URL for one board photo, revoked when the photo changes. */
function usePhotoUrl(id: string | null): string | null {
  const [url, setUrl] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    let made: string | null = null;
    void readPhotos(window, [id]).then((blobs) => {
      const blob = blobs.get(id);
      if (!live || !blob) return;
      made = URL.createObjectURL(blob);
      setUrl({ id, url: made });
    });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id]);
  return url && url.id === id ? url.url : null;
}

interface StructureHoverCardProps {
  card: StructureCard;
  pointer: { x: number; y: number };
  /** Clicking the point selects it in the report (the split view only). */
  showClickHint: boolean;
}

/** The structure under the pointer, from the daily report being viewed. */
export function StructureHoverCard({ card, pointer, showClickHint }: StructureHoverCardProps) {
  const { t, i18n } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const photoUrl = usePhotoUrl(card.photo?.id ?? null);
  const number = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format,
    [i18n.language],
  );
  const day = useMemo(() => {
    const format = new Intl.DateTimeFormat(i18n.language, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      timeZone: "UTC",
    });
    return (iso: string) => format.format(new Date(`${iso}T00:00:00Z`));
  }, [i18n.language]);

  // Placed before paint, so the card never flashes past the viewport's edge.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const { left, top } = placeCard(
      pointer,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  });

  const pkg = card.fromReport ? t("roadNetwork.report.packageCode", { code: card.pkg }) : card.pkg;
  const place = [card.kind, pkg, card.front].filter(Boolean).join(" · ");
  const week = card.week;
  const gain = week?.gain;
  const weekText = week
    ? `${
        week.changes.length
          ? week.changes
              .map((change) => `${change.name} +${number(change.added)} ${change.unit}`.trim())
              .join("; ")
          : t("roadNetwork.structure.weekNone")
      }${gain ? ` (${gain > 0 ? "+" : ""}${number(gain)}%)` : ""}`
    : "";

  return (
    <div
      ref={root}
      role="tooltip"
      className="pointer-events-none fixed z-50 w-80 rounded-md border bg-popover text-xs text-popover-foreground shadow-lg"
      style={{ left: pointer.x + 12, top: pointer.y + 12 }}
    >
      <div className="border-b px-3 py-2">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm font-semibold leading-snug">{card.name}</p>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
              card.done
                ? "bg-green-600/15 text-green-700 dark:text-green-400"
                : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
            }`}
          >
            {card.done ? t("roadNetwork.structure.done") : t("roadNetwork.structure.active")}
          </span>
        </div>
        {place && <p className="text-muted-foreground">{place}</p>}
        {card.date && (
          <p className="text-muted-foreground">
            {t("roadNetwork.structure.reportDate", { date: day(card.date) })}
          </p>
        )}
      </div>

      <div className="space-y-2 px-3 py-2">
        {card.percent !== null && (
          <div>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{t("roadNetwork.structure.progress")}</span>
              <Bar percent={card.percent} className="h-2 flex-1" />
              <span className="w-12 text-end font-semibold tabular-nums">
                {number(card.percent)}%
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {t("roadNetwork.structure.measured", { measured: card.measured, total: card.total })}
            </p>
          </div>
        )}

        {card.items.length > 0 ? (
          <ul className="space-y-1">
            {card.items.map((item, i) => (
              <ItemRow key={`${item.name}-${i}`} item={item} number={number} />
            ))}
            {card.more > 0 && (
              <li className="text-muted-foreground">
                {t("roadNetwork.structure.more", { count: card.more })}
              </li>
            )}
          </ul>
        ) : (
          card.fromReport &&
          card.date && (
            <p className="text-muted-foreground">
              {t("roadNetwork.structure.noItems", { date: day(card.date) })}
            </p>
          )
        )}

        {week && (
          <p>
            <span className="font-semibold">{t("roadNetwork.structure.week")}: </span>
            {weekText}
          </p>
        )}
        {card.stalled && (
          <p className="flex items-center gap-1 font-semibold text-amber-700 dark:text-amber-300">
            <PauseCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {card.stalled.atLeast
              ? t("roadNetwork.structure.stalledLong", { count: card.stalled.days })
              : t("roadNetwork.structure.stalled", { count: card.stalled.days })}
          </p>
        )}
        {card.today && (
          <p>
            <span className="font-semibold">{t("roadNetwork.report.today")}: </span>
            {card.today}
          </p>
        )}
        {card.tomorrow && (
          <p className="text-muted-foreground">
            <span className="font-semibold">{t("roadNetwork.report.tomorrow")}: </span>
            {card.tomorrow}
          </p>
        )}
        {card.issues.map((issue, i) => (
          <p key={i} className="flex items-start gap-1 text-red-700 dark:text-red-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-semibold">{t("roadNetwork.report.issues")}: </span>
              {issue}
            </span>
          </p>
        ))}
        {card.photo && photoUrl && (
          <figure>
            <img
              src={photoUrl}
              alt={card.photo.caption}
              className="h-28 w-full rounded object-cover"
            />
            {card.photo.caption && (
              <figcaption className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {card.photo.caption}
              </figcaption>
            )}
          </figure>
        )}
      </div>

      {showClickHint && (
        <p className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {t("roadNetwork.structure.clickHint")}
        </p>
      )}
    </div>
  );
}

function Bar({ percent, className }: { percent: number; className: string }) {
  return (
    <span className={`overflow-hidden rounded-full bg-muted ${className}`} aria-hidden="true">
      <span
        className="block h-full rounded-full bg-primary"
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
      />
    </span>
  );
}

function ItemRow({ item, number }: { item: StructureItem; number: (value: number) => string }) {
  const { t } = useTranslation();
  const quantity =
    item.done !== null && item.planned
      ? `${number(item.done)}/${number(item.planned)} ${item.unit}`.trim()
      : null;
  return (
    <li className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate" title={item.name}>
        {item.name}
      </span>
      {item.percent === null ? (
        <span className="shrink-0 text-[11px] italic text-muted-foreground">
          {item.planned === null
            ? t("roadNetwork.structure.noDesign")
            : t("roadNetwork.structure.noDone")}
        </span>
      ) : (
        <>
          {quantity && (
            <span className="shrink-0 tabular-nums text-muted-foreground">{quantity}</span>
          )}
          <Bar percent={item.percent} className="h-1.5 w-10 shrink-0" />
          <span className="w-10 shrink-0 text-end font-semibold tabular-nums">
            {number(item.percent)}%
          </span>
        </>
      )}
    </li>
  );
}
