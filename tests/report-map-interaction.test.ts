import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GeoLibreLayer } from "@geolibre/core";
import { createExpression, createPropertyExpression } from "@maplibre/maplibre-gl-style-spec";
import {
  parseBoardReport,
  linesForFront,
} from "../apps/geolibre-desktop/src/lib/daily-report-data";
import {
  frontAtStations,
  frontForLine,
  frontProgress,
  frontToday,
  locateReportText,
  orderedPhotos,
  photoFront,
  positionAtChainage,
  reportPointLayers,
  stretchBetween,
  structureSelection,
  workAtStations,
} from "../apps/geolibre-desktop/src/lib/report-map-interaction";
import {
  reportBand,
  reportDashboardView,
  reportLegend,
  reportLineProgress,
} from "../apps/geolibre-desktop/src/lib/report-map-view";
import {
  collectSegments,
  readLayerConfig,
} from "../apps/geolibre-desktop/src/lib/network-dashboard";

// Hand-made numbers and geometries, never an extract/copy of a private workbook.
const report = (pkg = "XL01") =>
  parseBoardReport({
    goi: pkg,
    date: "2026-11-19",
    mui: [
      { id: "M01", name: "Mũi 01", km0: 148000, km1: 149000 },
      { id: "M02", name: "Mũi 02", km0: 149000, km1: 150000 },
    ],
    muiRows: [{ mui: "M01", bvtk: 13516, lk: 9200, rateFile: null }],
    work: [
      {
        part: "D",
        grp: "Km148+000 – Km149+000",
        name: "Đắp nền",
        mui: "M01",
        bvtk: 100,
        lk: 30,
        today: "Đắp 20 m",
      },
      { part: "D", grp: "Km149+000 – Km150+000", name: "Đường", mui: "M01", rateFile: 0.55 },
      { part: "C", grp: "CVN Km148+300,5", name: "Móng", mui: "M01", rateFile: 1 },
    ],
    photos: [
      { caption: "Mũi 2: đắp", ref: { id: "b" } },
      { caption: "Mũi 01: nền", ref: { id: "a" } },
      { caption: "CVN Km148+300", ref: { id: "c" } },
      { caption: "Không rõ" },
    ],
  })!;
const layer = {
  id: "arbitrary-route-id",
  name: "Route",
  type: "geojson",
  visible: true,
  style: {},
  source: { type: "geojson" },
  geojson: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { Ten: "XL01 · Mũi 01", Ly_trinh: "Km148+000 – Km149+000" },
        geometry: {
          type: "LineString",
          coordinates: [
            [106, 10],
            [106, 10.004],
            [106, 10.01],
          ],
        },
      },
      {
        type: "Feature",
        properties: { Ten: "XL01 · Mũi 02" },
        geometry: {
          type: "LineString",
          coordinates: [
            [106, 10.01],
            [106, 10.02],
          ],
        },
      },
      {
        type: "Feature",
        properties: { Ten: "XL04 · Mũi 01" },
        geometry: {
          type: "LineString",
          coordinates: [
            [106, 11],
            [106, 11.01],
          ],
        },
      },
    ],
  },
} as unknown as GeoLibreLayer;
const lines = collectSegments([layer]);

