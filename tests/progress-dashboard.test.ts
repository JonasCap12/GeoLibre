import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  dashboardRows,
  dashboardStatus,
  dashboardComponentStatuses,
  filterDashboardRows,
  reconcileDashboardFilters,
  summarizeDashboardRows,
  dashboardGroups,
  dashboardQuantities,
  dashboardHistory,
  forecastDashboardCompletion,
  dashboardYard,
  dashboardStatusCounts,
  dashboardAlerts,
  dashboardAlertRows,
  dashboardStationExtent,
  dashboardMapView,
  EMPTY_DASHBOARD_FILTERS,
  DASHBOARD_STATUS_COLORS,
} from "../apps/geolibre-desktop/src/lib/progress-dashboard";
import {
  normalizeProgressV2,
  PROGRESS_V2_ITEM_KEYS,
  ROAD_ITEM_KEYS,
  computeProgressV2,
  computeProgressAlerts,
  migrateProgressV1,
  supportOverallPct,
} from "../apps/geolibre-desktop/src/lib/progress-v2";
import { progressFeatureItems } from "../apps/geolibre-desktop/src/lib/progress-colors";
import {
  compileLayerFilters,
  hasActiveLayerFilter,
  createEmptyProject,
  parseProject,
  serializeProject,
  progressDashboardLayer,
  progressDashboardFeature,
  PROGRESS_DASHBOARD_INDEX_PROPERTY,
  compileFeatureExpression,
  useAppStore,
  clearHistory,
} from "@geolibre/core";
import { todayIso } from "../apps/geolibre-desktop/src/lib/construction-progress";
import { buildMapboxStyle } from "../packages/map/src/mapbox-style-export";
import { geojsonLayer } from "./helpers/layer-fixtures";

const html = JSON.parse(
  readFileSync(new URL("fixtures/progress-html-state.json", import.meta.url), "utf8"),
);
function fixture() {
  return normalizeProgressV2({
    version: 2,
    meta: { title: "Route", subtitle: "", reportDate: "2026-01-01" },
    packages: [
      { id: "p1", name: "P1", fromStation: 0, toStation: 1000 },
      { id: "p2", name: "P2", fromStation: 1000, toStation: 3000 },
    ],
    weights: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key, i) => [key, i + 1])),
    plan: {
      p1: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 40])),
      p2: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 80])),
    },
    bridges: [
      {
        id: "b",
        name: "Bridge",
        station: 500,
        yard: { beds: 2 },
        supports: [
          { id: "M1", inc: true, coc: { t: 3 }, piles: [2, 1, 0], be: 20, than: 10, xm: 0 },
          { id: "M2", inc: false, coc: { t: 1 }, piles: [2], be: 100, than: 100, xm: 100 },
        ],
        spans: [
          {
            id: "N1",
            L: 40,
            bmc: 20,
            ht: 0,
            girders: [
              { t: "A", st: 0 },
              { t: "A", st: 1, bed: 1 },
              { t: "A", st: 2, bed: 2 },
              { t: "A", st: 4 },
              { t: "B", st: 5 },
            ],
          },
        ],
      },
    ],
    road: {
      km: [
        { id: "Km0", from: 0, to: 2000, pct: { nen: 100, mat_trai: 50 } },
        {
          id: "Km2",
          from: 2000,
          to: 3000,
          pct: Object.fromEntries(ROAD_ITEM_KEYS.map((key) => [key, 100])),
        },
      ],
    },
    underpasses: [{ id: "u", station: 1500, pct: { tuong: 100, nap: 0 } }],
    history: [],
  })!;
}
const feature = (properties: Record<string, unknown>, id?: number | string): Feature => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [106, 10] },
  properties,
});

