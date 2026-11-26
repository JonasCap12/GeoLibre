import {
  chainages,
  workRate,
  type BoardPhoto,
  type BoardReport,
  type BoardWorkItem,
  type ReportIndex,
} from "./daily-report-data";
import { foldText } from "./network-dashboard";
import { structureSelection } from "./report-map-interaction";

/**
 * What the dashboard shows when the pointer rests on a structure point (a
 * bridge, culvert, underpass…): its work items from the daily report being
 * viewed, the past week's change, how long it has stood still, today's and
 * tomorrow's work, the issues and the latest photo that name its chainage.
 *
 * A structure's work is the report group whose label carries exactly one
 * chainage, the structure's own (the same rule the BL-LK map generator uses),
 * and its progress is the mean of those items' done ÷ planned.
 */

/** Chainages written by hand differ by rounding: within a metre is the same place. */
const SAME_PLACE_M = 1;
const DAY_MS = 86_400_000;
/** How far back the card reads earlier reports (covers the week and a stall). */
export const STRUCTURE_HISTORY_DAYS = 14;
const WEEK_DAYS = 7;
/** A structure with no added quantity for this many days is flagged. */
export const STALL_DAYS = 3;
const ITEM_LIMIT = 5;
const TEXT_LIMIT = 140;

export interface StructureItem {
  name: string;
  unit: string;
  done: number | null;
  planned: number | null;
  /** 0–100, or null when the item has no design quantity. */
  percent: number | null;
}

export interface StructureWeek {
  /** ISO date of the report compared against. */
  since: string;
  changes: { name: string; added: number; unit: string }[];
  /** Mean change in percentage points of the items measured on both days. */
  gain: number | null;
}

