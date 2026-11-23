/**
 * Reads the daily reports the embedded board (`public/daily-report/`) has
 * stored, so the dashboard can lay them out around the map. The board owns
 * this data: IndexedDB `bcn-bangdien`, store `docs` (`bcn/meta` lists each
 * package's dates; `bcn_<package>/<date>` is one parsed report) and store
 * `imgs` (photo blobs by id). Everything here only reads, and treats what it
 * reads as untrusted: a missing or odd field becomes an empty value.
 */

const DB_NAME = "bcn-bangdien";
const META_KEY = "bcn/meta";
/** The board's work-front id for its site office ("Ban điều hành"). */
const OFFICE = "BDH";
/** Grouping for work that no front's chainage covers. */
export const GENERAL_GROUP = "CHUNG";

export interface BoardFront {
  id: string;
  name: string;
  /** Chainage in metres (Km126+484,93 → 126484.93), either order; null if the report has none. */
  km0: number | null;
  km1: number | null;
}

export interface BoardWorkItem {
  part: string;
  name: string;
  group: string;
  front: string | null;
  unit: string;
  planned: number | null;
  done: number | null;
  doneText: string;
  rateInFile: number | null;
  today: string;
  tomorrow: string;
  status: string;
}

export interface BoardCount {
  name: string;
  total: number;
}

export interface BoardPhoto {
  caption: string;
  id: string | null;
}

export interface BoardReport {
  pkg: string;
  /** ISO date, yyyy-mm-dd. */
  date: string;
  section: string;
  weather: { morning: string; afternoon: string };
  fronts: BoardFront[];
  staffTotal: number | null;
  equipmentTotal: number | null;
  staff: BoardCount[];
  equipment: { name: string; rows: BoardCount[] }[];
  work: BoardWorkItem[];
  issues: string[];
  photos: BoardPhoto[];
}

/** Each package's report dates, oldest first. */
export type ReportIndex = Record<string, string[]>;

// --- Narrowing untrusted values -------------------------------------------------

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function count(value: unknown): BoardCount | null {
  const row = record(value);
  const name = text(row.name);
  const total = num(row.total);
  return name && total !== null ? { name, total } : null;
}

/** The meta document's package → dates index; empty when there is none. */
export function parseReportIndex(value: unknown): ReportIndex {
  const index: ReportIndex = {};
  for (const [pkg, dates] of Object.entries(record(record(value).idx))) {
    const valid = list(dates)
      .map(text)
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
    if (valid.length) index[pkg] = [...new Set(valid)].sort();
  }
  return index;
}