describe("report ↔ map matching", () => {
  it("reverses front matching across packages and normalizes leading zeroes without prefix collisions", () => {
    assert.deepEqual(frontForLine("XL01 · Mũi 1", [report(), report("XL04")]), {
      pkg: "XL01",
      frontId: "M01",
    });
    assert.equal(frontForLine("XL01 · Mũi 010", [report()]), null);
    assert.equal(frontForLine("XL99 · Mũi 01", [report()]), null);
    assert.equal(linesForFront([{ name: "XL01 · Mũi 1" }], "XL01", report().fronts[0]).length, 1);
  });
  it("matches structures by package field, or an unambiguous containing front; respects 1 metre tolerance", () => {
    assert.deepEqual(
      structureSelection("CVN Km148+300", { Goi_thau: "Gói XL04" }, [report(), report("XL04")]),
      { pkg: "XL04", frontId: "M01", stations: [148300] },
    );
    assert.equal(structureSelection("CVN Km148+300", {}, [report(), report("XL04")]), null);
    assert.equal(structureSelection("CVN Km148+300", { package: "XL99" }, [report()]), null);
    assert.equal(structureSelection("Unlocated", {}, [report()]), null);
    assert.equal(structureSelection("CVN Km180+000", {}, [report()]), null);
    assert.deepEqual(
      structureSelection("CVN Km180+000", { Goi_thau: "XL01" }, [report()]),
      { pkg: "XL01", frontId: null, stations: [180000] },
      "an explicit package still selects matching general work when the report has no front range there",
    );
    assert.equal(frontAtStations(report().fronts, [149000])?.id, "M02");
    assert.equal(frontAtStations(report().fronts, [])?.id, undefined);
    assert.equal(workAtStations(report().work[2], [148301.5]), true);
    assert.equal(workAtStations(report().work[2], [148301.51]), false);
  });
  it("orders front photos stably, resolves captions and dims the rest without mutating the report", () => {
    const r = report();
    const before = JSON.stringify(r);
    assert.equal(photoFront({ caption: "mũi 1: thi công", id: null }, r.fronts), "M01");
    assert.equal(photoFront({ caption: "Mũi 99 Km149+200", id: null }, r.fronts), "M02");
    assert.equal(photoFront({ caption: "Chung", id: null }, r.fronts), null);
    assert.deepEqual(
      orderedPhotos(r, "M01").map((p) => [p.index, p.dimmed]),
      [
        [1, false],
        [2, false],
        [0, true],
        [3, true],
      ],
    );
    assert.deepEqual(
      orderedPhotos(r, null).map((p) => p.index),
      [0, 1, 2, 3],
    );
    assert.equal(JSON.stringify(r), before);
  });
  it("uses only visible, included point layers, independent of their ids", () => {
    const points = {
      ...layer,
      id: "points",
      geojson: {
        type: "FeatureCollection",
        features: [
          { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [106, 10] } },
        ],
      },
    } as GeoLibreLayer;
    assert.deepEqual(
      reportPointLayers([
        layer,
        points,
        { ...points, visible: false },
        { ...points, metadata: { networkDashboard: { included: false } } },
      ]),
      [points],
    );
  });
});

describe("the owner's summary-first front progress rule", () => {
  it("reproduces XL01 Mũi 01 = 68.1% (9200/13516), and XL04 Mũi 02 = 55%", () => {
    const xl01 = report();
    assert.equal(frontProgress(xl01, xl01.fronts[0]), 68.1);
    const xl04 = report("XL04");
    xl04.muiRows = [{ front: "M02", done: null, planned: null, rateInFile: 0.55 }];
    assert.equal(frontProgress(xl04, xl04.fronts[1]), 55);
    assert.deepEqual(
      parseBoardReport({ goi: "XL01", date: "2026-11-19", muiRows: [null, { mui: "" }] })?.muiRows,
      [],
    );
  });
  it("prefers the summary percentage over quantities; fallback is road-only and corrects the parser's boundary assignment", () => {
    const r = report();
    r.muiRows[0].rateInFile = 0.4;
    assert.equal(frontProgress(r, r.fronts[0]), 40);
    r.muiRows = [];
    assert.equal(frontProgress(r, r.fronts[0]), 30, "bridge work must not inflate road progress");
    assert.equal(frontProgress(r, r.fronts[1]), 55, "range belongs to M02 despite stored mui=M01");
    r.work.push({ ...r.work[0], group: "", front: "M02", planned: 100, done: 200 });
    assert.equal(
      frontProgress(r, r.fronts[1]),
      77.5,
      "cap each known road rate before taking its mean",
    );
    r.work = [];
    assert.equal(frontProgress(r, r.fronts[0]), null);
    assert.equal(frontToday(r, r.fronts[0]), "");
  });
  it("shortens today's text and uses exact band boundaries", () => {
    const r = report();
    assert.match(frontToday(r, r.fronts[0]), /Đắp nền: Đắp 20 m/);
    r.work[0].today = "x".repeat(300);
    assert.equal(frontToday(r, r.fronts[0]).length, 238);
    assert.deepEqual(
      [null, 0, 19.9, 20, 40, 60, 80, 100].map((p) => reportBand(p).color),
      ["#94a3b8", "#dc2626", "#dc2626", "#f97316", "#eab308", "#65a30d", "#15803d", "#15803d"],
    );
  });
});

