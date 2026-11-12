import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  BRIDGE_ITEM_KEYS,
  PROGRESS_V2_ITEM_KEYS,
  bridgeItemQuantityText,
  computeProgressAlerts,
  computeProgressV2,
  computeYard,
  cyclePileState,
  evaluateProgress,
  migrateProgressV1,
  normalizeProgressV2,
  packageForStation,
  recordProgressV2Week,
  setGirderStage,
  supportOverallPct,
  type BridgeState,
  type ProgressV2,
} from "../apps/geolibre-desktop/src/lib/progress-v2";

const htmlState = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("fixtures/progress-html-state.json", import.meta.url)),
    "utf8",
  ),
) as Record<string, unknown>;

function fromHtmlSample(): ProgressV2 {
  const meta = htmlState.meta as Record<string, unknown>;
  return normalizeProgressV2({
    version: 2,
    meta: {
      title: meta.name,
      subtitle: meta.goi,
      duan: meta.duan,
      cdt: meta.cdt,
      tvtk: meta.tvtk,
      dv: meta.dv,
      reportDate: meta.date,
    },
    packages: [{ id: "html", name: "HTML", fromStation: 0, toStation: 20_000 }],
    weights: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 0])),
    plan: { html: htmlState.plan },
    bridges: [
      {
        id: "hong-ha",
        name: meta.name,
        station: meta.km0,
        yard: htmlState.yard,
        supports: htmlState.supports,
        spans: htmlState.spans,
      },
    ],
    road: { km: [] },
    underpasses: [],
    history: [],
    notes: htmlState.notes,
  })!;
}

describe("the HTML progress sample", () => {
  const state = fromHtmlSample();
  Object.assign(state.weights, htmlState.weights);

  it("reproduces every item, overall, planned, and deviation percentage", () => {
    const summary = computeProgressV2(state, "html");
    const actual = Object.fromEntries(summary.items.map((item) => [item.key, item.pct]));
    const expected = {
      coc: 61.53846153846154,
      be: 43.07692307692308,
      than: 30.76923076923077,
      xm: 20,
      duc: 17.142857142857142,
      gac: 7.142857142857142,
      bmc: 2.865586101907406,
      ht: 0,
    };
    for (const key of BRIDGE_ITEM_KEYS)
      assert.ok(Math.abs(actual[key] - expected[key]) < 1e-10, `${key}: ${actual[key]}`);
    assert.ok(Math.abs(summary.overallPct - 24.51791886809349) < 1e-10);
    assert.ok(Math.abs(summary.plannedPct - 24.14) < 1e-10);
    assert.ok(Math.abs(summary.deviation - 0.3779188680934885) < 1e-10);
  });

  it("reproduces the HTML quantity strings", () => {
    const bridges = state.bridges;
    assert.equal(bridgeItemQuantityText(bridges, "coc"), "80/130 cọc · 2513/4280 m");
    assert.equal(bridgeItemQuantityText(bridges, "be"), "5/13 trụ xong");
    assert.equal(bridgeItemQuantityText(bridges, "than"), "3/13 trụ xong");
    assert.equal(bridgeItemQuantityText(bridges, "xm"), "2/13 trụ xong");
    assert.equal(bridgeItemQuantityText(bridges, "duc"), "24/140 dầm");
    assert.equal(bridgeItemQuantityText(bridges, "gac"), "10/140 dầm");
    assert.equal(bridgeItemQuantityText(bridges, "bmc"), "16/558 m");
    assert.equal(bridgeItemQuantityText(bridges, "ht"), "0/558 m");
  });

  it("reproduces the HTML alert list and yard figures", () => {
    assert.deepEqual(
      computeProgressAlerts(state, "html").map((alert) => [
        alert.severity,
        alert.code,
        alert.itemKey ?? alert.spanId,
      ]),
      [
        [2, "item-late", "be"],
        [2, "item-late", "gac"],
        [1, "next-span-waits-cap", "N3"],
      ],
    );
    const yard = computeYard(state.bridges[0], state.meta.reportDate);
    assert.deepEqual(
      {
        total: yard.total,
        cast: yard.cast,
        onBed: yard.onBed,
        ready: yard.ready,
        erected: yard.erected,
      },
      { total: 140, cast: 24, onBed: 5, ready: 10, erected: 10 },
    );
    assert.deepEqual(
      yard.beds.map((bed) => bed.girders.length),
      [1, 1, 1, 1, 1],
    );
    assert.deepEqual(yard.nextSpan, { id: "N3", ready: 10, need: 10 });
  });
});

