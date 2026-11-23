import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainages,
  firstPackage,
  frontOf,
  frontRange,
  GENERAL_GROUP,
  latestDate,
  linesForFront,
  parseBoardReport,
  parseReportIndex,
  readBoardStore,
  readPhotos,
  readReport,
  readReportIndex,
  stepDate,
  workByFront,
  workRate,
  type BoardWorkItem,
} from "../apps/geolibre-desktop/src/lib/daily-report-data";

/** A report as the board's parser stores it (XL05, 19/11/2026, trimmed). */
const STORED = {
  goi: "XL05",
  date: "2026-11-19",
  doan: "Km185+000 – Km200+100",
  weather: { am: "Mưa (7:00-12:00)", pm: "Nắng" },
  mui: [
    { id: "M01", name: "Mũi 01", km0: 185000, km1: 186900 },
    { id: "M02", name: "Mũi 02", km0: 186900, km1: 192419 },
    { id: "M03", name: "Mũi 03", km0: 192419, km1: 196000 },
  ],
  staff: {
    rows: [
      { name: "Chỉ huy trưởng", by: {}, total: 1 },
      { name: "", total: 3 },
    ],
    total: { ALL: 100 },
  },
  equip: {
    groups: [
      { code: "B.1", name: "Phần đường", rows: [{ name: "Máy đào", total: 21 }] },
      { code: "B.2", name: "Trống", rows: [] },
    ],
    total: { ALL: 84 },
  },
  work: [
    {
      part: "D",
      grp: "Km185+000-Km186+900",
      name: "Phát quang",
      mui: "M01",
      unit: "md",
      bvtk: 1900,
      lk: 1800,
    },
    // The board's parser files this boundary range under M01.
    {
      part: "D",
      grp: "Km186+900 - Km192+419",
      name: "Phát quang",
      mui: "M01",
      unit: "md",
      bvtk: 5519,
      lk: 4100,
      today: "Phát quang 200 m",
    },
    { part: "C", grp: "CVN Km193+879", name: "Đào móng", mui: "M03", rateFile: 0.9 },
    { part: "C", grp: "Cầu ngoài tuyến", name: "Khảo sát", mui: "M09" },
    { part: "NN", name: "Trình hồ sơ vật liệu", mui: "BDH" },
    { part: "D", name: "  " },
  ],
  issues: ["Mưa lớn buổi sáng", ""],
  photos: [
    { caption: "Mũi 1: đào móng", ref: { id: "Labc" } },
    { caption: "", ref: null },
  ],
};

const item = (patch: Partial<BoardWorkItem>): BoardWorkItem => ({
  part: "D",
  name: "x",
  group: "",
  front: null,
  unit: "",
  planned: null,
  done: null,
  doneText: "",
  rateInFile: null,
  today: "",
  tomorrow: "",
  status: "",
  ...patch,
});

describe("daily report data: parsing what the board stored", () => {
  it("keeps the fields the panels show and drops empty rows", () => {
    const report = parseBoardReport(STORED)!;
    assert.equal(report.pkg, "XL05");
    assert.equal(report.section, "Km185+000 – Km200+100");
    assert.deepEqual(report.weather, { morning: "Mưa (7:00-12:00)", afternoon: "Nắng" });
    assert.equal(report.staffTotal, 100);
    assert.equal(report.equipmentTotal, 84);
    assert.deepEqual(report.staff, [{ name: "Chỉ huy trưởng", total: 1 }]);
    assert.deepEqual(report.equipment, [
      { name: "Phần đường", rows: [{ name: "Máy đào", total: 21 }] },
    ]);
    assert.equal(report.work.length, 5, "the nameless row is dropped");
    assert.deepEqual(report.issues, ["Mưa lớn buổi sáng"]);
    assert.deepEqual(report.photos, [
      { caption: "Mũi 1: đào móng", id: "Labc" },
      { caption: "", id: null },
    ]);
  });

  it("rejects what is not a report", () => {
    for (const value of [null, 3, [], {}, { goi: "XL01" }, { goi: "XL01", date: "19/11" }]) {
      assert.equal(parseBoardReport(value), null);
    }
  });

  it("reads the package → dates index, sorted and de-duplicated", () => {
    const index = parseReportIndex({
      idx: { XL05: ["2026-11-19", "2026-11-18", "2026-11-19", "bad"], XL01: [], XL02: "no" },
    });
    assert.deepEqual(index, { XL05: ["2026-11-18", "2026-11-19"] });
    assert.deepEqual(parseReportIndex(undefined), {});
  });
});