it("matches the reference HTML and existing engine for every item and scope", () => {
  const sample = normalizeProgressV2({
    version: 2,
    meta: { reportDate: html.meta.date },
    packages: [{ id: "html", name: "HTML", fromStation: 0, toStation: 20000 }],
    weights: html.weights,
    plan: { html: html.plan },
    bridges: [
      {
        id: "html",
        name: "HTML",
        station: html.meta.km0,
        supports: html.supports,
        spans: html.spans,
        yard: html.yard,
      },
    ],
  })!;
  for (const state of [fixture(), sample])
    for (const scope of [null, ...state.packages.map((p) => p.id)]) {
      const expected = computeProgressV2(state, scope),
        actual = summarizeDashboardRows(state, dashboardRows(state, scope));
      for (const key of ["overallPct", "plannedPct", "deviation", "weight"] as const)
        assert.ok(Math.abs(actual[key] - expected[key]) < 1e-8, `${scope}:${key}`);
      expected.items.forEach((item, index) => {
        assert.ok(Math.abs(actual.items[index].pct - item.pct) < 1e-8, item.key);
        if (item.applicable)
          assert.ok(Math.abs(actual.items[index].plannedPct - item.plannedPct) < 1e-8, item.key);
        assert.equal(actual.items[index].denominator, item.denominator);
      });
    }
});
it("filters kinds, items, bridges, girder types and clips station quantities without mutation", () => {
  const state = fixture(),
    rows = dashboardRows(state),
    before = structuredClone(rows);
  const road = filterDashboardRows(rows, {
    ...EMPTY_DASHBOARD_FILTERS,
    kinds: ["road"],
    items: ["nen"],
    station: [500, 1200],
  });
  assert.equal(
    road.reduce((sum, row) => sum + row.denominator, 0),
    700,
  );
  assert.equal(summarizeDashboardRows(state, road).overallPct, 100);
  assert.equal(summarizeDashboardRows(state, road).plannedPct, (500 * 40 + 200 * 80) / 700);
  assert.ok(
    filterDashboardRows(rows, { ...EMPTY_DASHBOARD_FILTERS, bridgeIds: ["b"] }).every(
      (row) => row.bridgeId === "b",
    ),
  );
  assert.ok(
    filterDashboardRows(rows, { ...EMPTY_DASHBOARD_FILTERS, girderTypes: ["A"] }).every(
      (row) => row.girderType === "A",
    ),
  );
  assert.equal(
    filterDashboardRows(rows, { ...EMPTY_DASHBOARD_FILTERS, station: [2000, 1000] }).length,
    0,
  );
  assert.deepEqual(rows, before);
});
it("keeps physical status counts, status filters and zero-percent active piles consistent", () => {
  const state = fixture();
  state.plan = {};
  const rows = dashboardRows(state);
  assert.equal(dashboardStatus(9.45, 10), "late");
  assert.equal(dashboardStatus(9.46, 10), "wip");
  assert.equal(dashboardStatus(0, 0), "empty");
  assert.equal(dashboardStatus(50, 0), "wip");
  assert.equal(dashboardStatus(100, 100), "done");
  assert.equal(dashboardStatus(20, 50), "late");
  const statuses = dashboardComponentStatuses(rows);
  const activePile = rows.find((row) => row.key === "coc" && row.index === 1)!;
  assert.equal(statuses.get(activePile.componentId), "wip");
  assert.equal(activePile.pct, 0); // Only completed piles contribute to actual quantity.
  const filtered = filterDashboardRows(rows, { ...EMPTY_DASHBOARD_FILTERS, statuses: ["wip"] });
  assert.ok(filtered.some((row) => row.id === activePile.id));
  const counts = dashboardStatusCounts(filtered);
  assert.equal(counts.wip, new Set(filtered.map((row) => row.componentId)).size);
  assert.equal(counts.done + counts.empty + counts.late, 0);
});
it("aggregates weighted packages and bridges in delay order", () => {
  const state = fixture(),
    rows = dashboardRows(state);
  const groups = dashboardGroups(state, rows, "package");
  assert.deepEqual(new Set(groups.map((g) => g.id)), new Set(["p1", "p2"]));
  assert.ok(groups[0].deviation <= groups[1].deviation);
  assert.equal(dashboardGroups(state, rows, "bridge")[0].name, "Bridge");
  assert.equal(dashboardGroups(state, [], "bridge").length, 0);
});
it("counts piles, erected girders, completed road kilometres and underpasses", () => {
  const state = fixture(),
    quantities = dashboardQuantities(state, dashboardRows(state));
  assert.deepEqual(quantities.piles, { total: 3, done: 1 });
  assert.deepEqual(quantities.girders, { total: 5, done: 1 });
  assert.equal(quantities.roadKm, 1);
  assert.deepEqual(quantities.underpasses, { total: 1, done: 0 });
  assert.equal(dashboardQuantities(state, []).roadKm, 0);
});
it("builds exclusive yard stacks while retaining the overlapping cast total", () => {
  const state = fixture();
  const yard = dashboardYard(state, dashboardRows(state));
  assert.deepEqual(yard, [
    { type: "A", total: 4, cast: 2, onBed: 2, ready: 1, erected: 0, remaining: 2 },
    { type: "B", total: 1, cast: 1, onBed: 0, ready: 0, erected: 1, remaining: 0 },
  ]);
  assert.equal(
    dashboardYard(
      state,
      filterDashboardRows(dashboardRows(state), {
        ...EMPTY_DASHBOARD_FILTERS,
        girderTypes: ["B"],
      }),
    ).length,
    1,
  );
});
it("sorts weekly history, deduplicates weeks, scopes by package and respects the chosen date", () => {
  const state = fixture();
  state.history = [
    { date: "2026-01-08", week: "W2", packageId: null, actual: 20, planned: 30 },
    { date: "2026-01-01", week: "W1", packageId: null, actual: 10, planned: 20 },
    { date: "2026-01-07", week: "W2", packageId: null, actual: 15, planned: 25 },
    { date: "2026-01-01", week: "W1", packageId: "p1", actual: 50, planned: 60 },
  ];
  const history = dashboardHistory(state, null);
  assert.deepEqual(
    history.map((p) => p.actual),
    [10, 20],
  );
  assert.equal(dashboardHistory(state, null, "2026-01-01").length, 1);
  assert.equal(dashboardHistory(state, "p1")[0].actual, 50);
  assert.equal(forecastDashboardCompletion(history), "2026-03-05");
  assert.equal(forecastDashboardCompletion([]), null);
  assert.equal(forecastDashboardCompletion(history.slice(0, 1)), null);
  assert.equal(forecastDashboardCompletion(history.map((p) => ({ ...p, actual: 20 }))), null);
  assert.equal(
    forecastDashboardCompletion(history.map((p) => ({ ...p, actual: 100 }))),
    "2026-01-08",
  );
});
it("scopes alerts to the filtered entities and items", () => {
  const state = fixture();
  assert.deepEqual(dashboardAlerts(state, null, []), []);
  const road = filterDashboardRows(dashboardRows(state), {
    ...EMPTY_DASHBOARD_FILTERS,
    kinds: ["road"],
  });
  assert.ok(dashboardAlerts(state, null, road).every((alert) => !alert.bridgeId));
  assert.ok(
    dashboardAlerts(state, null, dashboardRows(state)).some((alert) => alert.severity === 3),
  );
});
it("locates yard girders and delayed items without zooming unrelated supports", () => {
  const state = fixture(),
    rows = dashboardRows(state);
  const yard = dashboardAlertRows(rows, {
    code: "bed-clash",
    severity: 3,
    bridgeId: "b",
    ids: ["N1-D3"],
  });
  assert.equal(yard.length, 2);
  assert.ok(yard.every((row) => row.target.kind === "span" && row.index === 2));
  const late = dashboardAlertRows(rows, { code: "item-late", severity: 3, itemKey: "be" });
  assert.ok(late.every((row) => row.key === "be" && row.pct < row.planned));
  assert.deepEqual(
    dashboardAlertRows(rows, { code: "cap-before-piles", severity: 2, bridgeId: "missing" }),
    [],
  );
});