describe("chainage geometry", () => {
  const path = [
    [106, 10, 10],
    [106, 10.004, 20],
    [106, 10.01, 30],
  ];
  it("interpolates by length, preserving endpoints, altitude and descending station order", () => {
    const midpoint = positionAtChainage(path, 148000, 149000, 148500)!;
    assert.ok(Math.abs(midpoint[1] - 10.005) < 1e-9);
    assert.ok(Math.abs(midpoint[2] - (20 + 10 / 6)) < 1e-7);
    assert.deepEqual(positionAtChainage(path, 149000, 148000, 149000), path[0]);
    assert.deepEqual(positionAtChainage(path, 149000, 148000, 148000), path.at(-1));
  });
  it("clips ranges and keeps intermediate vertices in the requested direction", () => {
    const result = stretchBetween(path, 148000, 149000, 148200, 148800)!;
    assert.equal(result.length, 3);
    assert.deepEqual(result[1], path[1]);
    assert.ok(Math.abs(result[0][1] - 10.002) < 1e-9);
    assert.deepEqual(stretchBetween(path, 148000, 149000, 148800, 148200), [...result].reverse());
    assert.equal(stretchBetween(path, 148000, 149000, 148200, 148200), null);
  });
  it("never extrapolates or invents a position for missing/degenerate/invalid paths", () => {
    assert.equal(positionAtChainage(path, 148000, 149000, 147999), null);
    assert.equal(positionAtChainage(path, 148000, 149000, NaN), null);
    assert.equal(positionAtChainage([], 1, 2, 1.5), null);
    assert.equal(
      positionAtChainage(
        [
          [0, 0],
          [0, 0],
        ],
        1,
        2,
        1.5,
      ),
      null,
    );
    assert.equal(
      positionAtChainage(
        [
          [0, 0],
          [NaN, 1],
        ],
        1,
        2,
        1.5,
      ),
      null,
    );
    assert.equal(positionAtChainage(path, 1, 1, 1), null);
    assert.equal(stretchBetween(path, 148000, 149000, 148500, 150000), null);
  });
  it("locates a point and a stretch only on the named front line covering all stations", () => {
    const r = report();
    const before = JSON.stringify(layer);
    const point = locateReportText("CVN Km148+500", r, lines, [layer])!;
    assert.equal(point.feature.geometry.type, "Point");
    assert.deepEqual(point.selection, { pkg: "XL01", frontId: "M01" });
    assert.equal(
      locateReportText("Km148+200 – Km148+800", r, lines, [layer])?.feature.geometry.type,
      "LineString",
    );
    assert.equal(locateReportText("Km148+200 – Km149+800", r, lines, [layer]), null);
    assert.equal(locateReportText("Km148+500", r, [], [layer]), null);
    assert.equal(locateReportText("No station", r, lines, [layer]), null);
    assert.equal(JSON.stringify(layer), before);
  });
});

describe("report renderer view", () => {
  it("recolours by the report day, dims other packages and emphasizes only the selected front with valid MapLibre expressions", () => {
    const r = report();
    const view = reportDashboardView(
      layer.id,
      readLayerConfig(layer),
      lines,
      "report",
      new Map(),
      r,
      { pkg: r.pkg, frontId: "M01" },
    );
    const expression = createExpression(JSON.parse(view.colorExpression), "line-color", {
      type: "color",
      "property-type": "data-driven",
      transition: false,
      overridable: false,
    });
    assert.equal(expression.result, "success", JSON.stringify(expression));
    if (expression.result !== "success") return;
    const color = (index: number) =>
      expression.value.evaluate(
        { zoom: 12 },
        { type: "LineString", properties: { __geolibre_progress_index: index } },
      );
    assert.ok(color(0).a === 1 && color(1).a === 0.2);
    const width = createPropertyExpression(view.lineWidth, "line-width", {
      type: "number",
      transition: false,
      "property-type": "data-driven",
      expression: { interpolated: true, parameters: ["zoom", "feature"] },
    });
    assert.equal(width.result, "success", JSON.stringify(width));
    assert.equal(reportLineProgress(lines[2], r), null);
    assert.equal(reportLineProgress(lines[0], null), null);
    assert.ok(reportLegend(lines, r).find((band) => band.value === "60")!.km > 0);
    r.muiRows[0].done = 4000;
    assert.notEqual(
      reportDashboardView(layer.id, readLayerConfig(layer), lines, "report", new Map(), r, null)
        .colorExpression,
      view.colorExpression,
    );
  });
  it("keeps status/type mode and removes emphasis entirely on clear", () => {
    const config = readLayerConfig(layer);
    const view = reportDashboardView(
      layer.id,
      config,
      lines,
      "type",
      new Map([["", "#123456"]]),
      report(),
      null,
    );
    assert.equal(JSON.stringify(view.lineWidth).includes("case"), false);
    assert.match(view.colorExpression, /123456/);
    const selected = reportDashboardView(layer.id, config, lines, "status", new Map(), report(), {
      pkg: "XL01",
      frontId: "M02",
    });
    assert.match(selected.colorExpression, /case/);
  });
});
