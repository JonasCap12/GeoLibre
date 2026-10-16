import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection, Geometry, Polygon } from "geojson";
import {
  PROGRESS_METADATA_KEY,
  PROGRESS_STATUS_COLORS,
  PROGRESS_STATUS_PROPERTY,
  cadLayerNames,
  computeProgress,
  findProgressLayer,
  geometryMeasure,
  isoWeek,
  normalizeProgressConfig,
  progressConfigPatch,
  progressIssues,
  progressStatusPaint,
  readProgressConfig,
  recordWeek,
  rowsThatFit,
  suggestProgressConfig,
  type ConstructionProgress,
  type ProgressItem,
} from "../apps/geolibre-desktop/src/lib/construction-progress";
import {
  featureAreaColorPatch,
  featureColorPatch,
} from "../apps/geolibre-desktop/src/lib/feature-color";

function feature(layer: string, geometry: Geometry, status?: string): Feature {
  return {
    type: "Feature",
    geometry,
    properties: { Layer: layer, ...(status ? { [PROGRESS_STATUS_PROPERTY]: status } : {}) },
  };
}

const point = (x: number): Geometry => ({ type: "Point", coordinates: [x, 0] });
/** A line along the equator; 0.001° there is about 111.3 m. */
const line = (x0: number, x1: number): Geometry => ({
  type: "LineString",
  coordinates: [
    [x0, 0],
    [x1, 0],
  ],
});

function item(patch: Partial<ProgressItem> = {}): ProgressItem {
  return {
    key: "coc",
    name: "Cọc",
    weight: 1,
    cadLayers: ["COC"],
    measure: "count",
    plannedPct: 0,
    overridePct: null,
    ...patch,
  };
}

function config(items: ProgressItem[], patch: Partial<ConstructionProgress> = {}) {
  return normalizeProgressConfig({ title: "Cầu", items, ...patch })!;
}

function layer(features: Feature[], metadata: Record<string, unknown> = {}): GeoLibreLayer {
  const geojson: FeatureCollection = { type: "FeatureCollection", features };
  return {
    id: "drawing",
    name: "Bản vẽ",
    type: "geojson",
    visible: true,
    opacity: 1,
    geojson,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata,
  } as GeoLibreLayer;
}

describe("normalizeProgressConfig", () => {
  it("rejects non-objects and keeps valid items", () => {
    assert.equal(normalizeProgressConfig(null), null);
    assert.equal(normalizeProgressConfig("x"), null);
    const result = normalizeProgressConfig({
      title: "Cầu",
      items: [{ name: "Cọc", cadLayers: ["COC", 3], plannedPct: 150 }, { name: "  " }, 7],
    });
    assert.equal(result?.items.length, 1);
    assert.deepEqual(result?.items[0].cadLayers, ["COC"]);
    assert.equal(result?.items[0].plannedPct, 100);
    assert.equal(result?.items[0].measure, "count");
    assert.equal(result?.items[0].overridePct, null);
  });

  it("makes item keys unique and sorts weekly records by date", () => {
    const result = normalizeProgressConfig({
      items: [
        { key: "a", name: "A" },
        { key: "a", name: "B" },
      ],
      weekly: [
        { week: "2026-W42", date: "2026-10-16", actualPct: 30, plannedPct: 32 },
        { week: "2026-W41", date: "2026-10-09", actualPct: 25, plannedPct: 28 },
        { week: "", date: "2026-10-01" },
      ],
    });
    assert.deepEqual(
      result?.items.map((i) => i.key),
      ["a", "a-2"],
    );
    assert.deepEqual(
      result?.weekly.map((w) => w.week),
      ["2026-W41", "2026-W42"],
    );
  });
});