function bridge(id: string, station: number, done: boolean): BridgeState {
  return {
    id,
    name: id,
    station,
    yard: { beds: 1 },
    supports: [
      {
        id: "M1",
        kind: "mo",
        inc: true,
        coc: { t: 2, D: 1, L: 10 },
        piles: [done ? 2 : 0, done ? 2 : 0],
        be: done ? 100 : 0,
        than: done ? 100 : 0,
        xm: done ? 100 : 0,
      },
      {
        id: "M2",
        kind: "mo",
        inc: true,
        coc: { t: 2, D: 1, L: 10 },
        piles: [done ? 2 : 0, done ? 2 : 0],
        be: done ? 100 : 0,
        than: done ? 100 : 0,
        xm: done ? 100 : 0,
      },
    ],
    spans: [
      {
        id: "N1",
        L: 40,
        lien: "",
        bmc: done ? 100 : 0,
        ht: done ? 100 : 0,
        girders: [{ t: "T", st: done ? 5 : 0, dob: "", bed: 0 }],
      },
    ],
  };
}

function packageState(): ProgressV2 {
  const weights = Object.fromEntries(
    PROGRESS_V2_ITEM_KEYS.map((key) => [key, 1]),
  ) as ProgressV2["weights"];
  return {
    version: 2,
    meta: { title: "Route", subtitle: "", reportDate: "2026-10-16" },
    packages: [
      { id: "p1", name: "P1", fromStation: 0, toStation: 1000 },
      { id: "p2", name: "P2", fromStation: 1000, toStation: 3000 },
    ],
    weights,
    plan: {
      p1: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 50])),
      p2: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 25])),
    },
    bridges: [bridge("b1", 500, true), bridge("b2", 1500, false)],
    road: {
      km: [
        {
          id: "Km0",
          from: 0,
          to: 1000,
          pct: { nen: 100, mat_trai: 100, mat_phai: 100, le: 100, dpc: 100, ranh: 100 },
        },
        {
          id: "Km1",
          from: 1000,
          to: 3000,
          pct: { nen: 0, mat_trai: 0, mat_phai: 0, le: 0, dpc: 0, ranh: 0 },
        },
      ],
    },
    underpasses: [
      { id: "u1", station: 100, pct: { tuong: 100, nap: 100 } },
      { id: "u2", station: 1200, pct: { tuong: 0, nap: 0 } },
      { id: "u3", station: 1800, pct: { tuong: 0, nap: 0 } },
    ],
    history: [],
    notes: "",
  };
}

describe("packages, road, underpasses and project totals", () => {
  it("uses half-open package boundaries and scores the selected package", () => {
    const state = packageState();
    assert.equal(packageForStation(state.packages, 999)?.id, "p1");
    assert.equal(packageForStation(state.packages, 1000)?.id, "p2");
    assert.equal(packageForStation(state.packages, 3000)?.id, "p2");
    assert.equal(computeProgressV2(state, "p1").overallPct, 100);
    assert.equal(computeProgressV2(state, "p2").overallPct, 0);
  });

  it("computes the project from the union and weights project plan by item quantities", () => {
    const summary = computeProgressV2(packageState());
    const byKey = Object.fromEntries(summary.items.map((item) => [item.key, item]));
    assert.equal(byKey.coc.pct, 50);
    assert.equal(byKey.nen.pct, 100 / 3);
    assert.equal(byKey.ham_tuong.pct, 100 / 3);
    assert.equal(byKey.nen.plannedPct, (50 * 1000 + 25 * 2000) / 3000);
    assert.equal(byKey.ham_tuong.plannedPct, (50 + 25 * 2) / 3);
  });
});