it("derives station bounds and handles unknown stations and empty results", () => {
  assert.deepEqual(dashboardStationExtent(dashboardRows(fixture())), [0, 3000]);
  assert.equal(dashboardStationExtent([]), null);
});
it("uses existing feature aliases, preserves IDs and matches map colors to status filters", () => {
  const state = fixture();
  state.plan = {};
  const features = [
    feature({ bridge_id: "b", support_id: "M1", pile_index: 1 }, "pile"),
    feature({ bridge_id: "b", support_id: "M1", Layer: "BE" }),
    feature({ bridge_id: "b", span_id: "N1", girder_index: 4 }),
    feature({ km_id: "Km0", progress_item: "nen" }),
    feature({ unrelated: true }),
  ];
  const rows = filterDashboardRows(dashboardRows(state), {
    ...EMPTY_DASHBOARD_FILTERS,
    items: ["coc"],
  });
  const view = dashboardMapView(features, state, rows, "status");
  assert.deepEqual(view.indexes, [0]);
  assert.deepEqual(view.filter, [
    "in",
    ["get", PROGRESS_DASHBOARD_INDEX_PROPERTY],
    ["literal", [0]],
  ]);
  assert.ok(view.colorExpression.includes(DASHBOARD_STATUS_COLORS.wip));
  assert.deepEqual(dashboardMapView(features, state, [], "status").indexes, []);
  assert.ok(dashboardMapView(features, state, dashboardRows(state), "deviation").colorExpression);
  assert.ok(dashboardMapView(features, state, dashboardRows(state), "girder").colorExpression);
  assert.deepEqual(progressFeatureItems(features[0]), ["coc"]);
  assert.deepEqual(
    progressFeatureItems(feature({ support_id: "M1", pile_index: null, progress_item: "than" })),
    ["than"],
  );
  assert.deepEqual(
    dashboardMapView(
      [feature({ bridge_id: "b", progress_item: "approach" })],
      state,
      dashboardRows(state),
      "status",
    ).indexes,
    [0],
  );
  assert.deepEqual(progressFeatureItems(features[1]), ["be"]);
  assert.deepEqual(progressFeatureItems(features[2]), ["duc", "gac"]);
  assert.deepEqual(progressFeatureItems(features[3]), ["nen"]);
  assert.deepEqual(progressFeatureItems(feature({ underpass_id: "u", progress_item: "ham_nap" })), [
    "ham_nap",
  ]);
  assert.deepEqual(progressFeatureItems(features[4]), []);
});