describe("geometryMeasure", () => {
  it("counts any geometry and measures lines in metres", () => {
    assert.equal(geometryMeasure(point(0), "count"), 1);
    assert.equal(geometryMeasure(point(0), "length"), 0);
    assert.equal(geometryMeasure(null, "count"), 0);
    const metres = geometryMeasure(line(0, 0.001), "length");
    assert.ok(Math.abs(metres - 111.2) < 0.5, `got ${metres}`);
  });

  it("measures polygon area in square metres and outline as length", () => {
    const square: Geometry = {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [0.001, 0],
          [0.001, 0.001],
          [0, 0.001],
          [0, 0],
        ],
      ],
    };
    const area = geometryMeasure(square, "area");
    assert.ok(Math.abs(area - 12_365) < 50, `got ${area}`);
    const perimeter = geometryMeasure(square, "length");
    assert.ok(Math.abs(perimeter - 444.8) < 2, `got ${perimeter}`);
  });
});

describe("computeProgress", () => {
  const features = [
    feature("COC", point(0), "done"),
    feature("COC", point(1), "done"),
    feature("COC", point(2), "wip"),
    feature("COC", point(3)),
    feature("DAM", line(0, 0.001), "done"),
    feature("DAM", line(0.001, 0.003)),
    feature("TEXT", point(9), "done"),
  ];

  it("credits done fully and in-progress by half", () => {
    const summary = computeProgress(features, config([item()]));
    assert.equal(summary.items[0].featureCount, 4);
    assert.equal(summary.items[0].drawingPct, 62.5);
    assert.equal(summary.overallPct, 62.5);
  });

  it("measures by length when the item says so", () => {
    const summary = computeProgress(
      features,
      config([item({ key: "dam", cadLayers: ["DAM"], measure: "length" })]),
    );
    assert.ok(Math.abs(summary.items[0].pct - 100 / 3) < 0.01);
  });

  it("lets an override win and weights the overall figure", () => {
    const summary = computeProgress(
      features,
      config([
        item({ weight: 3, plannedPct: 70 }),
        item({ key: "x", cadLayers: ["DAM"], weight: 1, overridePct: 10, plannedPct: 30 }),
      ]),
    );
    assert.equal(summary.items[1].pct, 10);
    assert.ok(summary.items[1].drawingPct !== null);
    assert.equal(summary.overallPct, (3 * 62.5 + 10) / 4);
    assert.equal(summary.plannedPct, (3 * 70 + 30) / 4);
    assert.equal(summary.deviation, summary.overallPct - summary.plannedPct);
  });

  it("reads 0 for an item matching nothing, and 0 overall with no weight", () => {
    const summary = computeProgress(features, config([item({ cadLayers: ["NONE"], weight: 0 })]));
    assert.equal(summary.items[0].drawingPct, null);
    assert.equal(summary.items[0].pct, 0);
    assert.equal(summary.overallPct, 0);
  });
});

describe("suggestProgressConfig", () => {
  it("makes one item per CAD layer, most features first", () => {
    const features = [
      feature("DAM", line(0, 1)),
      feature("COC", point(0)),
      feature("COC", point(1)),
    ];
    assert.deepEqual(cadLayerNames(features), ["COC", "DAM"]);
    const suggested = suggestProgressConfig(features, "Cầu");
    assert.equal(suggested.title, "Cầu");
    assert.deepEqual(
      suggested.items.map((i) => [i.name, i.measure]),
      [
        ["COC", "count"],
        ["DAM", "length"],
      ],
    );
  });
});

describe("weekly records", () => {
  it("computes ISO weeks, including the year boundary", () => {
    assert.equal(isoWeek("2026-10-16"), "2026-W42");
    assert.equal(isoWeek("2026-10-12"), "2026-W42");
    assert.equal(isoWeek("2027-01-01"), "2026-W53");
    assert.equal(isoWeek("2024-12-30"), "2025-W01");
  });

  it("replaces a record in the same week", () => {
    const base = config([item()]);
    const once = recordWeek(base, "2026-10-12", { overallPct: 20.04, plannedPct: 25 });
    const twice = recordWeek(once, "2026-10-16", { overallPct: 21.26, plannedPct: 25 });
    assert.equal(twice.weekly.length, 1);
    assert.deepEqual(twice.weekly[0], {
      week: "2026-W42",
      date: "2026-10-16",
      actualPct: 21.3,
      plannedPct: 25,
    });
    const next = recordWeek(twice, "2026-10-20", { overallPct: 24, plannedPct: 28 });
    assert.deepEqual(
      next.weekly.map((w) => w.week),
      ["2026-W42", "2026-W43"],
    );
  });
});

