import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import {
  normalizeProgressV2,
  PROGRESS_V2_ITEM_KEYS,
} from "../apps/geolibre-desktop/src/lib/progress-v2";
import {
  dashboardRows,
  filterDashboardRows,
  EMPTY_DASHBOARD_FILTERS,
  reconcileDashboardFilters,
  summarizeDashboardRows,
} from "../apps/geolibre-desktop/src/lib/progress-dashboard";
import {
  dashboardMatrix,
  dashboardStrip,
  dashboardAlertGroups,
  dashboardBrush,
  dashboardSchedule,
} from "../apps/geolibre-desktop/src/lib/progress-dashboard-analysis";
import {
  progressReportSheets,
  encodeProgressWorkbook,
} from "../apps/geolibre-desktop/src/lib/progress-dashboard-export";
import {
  watchDashboardMap,
  fitDashboardMap,
  captureDashboardMap,
} from "../apps/geolibre-desktop/src/lib/progress-dashboard-map";
import type { Map as MapLibreMap } from "maplibre-gl";
import { geojsonLayer } from "./helpers/layer-fixtures";

function fixture() {
  const state = normalizeProgressV2({
    version: 2,
    meta: { title: "Route", reportDate: "2026-11-13" },
    weights: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((k) => [k, k === "nen" ? 3 : 1])),
    packages: [
      { id: "p", name: "Package", fromStation: 0, toStation: 1000 },
      { id: "q", name: "Next", fromStation: 1000, toStation: 2000 },
    ],
    plan: { p: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((k) => [k, 80])), q: { nen: 80 } },
    bridges: [
      {
        id: "b",
        name: "Bridge with a long name",
        station: 400,
        supports: [
          { id: "M1", inc: true, coc: { t: 3 }, piles: [2, 0, 0], be: 50, than: 0, xm: 0 },
        ],
        spans: [{ id: "N1", L: 40, bmc: 0, ht: 0, girders: [{ t: "T", st: 0 }] }],
      },
    ],
    road: {
      km: [
        { id: "Km0", from: 0, to: 1000, pct: { nen: 50, mat_trai: 20 } },
        { id: "Km1", from: 1000, to: 2000, pct: { nen: 70 } },
      ],
    },
    underpasses: [{ id: "HC1", station: 700, pct: { tuong: 100, nap: 100 } }],
    history: [
      { date: "2026-10-30", week: "2026-W44", packageId: "p", actual: 20, planned: 30 },
      { date: "2026-11-06", week: "2026-W45", packageId: "p", actual: 30, planned: 45 },
      { date: "2026-11-13", week: "2026-W46", packageId: "p", actual: 40, planned: 60 },
    ],
  });
  assert.ok(state);
  return state;
}
it("builds weighted structure cells, excludes inapplicable items and sorts the worst deviations first", () => {
  const state = fixture(),
    rows = dashboardRows(state, "p"),
    matrix = dashboardMatrix(state, rows);
  assert.equal(matrix.length, 3);
  assert.ok(matrix.every((s, i) => !i || matrix[i - 1].summary.deviation <= s.summary.deviation));
  const bridge = matrix.find((s) => s.id === "bridge:b")!;
  assert.equal(bridge.name, "Bridge with a long name");
  assert.equal(bridge.summary.items.find((i) => i.key === "coc")!.pct, 100 / 3);
  assert.equal(bridge.summary.items.find((i) => i.key === "nen")!.applicable, false);
  const road = matrix.find((s) => s.id === "road:Km0")!;
  assert.deepEqual(road.summary, summarizeDashboardRows(state, road.rows));
  const filtered = filterDashboardRows(rows, {
    ...EMPTY_DASHBOARD_FILTERS,
    structureIds: ["underpass:HC1"],
  });
  assert.ok(filtered.every((r) => r.target.id === "HC1"));
  assert.ok(
    filterDashboardRows(dashboardRows(state), {
      ...EMPTY_DASHBOARD_FILTERS,
      packageIds: ["q"],
    }).every((r) => r.packageId === "q"),
  );
  assert.deepEqual(
    reconcileDashboardFilters(
      { ...EMPTY_DASHBOARD_FILTERS, structureIds: ["bridge:b", "road:Km0"] },
      dashboardRows(state, "q"),
    ).structureIds,
    [],
  );
});
it("derives non-overlapping strip rows and handles unknown stations and reversed brushes", () => {
  const state = fixture(),
    rows = dashboardRows(state, "p"),
    strip = dashboardStrip(state, rows);
  assert.equal(strip.filter((s) => s.kind === "bridge").length, 1);
  assert.equal(strip.filter((s) => s.kind === "road").length, 6);
  assert.equal(strip.find((s) => s.key === "nen")!.to, 1000);
  assert.equal(
    dashboardStrip(
      state,
      rows.map((r) => ({ ...r, from: NaN, to: NaN })),
    ).length,
    0,
  );
  assert.deepEqual(dashboardBrush([0, 1000], 1300, 200), [200, 1000]);
  assert.deepEqual(dashboardBrush([0, 1000], -20, 420), [0, 420]);
});
it("groups late atomic components into one entry per structure/item and retains sequence alerts", () => {
  const state = fixture(),
    rows = dashboardRows(state, "p"),
    groups = dashboardAlertGroups(state, rows, "p");
  assert.equal(new Set(groups.map((g) => g.structure.id)).size, groups.length);
  const bridge = groups.find((g) => g.structure.id === "bridge:b")!;
  assert.equal(bridge.entries.filter((e) => e.itemKey === "coc" && !e.alert).length, 1);
  assert.ok(bridge.entries.some((e) => e.alert?.code === "cap-before-piles"));
  assert.ok(!groups.some((g) => g.structure.id === "underpass:HC1"));
  assert.ok(bridge.entries.every((e) => e.deviation <= 0));
});
it("estimates schedule dates per package and limits old-week forecasts to available observations", () => {
  const state = fixture(),
    schedule = dashboardSchedule(state, "p");
  assert.ok(schedule.forecast);
  assert.ok(schedule.planEnd);
  assert.ok(schedule.days! < 0);
  assert.equal(dashboardSchedule(state, "q").forecast, null);
  assert.equal(dashboardSchedule(state, "p", "2026-10-30").history.length, 1);
  assert.equal(dashboardSchedule(state, "p", "2026-10-30").forecast, null);
});
it("keeps missing-plan warnings grouped with their structures", () => {
  const state = fixture();
  state.plan = {};
  const groups = dashboardAlertGroups(state, dashboardRows(state, "p"), "p");
  assert.equal(groups.length, 3);
  assert.ok(groups.every((g) => g.entries.some((e) => e.alert?.code === "no-plan")));
});
it("separates manual map movement from camera fits and resolves hover against original data", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  let manual = 0;
  const hits: unknown[] = [];
  const layer = geojsonLayer({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "original" },
          geometry: { type: "Point", coordinates: [106, 10] },
        },
      ],
    },
    progressDashboard: { filter: ["literal", true], colorExpression: '"#fff"' },
  });
  const map = {
    on: (name: string, handler: (e: unknown) => void) => handlers.set(name, handler),
    off: (name: string) => handlers.delete(name),
    queryRenderedFeatures: () => [
      { source: `source-${layer.id}`, properties: { __geolibre_progress_index: 0 } },
    ],
    getCanvas: () => ({ getBoundingClientRect: () => ({ x: 10, y: 20 }) }),
  } as unknown as MapLibreMap;
  const stop = watchDashboardMap(
    { fitBounds: () => {}, getMap: () => map },
    () => layer,
    () => manual++,
    (hit) => hits.push(hit),
  );
  handlers.get("zoomstart")!({});
  assert.equal(manual, 0);
  handlers.get("dragstart")!({ originalEvent: {} });
  assert.equal(manual, 1);
  handlers.get("mousemove")!({ point: { x: 5, y: 6 } });
  assert.deepEqual(hits[0], { index: 0, x: 15, y: 26 });
  stop();
  assert.equal(handlers.size, 0);
  const bounds: unknown[] = [];
  fitDashboardMap({ fitBounds: (value) => bounds.push(value) }, layer, [0]);
  assert.equal(bounds.length, 1);
  assert.equal(await captureDashboardMap(null), null);
});
it("exports four real workbook sheets with report dates, numeric values and explicit current-detail dates", async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "vi",
    resources: {
      vi: {
        translation: JSON.parse(
          readFileSync(
            new URL("../apps/geolibre-desktop/src/i18n/locales/vi.json", import.meta.url),
            "utf8",
          ),
        ),
      },
    },
  });
  const state = fixture(),
    sheets = progressReportSheets(state, dashboardRows(state, "p"), "p", "2026-11-06", i18n.t);
  const XLSX = await import("@e965/xlsx"),
    book = XLSX.read(await encodeProgressWorkbook(sheets), { type: "array" });
  assert.deepEqual(book.SheetNames, ["Tổng hợp", "Theo công trình", "Hạng mục", "Cảnh báo"]);
  assert.equal(book.Sheets["Tổng hợp"].B3.v, "2026-11-06");
  assert.equal(book.Sheets["Tổng hợp"].B4.v, "2026-11-13");
  assert.equal(book.Sheets["Tổng hợp"].B5.v, 30);
  assert.equal(book.Sheets["Tổng hợp"].B5.t, "n");
  const exportedMatrix = XLSX.utils.sheet_to_json(book.Sheets["Theo công trình"], {
    header: 1,
  }) as unknown[][];
  assert.equal(exportedMatrix.length, 5);
  assert.equal(exportedMatrix[1].length, 20);
});