describe("existing progress regressions", () => {
  it("does not alert for an inapplicable item and respects zero support weights", () => {
    const state = fixture();
    state.road.km = [];
    state.plan.p1.nen = 100;
    assert.ok(!computeProgressAlerts(state, "p1").some((alert) => alert.itemKey === "nen"));
    assert.equal(
      supportOverallPct(state.bridges[0].supports[0], { coc: 0, be: 1, than: 0, xm: 0 }),
      20,
    );
    assert.equal(
      supportOverallPct(state.bridges[0].supports[0], { coc: 0, be: 0, than: 0, xm: 0 }),
      0,
    );
  });
  it("migrates actual extents, keeps station zero, and does not place unknown bridges at station zero", () => {
    const features = [
      feature({ bridge_id: "known", support_id: "M1", station: 0 }),
      feature({ bridge_id: "far", support_id: "M1", station: 50000 }),
      feature({ bridge_id: "unknown", support_id: "M1" }),
    ];
    const state = migrateProgressV1({}, features, "2026-01-01");
    assert.equal(state.packages.length, 1);
    assert.equal(state.packages[0].fromStation, 0);
    assert.equal(state.packages[0].toStation, 50001);
    assert.equal(state.bridges[0].station, 0);
    assert.ok(Number.isNaN(state.bridges[2].station));
    assert.ok(
      Number.isNaN(normalizeProgressV2(JSON.parse(JSON.stringify(state)))!.bridges[2].station),
    );
    assert.equal(
      dashboardRows(state, "goi-1").some((row) => row.bridgeId === "unknown"),
      false,
    );
    assert.equal(migrateProgressV1({}, [], "2026-01-01").packages.length, 0);
  });
});