/** One stored report, or null when it is not a report. */
export function parseBoardReport(value: unknown): BoardReport | null {
  const raw = record(value);
  const pkg = text(raw.goi);
  const date = text(raw.date);
  if (!pkg || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const weather = record(raw.weather);
  const staff = record(raw.staff);
  const equip = record(raw.equip);
  return {
    pkg,
    date,
    section: text(raw.doan),
    weather: { morning: text(weather.am), afternoon: text(weather.pm) },
    fronts: list(raw.mui).flatMap((item) => {
      const front = record(item);
      const id = text(front.id);
      return id
        ? [{ id, name: text(front.name) || id, km0: num(front.km0), km1: num(front.km1) }]
        : [];
    }),
    staffTotal: num(record(staff.total).ALL),
    equipmentTotal: num(record(equip.total).ALL),
    staff: list(staff.rows).flatMap((row) => count(row) ?? []),
    equipment: list(equip.groups).flatMap((item) => {
      const group = record(item);
      const rows = list(group.rows).flatMap((row) => count(row) ?? []);
      return rows.length ? [{ name: text(group.name), rows }] : [];
    }),
    work: list(raw.work).flatMap((item) => {
      const work = record(item);
      const name = text(work.name);
      if (!name) return [];
      return [
        {
          part: text(work.part),
          name,
          group: text(work.grp),
          front: text(work.mui) || null,
          unit: text(work.unit),
          planned: num(work.bvtk),
          done: num(work.lk),
          doneText: text(work.lkText),
          rateInFile: num(work.rateFile),
          today: text(work.today),
          tomorrow: text(work.tomorrow),
          status: text(work.status),
        },
      ];
    }),
    issues: list(raw.issues).map(text).filter(Boolean),
    photos: list(raw.photos).map((item) => {
      const photo = record(item);
      return { caption: text(photo.caption), id: text(record(photo.ref).id) || null };
    }),
  };
}

// --- Shaping a report for display -----------------------------------------------

/** Chainages written in a text ("Km148+225- Km149+080" → [148225, 149080]), in metres. */
export function chainages(value: string): number[] {
  const found: number[] = [];
  for (const match of value.matchAll(/km\s*(\d+)\s*\+\s*(\d+(?:[.,]\d+)?)/gi)) {
    found.push(Number(match[1]) * 1000 + Number(match[2].replace(",", ".")));
  }
  return found;
}

/** Done ÷ planned, or the file's own percentage; 0–1, null when unknown. */
export function workRate(item: BoardWorkItem): number | null {
  if (item.done !== null && item.planned) return item.done / item.planned;
  return item.rateInFile;
}

/**
 * The front a work item belongs to. Chainage in its text decides first: the
 * board's own parser files a range that starts on a boundary ("Km186+900 –
 * Km192+419") under the front before it.
 */
export function frontOf(item: BoardWorkItem, fronts: readonly BoardFront[]): string {
  if (item.part === "NN" || item.front === OFFICE) return OFFICE;
  const [first] = chainages(`${item.group} ${item.name}`);
  if (first !== undefined) {
    const ranged = fronts.filter((front) => front.km0 !== null && front.km1 !== null);
    const covers = (front: BoardFront, end: (lo: number, hi: number) => boolean) => {
      const lo = Math.min(front.km0!, front.km1!);
      const hi = Math.max(front.km0!, front.km1!);
      return first >= lo && end(first, hi);
    };
    const hit =
      ranged.find((front) => covers(front, (at, hi) => at < hi)) ??
      ranged.find((front) => covers(front, (at, hi) => at <= hi));
    if (hit) return hit.id;
  }
  if (item.front && fronts.some((front) => front.id === item.front)) return item.front;
  return GENERAL_GROUP;
}

export interface WorkGroup {
  /** A front id, GENERAL_GROUP or the site office. */
  id: string;
  front: BoardFront | null;
  isOffice: boolean;
  items: BoardWorkItem[];
}

/** The report's work, by front in the report's order, then general work, then the office. */
export function workByFront(report: BoardReport): WorkGroup[] {
  const byId = new Map<string, BoardWorkItem[]>();
  for (const item of report.work) {
    const id = frontOf(item, report.fronts);
    byId.set(id, [...(byId.get(id) ?? []), item]);
  }
  const order = [...report.fronts.map((front) => front.id), GENERAL_GROUP, OFFICE];
  return order.flatMap((id) => {
    const items = byId.get(id);
    if (!items?.length) return [];
    return [
      {
        id,
        front: report.fronts.find((front) => front.id === id) ?? null,
        isOffice: id === OFFICE,
        items,
      },
    ];
  });
}

/** "Km185+000 – Km186+900" for a front with a range; "" without. */
export function frontRange(front: BoardFront): string {
  if (front.km0 === null || front.km1 === null) return "";
  const km = (metres: number) => {
    const rest = Math.round((metres % 1000) * 100) / 100;
    const [whole, fraction] = String(rest).split(".");
    return `Km${Math.floor(metres / 1000)}+${whole.padStart(3, "0")}${fraction ? `,${fraction}` : ""}`;
  };
  return `${km(Math.min(front.km0, front.km1))} – ${km(Math.max(front.km0, front.km1))}`;
}

/** The package to show first: one with reports, in the board's order. */
export function firstPackage(index: ReportIndex): string | null {
  return Object.keys(index).sort()[0] ?? null;
}

/** The latest report date of a package, or null. */
export function latestDate(index: ReportIndex, pkg: string | null): string | null {
  return (pkg && index[pkg]?.at(-1)) || null;
}

/** The report date next to `date` in a package (step −1 earlier, +1 later), or null at an end. */
export function stepDate(
  index: ReportIndex,
  pkg: string | null,
  date: string | null,
  step: -1 | 1,
): string | null {
  const dates = (pkg && index[pkg]) || [];
  const at = date ? dates.indexOf(date) : -1;
  if (at < 0) return null;
  return dates[at + step] ?? null;
}

const fold = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();
const words = (value: string) =>
  fold(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * The map lines that draw one work front: their name carries both the package
 * code and the front's name ("XL02 · Mũi 03" for package XL02, "Mũi 03").
 */
export function linesForFront<T extends { name: string }>(
  lines: readonly T[],
  pkg: string,
  front: BoardFront,
): T[] {
  const code = words(pkg).join("");
  const frontWords = words(front.name);
  if (!code || !frontWords.length) return [];
  return lines.filter((line) => {
    const name = words(line.name);
    const hasFront = name.some((_, i) => frontWords.every((part, j) => name[i + j] === part));
    return name.includes(code) && hasFront;
  });
}

// --- Reading the board's IndexedDB -----------------------------------------------

/**
 * Reads keys from one of the board's stores in a readonly transaction. Never
 * creates the database: if the board has not made it yet, this answers null.
 */
export function readBoardStore(
  host: Pick<Window, "indexedDB">,
  store: "docs" | "imgs",
  keys: readonly string[],
): Promise<Map<string, unknown> | null> {
  return new Promise((resolve) => {
    try {
      const request = host.indexedDB.open(DB_NAME);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const db = request.result;
        const finish = (values: Map<string, unknown> | null) => {
          db.close();
          resolve(values);
        };
        try {
          if (!db.objectStoreNames.contains(store)) {
            finish(null);
            return;
          }
          const transaction = db.transaction(store, "readonly");
          const objects = transaction.objectStore(store);
          const pending = keys.map((key) => [key, objects.get(key)] as const);
          transaction.oncomplete = () =>
            finish(new Map(pending.map(([key, got]) => [key, got.result])));
          transaction.onerror = transaction.onabort = () => finish(null);
        } catch {
          finish(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

/** The board's package → dates index; null when its storage cannot be read. */
export async function readReportIndex(
  host: Pick<Window, "indexedDB">,
): Promise<ReportIndex | null> {
  const docs = await readBoardStore(host, "docs", [META_KEY]);
  return docs ? parseReportIndex(docs.get(META_KEY)) : null;
}

/** One stored report, or null. */
export async function readReport(
  host: Pick<Window, "indexedDB">,
  pkg: string,
  date: string,
): Promise<BoardReport | null> {
  const key = `bcn_${pkg}/${date}`;
  const docs = await readBoardStore(host, "docs", [key]);
  return docs ? parseBoardReport(docs.get(key)) : null;
}

/** Photo blobs by id; ids the board does not have are left out. */
export async function readPhotos(
  host: Pick<Window, "indexedDB">,
  ids: readonly string[],
): Promise<Map<string, Blob>> {
  const found = new Map<string, Blob>();
  if (!ids.length) return found;
  const values = await readBoardStore(host, "imgs", ids);
  for (const [id, value] of values ?? []) if (value instanceof Blob) found.set(id, value);
  return found;
}