describe("editing helpers", () => {
  it("uses the HTML evaluation tolerance and pile cycle", () => {
    assert.equal(evaluateProgress(10.54, 10, true), "ok");
    assert.equal(evaluateProgress(10.55, 10, true), "ahead");
    assert.equal(evaluateProgress(9.45, 10, true), "late");
    assert.equal(evaluateProgress(0, 0, false), "na");
    assert.deepEqual([cyclePileState(0), cyclePileState(1), cyclePileState(2)], [1, 2, 0]);
  });

  it("applies the reference girder stage rules", () => {
    const original = { t: "T", st: 1 as const, dob: "", bed: 2 };
    assert.deepEqual(setGirderStage(original, 2, "2026-10-16"), {
      t: "T",
      st: 2,
      dob: "2026-10-16",
      bed: 2,
    });
    assert.equal(setGirderStage({ ...original, dob: "2026-10-01" }, 4, "2026-10-16").bed, 0);
    assert.equal(setGirderStage({ ...original, dob: "2026-10-01" }, 1, "2026-10-16").dob, "");
  });

  it("weights the four support stages and records package plus project history", () => {
    const state = packageState();
    assert.equal(supportOverallPct(state.bridges[0].supports[0], state.weights), 100);
    const recorded = recordProgressV2Week(state, "2026-10-16", "p1");
    assert.deepEqual(
      recorded.history.map((item) => item.packageId),
      [null, "p1"],
    );
    assert.deepEqual(
      recorded.history.map((item) => item.actual),
      [41.7, 100],
    );
  });
});

describe("v1 migration", () => {
  it("derives supports, piles, spans, girders and initial painted states", () => {
    const feature = (properties: Record<string, unknown>): Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { cong_trinh: "Cầu Km185", km_tu: 185_500, ...properties },
    });
    const migrated = migrateProgressV1(
      { title: "Project", items: [{ key: "coc", weight: 9, plannedPct: 30 }] },
      [
        feature({ cau_kien: "M1", bo_phan: "cọc 1", tiendo: "done" }),
        feature({ cau_kien: "M1", bo_phan: "cọc 2", tiendo: "wip" }),
        feature({ cau_kien: "M1", Layer: "BE", tiendo: "wip" }),
        feature({ cau_kien: "N1", bo_phan: "dầm 1", tiendo: "done" }),
        feature({ cau_kien: "N1", bo_phan: "dầm 2", tiendo: "wip" }),
        feature({ cau_kien: "M2", Layer: "BE" }),
      ],
      "2026-10-16",
    );
    assert.equal(migrated.version, 2);
    assert.equal(migrated.weights.coc, 9);
    assert.equal(migrated.plan["goi-1"].coc, 30);
    assert.deepEqual(migrated.bridges[0].supports[0].piles, [2, 1]);
    assert.equal(migrated.bridges[0].supports[0].be, 50);
    assert.deepEqual(
      migrated.bridges[0].spans[0].girders.map((girder) => girder.st),
      [5, 2],
    );
  });

  it("orders supports along the bridge so each span sits between its own supports", () => {
    const feature = (cau_kien: string): Feature => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [0, 0] },
      properties: { cong_trinh: "Cầu A", cau_kien },
    });
    const migrated = migrateProgressV1(
      {},
      ["M2", "T2", "N3", "T10", "M1", "N1", "T1", "N2"].map(feature),
      "2026-10-16",
    );
    assert.deepEqual(
      migrated.bridges[0].supports.map((support) => support.id),
      ["M1", "T1", "T2", "T10", "M2"],
    );
    assert.deepEqual(
      migrated.bridges[0].spans.map((span) => span.id),
      ["N1", "N2", "N3"],
    );
  });

  it("keeps the v1 weekly history as whole-project records", () => {
    const migrated = migrateProgressV1(
      {
        weekly: [
          { week: "2026-W41", date: "2026-10-09", actualPct: 12.5, plannedPct: 15 },
          { date: "2026-10-16", actualPct: 20, plannedPct: 22 },
        ],
      },
      [],
      "2026-10-16",
    );
    assert.deepEqual(migrated.history, [
      { date: "2026-10-09", week: "2026-W41", packageId: null, actual: 12.5, planned: 15 },
      { date: "2026-10-16", week: "2026-W42", packageId: null, actual: 20, planned: 22 },
    ]);
  });
});