it("composes transient filters, keeps styles and data intact, excludes the view from saves and undo", () => {
  const authored = ["==", ["get", "region"], "north"];
  const layer = geojsonLayer({
    filterExpression: authored,
    geojson: { type: "FeatureCollection", features: [feature({ region: "north" })] },
  });
  const dashboard = {
    filter: ["in", ["id"], ["literal", [0]]],
    colorExpression: '["case",true,"#ff0000","#000000"]',
  };
  const viewed = { ...layer, progressDashboard: dashboard };
  assert.deepEqual(compileLayerFilters(viewed), compileLayerFilters(layer));
  assert.equal(hasActiveLayerFilter({ ...layer, filterExpression: undefined }), false);
  const rendered = progressDashboardLayer(viewed);
  assert.equal(rendered.geojson!.features[0].id, undefined);
  assert.equal(rendered.geojson!.features[0].properties?.[PROGRESS_DASHBOARD_INDEX_PROPERTY], 0);
  assert.deepEqual(rendered.embedFilter, dashboard.filter);
  assert.equal(rendered.style.vectorStyleMode, "expression");
  assert.equal(progressDashboardLayer(viewed).geojson, rendered.geojson);
  assert.equal(layer.geojson!.features[0].id, undefined);
  assert.equal(progressDashboardLayer(layer), layer);
  const saved = parseProject(serializeProject({ ...createEmptyProject(), layers: [viewed] }));
  assert.equal(saved.layers[0].progressDashboard, undefined);
  assert.deepEqual(saved.layers[0].filterExpression, authored);
  assert.deepEqual(saved.layers[0].style, layer.style);
  useAppStore.setState({ layers: [layer], isDirty: false });
  clearHistory();
  useAppStore.getState().updateLayer(layer.id, { progressDashboard: dashboard });
  assert.equal(useAppStore.getState().isDirty, false);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  useAppStore.getState().selectFeature(null);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  useAppStore.getState().updateLayer(layer.id, { name: "Renamed" });
  assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  assert.equal(
    useAppStore.temporal.getState().pastStates[0].layers![0].progressDashboard,
    undefined,
  );
});

it("keys renderer colors and filters by source index regardless of authored IDs", () => {
  const state = fixture();
  const features = [5, "1A3F", "012", 42, 42, undefined].map((id) =>
    feature({ km_id: "Km0", progress_item: "nen" }, id),
  );
  const view = dashboardMapView(features, state, dashboardRows(state), "status");
  const layer = geojsonLayer({
    geojson: { type: "FeatureCollection", features },
    embedFilter: ["==", ["get", "km_id"], "Km0"],
    progressDashboard: { filter: view.filter, colorExpression: view.colorExpression },
  });
  const rendered = progressDashboardLayer(layer);
  const filter = compileFeatureExpression(JSON.stringify(view.filter), { expectedType: "boolean" });
  const colors = compileFeatureExpression(view.colorExpression, { expectedType: "color" });
  assert.equal(filter.ok, true);
  assert.equal(colors.ok, true); // No duplicate branch labels.
  assert.deepEqual(view.indexes, [0, 1, 2, 3, 4, 5]);
  rendered.geojson!.features.forEach((item, index) => {
    assert.equal(item.id, features[index].id);
    assert.equal(filter.evaluate!(item), true);
    assert.ok(colors.evaluate!(item));
    assert.deepEqual(progressDashboardFeature(layer, item.properties), {
      feature: features[index],
      index,
    });
  });
  assert.equal(progressDashboardLayer(layer).geojson, rendered.geojson);
  assert.deepEqual(rendered.embedFilter, ["all", layer.embedFilter, view.filter]);
  const noDashboard = { ...layer, progressDashboard: undefined };
  assert.deepEqual(
    buildMapboxStyle(layer, layer.geojson!).style,
    buildMapboxStyle(noDashboard, layer.geojson!).style,
  );
  assert.equal(
    layer.geojson!.features[0].properties?.[PROGRESS_DASHBOARD_INDEX_PROPERTY],
    undefined,
  );
  assert.ok(
    !serializeProject({ ...createEmptyProject(), layers: [layer] }).includes(
      PROGRESS_DASHBOARD_INDEX_PROPERTY,
    ),
  );
  assert.equal(progressDashboardFeature(layer, { [PROGRESS_DASHBOARD_INDEX_PROPERTY]: -1 }), null);
  assert.equal(progressDashboardFeature(layer, { [PROGRESS_DASHBOARD_INDEX_PROPERTY]: "0" }), null);
});