describe("layer storage", () => {
  it("stores, reads and removes the setup in layer metadata", () => {
    const plain = layer([], { other: 1 });
    assert.equal(readProgressConfig(plain), null);
    assert.equal(findProgressLayer([plain]), null);
    const patch = progressConfigPatch(plain, config([item()]));
    assert.equal((patch.metadata as Record<string, unknown>).other, 1);
    const stored = { ...plain, ...patch };
    assert.equal(readProgressConfig(stored)?.items.length, 1);
    assert.equal(findProgressLayer([plain, stored]), stored);
    const removed = progressConfigPatch(stored, null);
    assert.equal(PROGRESS_METADATA_KEY in (removed.metadata ?? {}), false);
  });
});

describe("status painting", () => {
  it("writes the state with its color and clears both", () => {
    const drawing = layer([feature("COC", point(0)), feature("COC", point(1))]);
    const done = progressStatusPaint("done");
    const patch = featureColorPatch(drawing, new Set(["0"]), done.color, done.extra);
    const painted = patch?.geojson?.features[0].properties;
    assert.equal(painted?.[PROGRESS_STATUS_PROPERTY], "done");
    assert.equal(painted?.stroke, PROGRESS_STATUS_COLORS.done);
    assert.equal(patch?.geojson?.features[1].properties?.[PROGRESS_STATUS_PROPERTY], undefined);

    const clear = progressStatusPaint(null);
    const cleared = featureColorPatch(
      { ...drawing, ...patch } as GeoLibreLayer,
      new Set(["0"]),
      clear.color,
      clear.extra,
    );
    const props = cleared?.geojson?.features[0].properties;
    assert.equal(props?.[PROGRESS_STATUS_PROPERTY], undefined);
    assert.equal(props?.stroke, undefined);
    assert.equal(props?.Layer, "COC");
  });

  it("marks only the swept part of a line", () => {
    const drawing = layer([feature("DAM", line(0, 0.002))]);
    const wip = progressStatusPaint("wip");
    const patch = featureAreaColorPatch(
      drawing,
      {
        type: "Polygon",
        coordinates: [
          [
            [-0.001, -0.001],
            [0.001, -0.001],
            [0.001, 0.001],
            [-0.001, 0.001],
            [-0.001, -0.001],
          ],
        ],
      },
      wip.color,
      wip.extra,
    );
    const parts = patch?.geojson?.features ?? [];
    assert.equal(parts.length, 2);
    assert.equal(parts[0].properties?.[PROGRESS_STATUS_PROPERTY], undefined);
    assert.equal(parts[1].properties?.[PROGRESS_STATUS_PROPERTY], "wip");
    const summary = computeProgress(
      parts,
      config([item({ cadLayers: ["DAM"], measure: "length" })]),
    );
    assert.ok(Math.abs(summary.overallPct - 25) < 0.5, `got ${summary.overallPct}`);
  });
});

describe("issues and fitting", () => {
  it("lists non-empty note lines without bullets", () => {
    const c = config([], { notes: "- Thiếu bản vẽ bệ P053\n\n• Chờ TVTK xác nhận P057  \n" });
    assert.deepEqual(progressIssues(c), ["Thiếu bản vẽ bệ P053", "Chờ TVTK xác nhận P057"]);
  });

  it("collapses rows that do not fit into a +N row", () => {
    assert.equal(rowsThatFit(5, 200, 30), 5);
    assert.equal(rowsThatFit(10, 200, 30), 5);
    assert.equal(rowsThatFit(10, 20, 30), 0);
    assert.equal(rowsThatFit(0, 200, 30), 0);
  });
});

