import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseBoardReport,
  type BoardReport,
} from "../apps/geolibre-desktop/src/lib/daily-report-data";
import {
  cardFromProperties,
  groupHistory,
  historyKeys,
  placeCard,
  stalledFor,
  structureCard,
  structureWork,
  STALL_DAYS,
  weekChange,
} from "../apps/geolibre-desktop/src/lib/structure-card";

// Hand-made numbers, never an extract/copy of a private workbook.
const STATION = 147945;
const day = (
  date: string,
  piles: number | null,
  extra: { today?: string; issues?: string[]; photos?: unknown[]; abutment?: number } = {},
): BoardReport =>
  parseBoardReport({
    goi: "XL02",
    date,
    mui: [{ id: "M01", name: "Mũi 01", km0: 144800, km1: 149000 }],
    work: [
      {
        part: "C",
        grp: "CVN Km147+945",
        name: "Khoan cọc nhồi mố M1, M2",
        mui: "M01",
        unit: "cọc",
        bvtk: 12,
        lk: piles,
        today: extra.today ?? "",
        tomorrow: "Khoan cọc C5",
      },
      {
        part: "C",
        grp: "CVN Km147+945",
        name: "Thi công bệ mố M1",
        mui: "M01",
        unit: "m3",
        lk: extra.abutment ?? null,
      },
      { part: "C", grp: "CVN  Km147+945,4", name: "Tập kết thiết bị", mui: "M01" },
      // Neither a range nor another structure belongs to the card.
      { part: "D", grp: "Km147+900 – Km148+000", name: "Đắp nền", mui: "M01", bvtk: 10, lk: 5 },
      { part: "C", grp: "HCDS Km148+500", name: "Đào móng", mui: "M01", bvtk: 1, lk: 1 },
      { part: "NN", grp: "Km147+945", name: "Hồ sơ", mui: "BDH" },
    ],
    issues: extra.issues ?? [],
    photos: extra.photos ?? [],
  })!;

const point = { Ten: "CVN Km147+945", Loai: "Cầu vượt ngang", Goi_thau: "Gói XL02" };