it("drops stale bridges and clamps or clears station ranges for the new package", () => {
  const state = fixture();
  state.bridges.push({ ...structuredClone(state.bridges[0]), id: "b2", station: 2000 });
  const rows = dashboardRows(state, "p2");
  const filters = {
    ...EMPTY_DASHBOARD_FILTERS,
    items: ["nen" as const],
    bridgeIds: ["b", "b2"],
    station: [0, 800] as [number, number],
  };
  const scoped = reconcileDashboardFilters(filters, rows);
  assert.deepEqual(scoped.bridgeIds, ["b2"]);
  assert.equal(scoped.station, null);
  assert.deepEqual(scoped.items, filters.items);
  const overlap = reconcileDashboardFilters({ ...filters, station: [500, 2500] }, rows);
  assert.deepEqual(overlap.station, [1000, 2500]);
  assert.equal(reconcileDashboardFilters(overlap, rows), overlap);
  assert.equal(reconcileDashboardFilters(filters, []).station, null);
  assert.equal(reconcileDashboardFilters({ ...filters, station: [0, 1000] }, rows).station, null);
});

it("closing a dashboard does not push history or discard an existing redo entry", () => {
  const layer = geojsonLayer();
  useAppStore.setState({ layers: [layer] });
  clearHistory();
  useAppStore.getState().updateLayer(layer.id, { name: "Author edit" });
  useAppStore.temporal.getState().undo();
  const before = useAppStore.temporal.getState();
  const past = before.pastStates.length,
    future = before.futureStates.length;
  assert.equal(future, 1);
  const view = { filter: ["==", 1, 1], colorExpression: '["case",true,"#fff","#000"]' };
  useAppStore.getState().updateLayer(layer.id, { progressDashboard: view });
  useAppStore.getState().updateLayer(layer.id, { progressDashboard: undefined });
  assert.equal(useAppStore.temporal.getState().pastStates.length, past);
  assert.equal(useAppStore.temporal.getState().futureStates.length, future);
});

it("uses the normal resolver for empty girder indexes and upper-case approach items", () => {
  const state = fixture(),
    rows = dashboardRows(state);
  for (const value of ["", null, undefined]) {
    const features = [
      feature({ bridge_id: "b", span_id: "N1", girder_index: value, progress_item: "bmc" }),
    ];
    assert.deepEqual(
      dashboardMapView(
        features,
        state,
        rows.filter((row) => row.key === "duc"),
        "girder",
      ).indexes,
      [],
    );
    assert.deepEqual(
      dashboardMapView(
        features,
        state,
        rows.filter((row) => row.key === "bmc"),
        "girder",
      ).indexes,
      [0],
    );
  }
  const approaches = [
    feature({ bridge_id: "b", progress_item: "HT" }),
    feature({ bridge_id: "b", progress_item: "APPROACH" }),
  ];
  assert.deepEqual(dashboardMapView(approaches, state, rows, "girder").indexes, [0, 1]);
});

it("shares the yard's remaining definition for stage-one girders and filtered types", () => {
  const state = fixture();
  state.bridges[0].spans[0].girders = Array.from({ length: 3 }, () => ({
    t: "A",
    st: 1 as const,
    dob: "",
    bed: 1,
  }));
  const row = dashboardYard(state, dashboardRows(state))[0];
  assert.deepEqual(row, {
    type: "A",
    total: 3,
    cast: 0,
    onBed: 3,
    ready: 0,
    erected: 0,
    remaining: 3,
  });
});

it("keeps unknown stations out of packages and range filters and formats the local day", () => {
  const state = fixture();
  state.underpasses[0].station = Number.NaN;
  assert.equal(
    dashboardRows(state, "p2").some((row) => row.kind === "underpass"),
    false,
  );
  const rows = dashboardRows(state);
  assert.deepEqual(dashboardStationExtent(rows), [0, 3000]);
  assert.equal(
    filterDashboardRows(rows, { ...EMPTY_DASHBOARD_FILTERS, station: [0, 3000] }).some(
      (row) => row.kind === "underpass",
    ),
    false,
  );
  assert.equal(todayIso(new Date(2026, 0, 2, 23, 59)), "2026-01-02");
});