describe("daily report data: shaping for display", () => {
  const report = parseBoardReport(STORED)!;

  it("reads chainages in metres, with comma decimals", () => {
    assert.deepEqual(chainages("Km148+225- Km149+080"), [148225, 149080]);
    assert.deepEqual(chainages("đoạn km 126 + 484,93"), [126484.93]);
    assert.deepEqual(chainages("Nội nghiệp"), []);
  });

  it("files work by the chainage it names, boundary ranges under the front they start", () => {
    const groups = workByFront(report);
    assert.deepEqual(
      groups.map((group) => [group.id, group.items.length]),
      [
        ["M01", 1],
        ["M02", 1],
        ["M03", 1],
        [GENERAL_GROUP, 1],
        ["BDH", 1],
      ],
    );
    assert.equal(groups[1].items[0].today, "Phát quang 200 m");
    assert.equal(groups.at(-1)!.isOffice, true);
  });

  it("puts a chainage on the last front's end into that front", () => {
    assert.equal(frontOf(item({ group: "CH Km196+000" }), report.fronts), "M03");
    assert.equal(frontOf(item({ group: "CH Km199+000" }), report.fronts), GENERAL_GROUP);
    assert.equal(frontOf(item({ front: "M02" }), report.fronts), "M02");
  });

  it("rates done against planned, else the file's percentage", () => {
    assert.equal(workRate(item({ done: 50, planned: 200 })), 0.25);
    assert.equal(workRate(item({ done: 50, planned: 0, rateInFile: 0.3 })), 0.3);
    assert.equal(workRate(item({})), null);
  });

  it("writes a front's range", () => {
    assert.equal(frontRange(report.fronts[1]), "Km186+900 – Km192+419");
    assert.equal(
      frontRange({ id: "M01", name: "Mũi 01", km0: 140000, km1: 126484.93 }),
      "Km126+484,93 – Km140+000",
    );
    assert.equal(frontRange({ id: "M01", name: "Mũi 01", km0: null, km1: null }), "");
  });

  it("steps through a package's dates and picks the latest", () => {
    const index = { XL05: ["2026-11-18", "2026-11-19"], XL01: ["2026-11-17"] };
    assert.equal(firstPackage(index), "XL01");
    assert.equal(firstPackage({}), null);
    assert.equal(latestDate(index, "XL05"), "2026-11-19");
    assert.equal(latestDate(index, "XL09"), null);
    assert.equal(stepDate(index, "XL05", "2026-11-19", -1), "2026-11-18");
    assert.equal(stepDate(index, "XL05", "2026-11-19", 1), null);
    assert.equal(stepDate(index, "XL05", "2026-01-01", -1), null);
  });

  it("finds the map lines of a front by package and front name", () => {
    const lines = [
      { name: "XL05 · Mũi 01" },
      { name: "XL05 · Mũi 010" },
      { name: "XL02 · Mũi 01" },
      { name: "Chưa có báo cáo" },
    ];
    const front = report.fronts[0];
    assert.deepEqual(
      linesForFront(lines, "XL05", front).map((line) => line.name),
      ["XL05 · Mũi 01"],
    );
    assert.deepEqual(linesForFront(lines, "", front), []);
  });
});

/** A fake of the slice of IndexedDB the reader uses: one database, two stores. */
function fakeIndexedDB(stores: Record<string, Record<string, unknown>> | null) {
  let closed = 0;
  const indexedDB = {
    open(name: string) {
      assert.equal(name, "bcn-bangdien");
      const request: Record<string, unknown> = {};
      queueMicrotask(() => {
        if (!stores) {
          const upgrade = request.onupgradeneeded as (() => void) | undefined;
          request.transaction = {
            abort() {
              (request.onerror as () => void)();
            },
          };
          upgrade?.();
          return;
        }
        request.result = {
          objectStoreNames: { contains: (store: string) => store in stores },
          close() {
            closed++;
          },
          transaction(store: string, mode: string) {
            assert.equal(mode, "readonly");
            // Like IndexedDB: the transaction completes once, after the handlers are set.
            const transaction: Record<string, unknown> = {
              objectStore: () => ({
                get(key: string) {
                  return { result: stores[store][key] };
                },
              }),
            };
            queueMicrotask(() => queueMicrotask(() => (transaction.oncomplete as () => void)()));
            return transaction;
          },
        };
        (request.onsuccess as () => void)();
      });
      return request;
    },
  };
  return { host: { indexedDB } as unknown as Window, closed: () => closed };
}

describe("daily report data: reading the board's IndexedDB", () => {
  it("reads the index, a report and photos, closing each connection", async () => {
    const blob = new Blob(["jpeg"], { type: "image/jpeg" });
    const fake = fakeIndexedDB({
      docs: { "bcn/meta": { idx: { XL05: ["2026-11-19"] } }, "bcn_XL05/2026-11-19": STORED },
      imgs: { Labc: blob, Lbad: "not a blob" },
    });
    assert.deepEqual(await readReportIndex(fake.host), { XL05: ["2026-11-19"] });
    assert.equal((await readReport(fake.host, "XL05", "2026-11-19"))?.staffTotal, 100);
    assert.equal(await readReport(fake.host, "XL05", "2026-11-20"), null);
    const photos = await readPhotos(fake.host, ["Labc", "Lbad", "Lmissing"]);
    assert.deepEqual([...photos.keys()], ["Labc"]);
    assert.equal(fake.closed(), 4);
  });

  it("never creates the database the board has not made yet", async () => {
    const fake = fakeIndexedDB(null);
    assert.equal(await readBoardStore(fake.host, "docs", ["bcn/meta"]), null);
    assert.equal(await readReportIndex(fake.host), null);
  });

  it("answers null when the store is missing or IndexedDB throws", async () => {
    assert.equal(await readBoardStore(fakeIndexedDB({ docs: {} }).host, "imgs", ["x"]), null);
    const broken = {
      indexedDB: {
        open: () => {
          throw new Error("denied");
        },
      },
    } as unknown as Window;
    assert.equal(await readReportIndex(broken), null);
    assert.deepEqual([...(await readPhotos(broken, []))], []);
  });
});