describe("progress screen", () => {
  it("opens on the active drawing and seeds a setup from its CAD layers", async () => {
    const { useAppStore } = await import("@geolibre/core");
    const screen = await import("../apps/geolibre-desktop/src/lib/progress-screen");
    const drawing = layer([feature("COC", point(0)), feature("DAM", line(0, 1))]);
    const empty = { ...layer([]), id: "empty" } as GeoLibreLayer;
    useAppStore.setState({ layers: [empty, drawing], selectedLayerId: "empty" });
    try {
      let calls = 0;
      const unsubscribe = screen.subscribeProgressScreen(() => (calls += 1));
      // Neither the empty active layer nor a missing id can carry progress.
      assert.equal(screen.openProgressScreen(), null);
      assert.equal(screen.openProgressScreen("missing"), null);
      useAppStore.setState({ selectedLayerId: "drawing" });
      assert.equal(screen.openProgressScreen(), "drawing");
      assert.equal(screen.getProgressScreenLayerId(), "drawing");
      const stored = readProgressConfig(useAppStore.getState().layers[1]);
      assert.deepEqual(
        stored?.items.map((i) => i.name),
        ["COC", "DAM"],
      );
      assert.equal(stored?.title, "Bản vẽ");
      // Once a layer has a setup, it is found without being active.
      useAppStore.setState({ selectedLayerId: null });
      assert.equal(screen.progressScreenTarget(useAppStore.getState().layers, null)?.id, "drawing");
      screen.closeProgressScreen();
      screen.closeProgressScreen();
      assert.equal(screen.getProgressScreenLayerId(), null);
      assert.equal(calls, 2);
      unsubscribe();
    } finally {
      useAppStore.setState({ layers: [], selectedLayerId: null });
    }
  });
});

describe("item features and bounds", () => {
  it("finds an item's features and the box around them", async () => {
    const { itemFeatureIndexes, featuresBounds } =
      await import("../apps/geolibre-desktop/src/lib/construction-progress");
    const features = [
      feature("COC", point(2)),
      feature("DAM", line(0, 1)),
      feature("COC", { type: "Point", coordinates: [5, -1] }),
    ];
    const indexes = itemFeatureIndexes(features, item());
    assert.deepEqual(indexes, [0, 2]);
    assert.deepEqual(featuresBounds(indexes.map((i) => features[i])), [2, -1, 5, 0]);
    assert.equal(featuresBounds([]), null);
    assert.equal(
      featuresBounds([{ type: "Feature", geometry: null, properties: {} } as unknown as Feature]),
      null,
    );
  });
});

describe("sweeping counted items", () => {
  it("marks a counted feature only when the sweep holds all of it", async () => {
    const { countedFeatureTest } =
      await import("../apps/geolibre-desktop/src/lib/construction-progress");
    const square = (x: number): Geometry => ({
      type: "Polygon",
      coordinates: [
        [
          [x, 0],
          [x + 0.001, 0],
          [x + 0.001, 0.001],
          [x, 0.001],
          [x, 0],
        ],
      ],
    });
    const drawing = layer([
      feature("COC", square(0)),
      feature("COC", square(0.002)),
      feature("DAM", line(0, 0.004)),
    ]);
    const c = config([item(), item({ key: "dam", cadLayers: ["DAM"], measure: "length" })]);
    const done = progressStatusPaint("done");
    // Holds the first pile, cuts the second, and covers half the girder.
    const sweep: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-0.001, -0.001],
          [0.0025, -0.001],
          [0.0025, 0.002],
          [-0.001, 0.002],
          [-0.001, -0.001],
        ],
      ],
    };
    const patch = featureAreaColorPatch(
      drawing,
      sweep,
      done.color,
      done.extra,
      countedFeatureTest(c),
    );
    const features = patch?.geojson?.features ?? [];
    // Piles stay two features; the girder is split in two.
    assert.deepEqual(
      features.map((f) => [f.properties?.Layer, f.properties?.[PROGRESS_STATUS_PROPERTY] ?? null]),
      [
        ["COC", "done"],
        ["COC", null],
        ["DAM", null],
        ["DAM", "done"],
      ],
    );
    const summary = computeProgress(features, c);
    assert.equal(summary.items[0].pct, 50);
    assert.ok(Math.abs(summary.items[1].pct - 62.5) < 0.5, `got ${summary.items[1].pct}`);
  });
});