export interface StructureCard {
  /** False when read from the point's attributes, with no report loaded. */
  fromReport: boolean;
  name: string;
  kind: string;
  pkg: string;
  front: string | null;
  /** ISO date of the report the card reads, or null. */
  date: string | null;
  done: boolean;
  percent: number | null;
  /** Items with a design quantity, which the percentage is the mean of. */
  measured: number;
  total: number;
  items: StructureItem[];
  /** Items left out of `items` for space. */
  more: number;
  week: StructureWeek | null;
  stalled: { days: number; atLeast: boolean } | null;
  today: string;
  tomorrow: string;
  issues: string[];
  photo: BoardPhoto | null;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const itemKey = (item: BoardWorkItem) => `${squash(item.group)}|${squash(item.name)}`;
const round1 = (value: number) => Math.round(value * 10) / 10;
const near = (station: number) => (text: string) =>
  chainages(text).some((at) => Math.abs(at - station) <= SAME_PLACE_M);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

function shorten(text: string): string {
  const flat = squash(text);
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat;
}

/** The report's work for a structure: groups labelled with exactly its chainage. */
export function structureWork(report: BoardReport, station: number): BoardWorkItem[] {
  return report.work.filter((item) => {
    if (item.part === "NN") return false;
    const at = chainages(item.group);
    return at.length === 1 && Math.abs(at[0] - station) <= SAME_PLACE_M;
  });
}

function progress(items: readonly BoardWorkItem[]): { percent: number | null; measured: number } {
  const rates = items.flatMap((item) => {
    const rate = workRate(item);
    return rate === null ? [] : [Math.min(Math.max(rate, 0), 1)];
  });
  return {
    percent: rates.length ? round1((rates.reduce((a, b) => a + b, 0) / rates.length) * 100) : null,
    measured: rates.length,
  };
}

/**
 * Complete only when every item has figures and they average 100%: an item
 * with no figures yet (a pier body after its footing) is work still to come.
 */
function isComplete(percent: number | null, measured: number, total: number): boolean {
  return percent !== null && percent >= 100 && measured === total;
}

/** Quantities added since `before`, and the mean change of the items measured both days. */
export function weekChange(
  items: readonly BoardWorkItem[],
  before: BoardReport | null,
  station: number,
): StructureWeek | null {
  // Without any done quantity there is nothing to compare: say nothing rather than "no change".
  if (!before || items.every((item) => item.done === null && workRate(item) === null)) return null;
  const earlier = new Map(structureWork(before, station).map((item) => [itemKey(item), item]));
  const changes: StructureWeek["changes"] = [];
  const gains: number[] = [];
  for (const item of items) {
    const was = earlier.get(itemKey(item));
    // An item absent a week ago started since: all of its quantity is new.
    const added = item.done === null ? 0 : item.done - (was?.done ?? 0);
    if (added > 0) changes.push({ name: squash(item.name), added, unit: item.unit });
    const now = workRate(item);
    const then = was ? workRate(was) : null;
    if (now !== null && then !== null) gains.push(Math.min(now, 1) - Math.min(then, 1));
  }
  return {
    since: before.date,
    changes,
    gain: gains.length ? round1((gains.reduce((a, b) => a + b, 0) / gains.length) * 100) : null,
  };
}

/** Items with a done quantity still short of their design quantity: the ones that should move. */
const unfinished = (items: readonly BoardWorkItem[]) =>
  items.filter((item) => item.done !== null && !(item.planned && item.done >= item.planned));

/**
 * Days the done quantities of the structure's unfinished items have not
 * changed, counted between reports (`earlier` newest first). `atLeast` when
 * no loaded report shows a change. A finished item is expected to stand still.
 */
export function stalledFor(
  report: BoardReport,
  items: readonly BoardWorkItem[],
  earlier: readonly BoardReport[],
  station: number,
): StructureCard["stalled"] {
  const open = unfinished(items);
  if (open.length === 0 || earlier.length === 0) return null;
  let since = report.date;
  let changed = false;
  for (const previous of earlier) {
    const then = new Map(
      structureWork(previous, station).map((item) => [itemKey(item), item.done]),
    );
    const moved = open.some((item) => {
      const was = then.get(itemKey(item));
      return was === undefined || was === null || Math.abs(was - item.done!) > 1e-9;
    });
    if (moved) {
      changed = true;
      break;
    }
    since = previous.date;
  }
  const span = days(since, report.date);
  return span >= STALL_DAYS ? { days: span, atLeast: !changed } : null;
}

function joinTexts(items: readonly BoardWorkItem[], pick: (item: BoardWorkItem) => string) {
  return shorten([...new Set(items.map(pick).map(squash).filter(Boolean))].join(" · "));
}

const toItem = (item: BoardWorkItem): StructureItem => {
  const rate = workRate(item);
  return {
    name: squash(item.name),
    unit: item.unit,
    done: item.done,
    planned: item.planned,
    percent: rate === null ? null : round1(Math.min(Math.max(rate, 0), 1) * 100),
  };
};

/** The first property whose folded key matches, as trimmed text. */
function property(properties: Record<string, unknown>, key: RegExp): string {
  for (const [name, value] of Object.entries(properties)) {
    if (key.test(foldText(name).replace(/\s+/g, "_")) && String(value ?? "").trim()) {
      return String(value).trim();
    }
  }
  return "";
}

const KIND_KEY = /^(loai|loai_cong_trinh|kind|structure_?type)$/;
const PACKAGE_KEY = /^(goi_?thau|goi|package|package_?code)$/;

/** "20/11/2026" → "2026-11-20"; anything else → null. */
function isoDate(text: string): string | null {
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : null;
}

/**
 * The card from the point's own attributes, for a map opened without the
 * board's reports. It reads the generator's "name 33.3%; name (…)" work list.
 */
export function cardFromProperties(
  name: string,
  properties: Record<string, unknown>,
): StructureCard {
  const percentText = property(properties, /^(tien_do_pct|progress|percent)$/);
  const percent = percentText ? Number(percentText.replace(",", ".")) : null;
  const work = property(properties, /^(cong_tac|work)$/)
    .split(/;\s*/)
    .filter(Boolean)
    .map((text): StructureItem => {
      const match = text.match(/^(.*?)\s+(\d+(?:[.,]\d+)?)%$/);
      return {
        name: squash((match?.[1] ?? text).replace(/\(.*?\)\s*$/, "")),
        unit: "",
        done: null,
        planned: null,
        percent: match ? Number(match[2].replace(",", ".")) : null,
      };
    });
  const valid = percent !== null && Number.isFinite(percent) ? percent : null;
  const measured = work.filter((item) => item.percent !== null).length;
  return {
    fromReport: false,
    name,
    kind: property(properties, KIND_KEY),
    pkg: property(properties, PACKAGE_KEY),
    front: null,
    date: isoDate(property(properties, /^(ngay_bao_cao|report_?date)$/)),
    done: isComplete(valid, measured, work.length),
    percent: valid,
    measured,
    total: work.length,
    items: work.slice(0, ITEM_LIMIT),
    more: Math.max(0, work.length - ITEM_LIMIT),
    week: null,
    stalled: null,
    today: "",
    tomorrow: "",
    issues: [],
    photo: null,
  };
}

/**
 * The card for a structure point. `reports` are the reports the dashboard
 * shows per package; `history` holds each package's earlier reports, newest
 * first. Falls back to the point's attributes when no report covers it.
 */
export function structureCard(
  name: string,
  properties: Record<string, unknown>,
  reports: readonly BoardReport[],
  history: ReadonlyMap<string, readonly BoardReport[]>,
): StructureCard {
  const selection = structureSelection(name, properties, reports);
  const report = selection && reports.find((item) => item.pkg === selection.pkg);
  const station = selection?.stations?.[0];
  if (!report || station === undefined) return cardFromProperties(name, properties);
  const items = structureWork(report, station);
  const earlier = (history.get(report.pkg) ?? []).filter((item) => item.date < report.date);
  const weekAgo = earlier.find((item) => days(item.date, report.date) >= WEEK_DAYS) ?? null;
  const { percent, measured } = progress(items);
  const done = isComplete(percent, measured, items.length);
  const mentions = near(station);
  return {
    fromReport: true,
    name,
    kind: property(properties, KIND_KEY),
    pkg: report.pkg,
    front: report.fronts.find((front) => front.id === selection.frontId)?.name ?? null,
    date: report.date,
    done,
    percent,
    measured,
    total: items.length,
    items: items.slice(0, ITEM_LIMIT).map(toItem),
    more: Math.max(0, items.length - ITEM_LIMIT),
    week: weekChange(items, weekAgo, station),
    stalled: done ? null : stalledFor(report, items, earlier, station),
    today: joinTexts(items, (item) => item.today),
    tomorrow: joinTexts(items, (item) => item.tomorrow),
    issues: report.issues.filter(mentions).map(shorten),
    photo: [...report.photos].reverse().find((photo) => mentions(photo.caption)) ?? null,
  };
}

/**
 * Board keys of each shown report's earlier days within the history window,
 * so one read fetches every report the cards compare against.
 */
export function historyKeys(index: ReportIndex, reports: readonly BoardReport[]): string[] {
  return reports.flatMap((report) =>
    (index[report.pkg] ?? [])
      .filter((date) => {
        const back = days(date, report.date);
        return back > 0 && back <= STRUCTURE_HISTORY_DAYS;
      })
      .map((date) => `bcn_${report.pkg}/${date}`),
  );
}

/** Reports grouped by package, newest first. */
export function groupHistory(reports: readonly BoardReport[]): Map<string, BoardReport[]> {
  const grouped = new Map<string, BoardReport[]>();
  for (const report of [...reports].sort((a, b) => b.date.localeCompare(a.date))) {
    grouped.set(report.pkg, [...(grouped.get(report.pkg) ?? []), report]);
  }
  return grouped;
}

/** Where a card of `size` goes beside the pointer, kept inside the viewport. */
export function placeCard(
  pointer: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 12,
  margin = 8,
): { left: number; top: number } {
  const fit = (at: number, length: number, room: number) => {
    if (at + gap + length <= room - margin) return at + gap;
    if (at - gap - length >= margin) return at - gap - length;
    return Math.max(margin, room - margin - length);
  };
  return {
    left: fit(pointer.x, size.width, viewport.width),
    top: fit(pointer.y, size.height, viewport.height),
  };
}