describe("structure hover card", () => {
  it("collects only the groups labelled with exactly the structure's chainage", () => {
    const names = structureWork(day("2026-11-20", 4), STATION).map((item) => item.name);
    assert.deepEqual(names, ["Khoan cọc nhồi mố M1, M2", "Thi công bệ mố M1", "Tập kết thiết bị"]);
  });

  it("reads header, progress, items, today/tomorrow, issues and the latest photo from the report", () => {
    const now = day("2026-11-20", 4, {
      today: "Khoan cọc C3   mố M1",
      issues: ["Chưa bàn giao mặt bằng mố M2 CVN Km147+945", "Thiếu thép tại Km152+700"],
      photos: [
        { caption: "Khoan cọc CVN Km147+945", ref: { id: "old" } },
        { caption: "Cầu Km152+700", ref: { id: "other" } },
        { caption: "Đổ bê tông cọc C4 Km147+945", ref: { id: "new" } },
      ],
    });
    const card = structureCard("CVN Km147+945", point, [now], new Map());
    assert.equal(card.pkg, "XL02");
    assert.equal(card.front, "Mũi 01");
    assert.equal(card.kind, "Cầu vượt ngang");
    assert.equal(card.date, "2026-11-20");
    assert.equal(card.percent, 33.3);
    assert.equal(card.measured, 1);
    assert.equal(card.total, 3);
    assert.equal(card.done, false);
    assert.deepEqual(card.items[0], {
      name: "Khoan cọc nhồi mố M1, M2",
      unit: "cọc",
      done: 4,
      planned: 12,
      percent: 33.3,
    });
    assert.equal(card.items[1].percent, null);
    assert.equal(card.today, "Khoan cọc C3 mố M1");
    assert.equal(card.tomorrow, "Khoan cọc C5");
    assert.deepEqual(card.issues, ["Chưa bàn giao mặt bằng mố M2 CVN Km147+945"]);
    assert.equal(card.photo?.id, "new");
    assert.equal(card.week, null);
    assert.equal(card.stalled, null);
  });

  it("reports the week's added quantities and the change of items measured both days", () => {
    const now = day("2026-11-20", 6, { abutment: 30 });
    const before = day("2026-11-13", 4);
    const week = weekChange(structureWork(now, STATION), before, STATION)!;
    assert.equal(week.since, "2026-11-13");
    assert.deepEqual(week.changes, [
      { name: "Khoan cọc nhồi mố M1, M2", added: 2, unit: "cọc" },
      { name: "Thi công bệ mố M1", added: 30, unit: "m3" },
    ]);
    assert.equal(week.gain, 16.7);
    assert.equal(weekChange(structureWork(now, STATION), null, STATION), null);
  });

  it("picks the newest report at least a week older for the week", () => {
    const history = groupHistory([
      day("2026-11-12", 2),
      day("2026-11-13", 3),
      day("2026-11-17", 5),
    ]);
    const card = structureCard("CVN Km147+945", point, [day("2026-11-20", 6)], history);
    assert.equal(card.week?.since, "2026-11-13");
    assert.equal(card.week?.changes[0].added, 3);
  });

  it("counts the days since quantities last changed, and flags only from the threshold", () => {
    const now = day("2026-11-20", 6);
    const items = structureWork(now, STATION);
    const earlier = [day("2026-11-19", 6), day("2026-11-17", 6), day("2026-11-16", 4)];
    assert.deepEqual(stalledFor(now, items, earlier, STATION), { days: 3, atLeast: false });
    assert.deepEqual(stalledFor(now, items, earlier.slice(0, 2), STATION), {
      days: 3,
      atLeast: true,
    });
    assert.equal(STALL_DAYS, 3);
    assert.equal(
      stalledFor(now, items, [day("2026-11-19", 6), day("2026-11-18", 5)], STATION),
      null,
    );
    // No quantity at all cannot be judged.
    assert.equal(
      stalledFor(
        day("2026-11-20", null),
        structureWork(day("2026-11-20", null), STATION),
        earlier,
        STATION,
      ),
      null,
    );
  });

  it("calls a structure complete only when every item has figures at 100%, and never flags it", () => {
    // Piles done, but the footing and the equipment have no figures yet: work still to come.
    const partly = structureCard("CVN Km147+945", point, [day("2026-11-20", 12)], new Map());
    assert.equal(partly.percent, 100);
    assert.equal(partly.done, false);
    const finished = (date: string) =>
      parseBoardReport({
        goi: "XL02",
        date,
        mui: [{ id: "M01", name: "Mũi 01", km0: 144800, km1: 149000 }],
        work: [{ part: "C", grp: "CVN Km147+945", name: "Cọc", unit: "cọc", bvtk: 12, lk: 12 }],
      })!;
    const history = groupHistory([finished("2026-11-10"), finished("2026-11-15")]);
    const card = structureCard("CVN Km147+945", point, [finished("2026-11-20")], history);
    assert.equal(card.done, true);
    assert.equal(card.stalled, null);
  });

  it("says nothing about the week when no item has any figure", () => {
    const blank = (date: string) =>
      parseBoardReport({
        goi: "XL02",
        date,
        mui: [{ id: "M01", name: "Mũi 01", km0: 144800, km1: 149000 }],
        work: [{ part: "C", grp: "CVN Km147+945", name: "Đào đắp", today: "Đào" }],
      })!;
    const now = blank("2026-11-20");
    assert.equal(weekChange(structureWork(now, STATION), blank("2026-11-13"), STATION), null);
  });

  it("ignores finished items: only unfinished quantities are expected to move", () => {
    // Piles finished (12/12) long ago; the abutment's 30 m3 is what stands still, or moves.
    const now = day("2026-11-20", 12, { abutment: 30 });
    const items = structureWork(now, STATION);
    const still = [
      day("2026-11-19", 12, { abutment: 30 }),
      day("2026-11-15", 12, { abutment: 30 }),
    ];
    assert.deepEqual(stalledFor(now, items, still, STATION), { days: 5, atLeast: true });
    const moving = [day("2026-11-19", 12, { abutment: 25 })];
    assert.equal(stalledFor(now, items, moving, STATION), null);
    // Nothing unfinished with a quantity: nothing to judge.
    const finished = day("2026-11-20", 12);
    assert.equal(
      stalledFor(finished, structureWork(finished, STATION), [day("2026-11-10", 12)], STATION),
      null,
    );
  });

  it("caps the item list and counts the rest", () => {
    const many = parseBoardReport({
      goi: "XL02",
      date: "2026-11-20",
      mui: [{ id: "M01", name: "Mũi 01", km0: 144800, km1: 149000 }],
      work: Array.from({ length: 7 }, (_, i) => ({
        part: "C",
        grp: "CVN Km147+945",
        name: `Hạng mục ${i}`,
      })),
    })!;
    const card = structureCard("CVN Km147+945", point, [many], new Map());
    assert.equal(card.items.length, 5);
    assert.equal(card.more, 2);
  });

  it("falls back to the point's attributes when no report covers it", () => {
    const card = cardFromProperties("HCDS Km156+272", {
      Ten: "HCDS Km156+272",
      Loai: "Hầm chui dân sinh",
      Goi_thau: "Gói XL02",
      Tien_do_pct: 75,
      Ngay_bao_cao: "20/11/2026",
      Cong_tac: "Đào đất móng 100%; Đắp K95 50%; Bệ mố (chưa có KL thiết kế)",
    });
    assert.equal(card.pkg, "Gói XL02");
    assert.equal(card.date, "2026-11-20");
    assert.equal(card.percent, 75);
    assert.equal(card.measured, 2);
    assert.deepEqual(
      card.items.map((item) => [item.name, item.percent]),
      [
        ["Đào đất móng", 100],
        ["Đắp K95", 50],
        ["Bệ mố", null],
      ],
    );
    assert.deepEqual(structureCard("HCDS Km156+272", { Ten: "x" }, [], new Map()).items, []);
    assert.equal(cardFromProperties("x", { Tien_do_pct: "abc" }).percent, null);
  });

  it("lists the earlier reports within the history window and groups them newest first", () => {
    const index = {
      XL02: ["2026-11-01", "2026-11-06", "2026-11-13", "2026-11-19", "2026-11-20"],
      XL04: ["2026-11-19"],
    };
    assert.deepEqual(historyKeys(index, [day("2026-11-20", 4)]), [
      "bcn_XL02/2026-11-06",
      "bcn_XL02/2026-11-13",
      "bcn_XL02/2026-11-19",
    ]);
    const grouped = groupHistory([day("2026-11-13", 1), day("2026-11-19", 2)]);
    assert.deepEqual(
      grouped.get("XL02")?.map((report) => report.date),
      ["2026-11-19", "2026-11-13"],
    );
  });

  it("keeps the card beside the pointer and inside the viewport", () => {
    const viewport = { width: 1000, height: 800 };
    const size = { width: 300, height: 400 };
    assert.deepEqual(placeCard({ x: 100, y: 100 }, size, viewport), { left: 112, top: 112 });
    assert.deepEqual(placeCard({ x: 900, y: 700 }, size, viewport), { left: 588, top: 288 });
    // Too tall for either side: pinned to the bottom margin.
    assert.deepEqual(placeCard({ x: 100, y: 400 }, { width: 300, height: 700 }, viewport), {
      left: 112,
      top: 92,
    });
  });
});
