import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature } from "geojson";
import {
  PROGRESS_STATUS_PROPERTY,
  cellKey,
  cellState,
  componentMatrix,
  computeProgress,
  normalizeProgressConfig,
  progressStructures,
} from "../apps/geolibre-desktop/src/lib/construction-progress";

function f(
  layer: string,
  structure: string | null,
  component: string | null,
  order: number | null,
  status?: "done" | "wip",
): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties: {
      Layer: layer,
      ...(structure ? { cong_trinh: structure } : {}),
      ...(component ? { cau_kien: component } : {}),
      ...(order !== null ? { thu_tu: order } : {}),
      ...(status ? { [PROGRESS_STATUS_PROPERTY]: status } : {}),
    },
  };
}

const config = normalizeProgressConfig({
  items: [
    { key: "coc", name: "Cọc", cadLayers: ["COC"], weight: 2, plannedPct: 50 },
    { key: "be", name: "Bệ", cadLayers: ["BE"], weight: 1, plannedPct: 0 },
    { key: "mat", name: "Mặt đường", cadLayers: ["MAT"], weight: 5, overridePct: 90 },
  ],
})!;

const features = [
  // Bridge B, listed after the road by its order.
  f("COC", "Cầu B", "T1", 20, "done"),
  f("COC", "Cầu B", "T1", 20, "wip"),
  f("BE", "Cầu B", "T1", 20),
  f("COC", "Cầu B", "M1", 10, "done"),
  f("BE", "Cầu B", "M1", 10, "done"),
  // Road A.
  f("MAT", "Đường A", "Km1", 1, "done"),
  f("MAT", "Đường A", "Km2", 2),
  // No structure: counts for the project only.
  f("COC", null, null, null, "done"),
];

describe("progressStructures", () => {
  it("groups by structure in route order and scores each on its own items", () => {
    const structures = progressStructures(features, config);
    assert.deepEqual(
      structures.map((s) => s.name),
      ["Đường A", "Cầu B"],
    );
    const bridge = structures[1];
    assert.deepEqual(bridge.featureIndexes, [0, 1, 2, 3, 4]);
    // Cọc: 2 done + ½ wip of 3 = 83.3 %; Bệ: 1 of 2 = 50 %. Weighted 2:1, pavement left out.
    const coc = bridge.summary.items.find((i) => i.item.key === "coc")!;
    assert.ok(Math.abs(coc.pct - 250 / 3) < 1e-9);
    assert.ok(Math.abs(bridge.summary.overallPct - (2 * (250 / 3) + 50) / 3) < 1e-9);
    // The road's pavement uses its own features, not the project-wide manual 90 %.
    assert.equal(structures[0].summary.overallPct, 50);
  });

  it("keeps the manual percent at project level", () => {
    const project = computeProgress(features, config);
    assert.equal(project.items.find((i) => i.item.key === "mat")!.pct, 90);
  });

  it("is empty for a drawing without structures", () => {
    assert.deepEqual(progressStructures([f("COC", null, null, null)], config), []);
  });
});

describe("componentMatrix", () => {
  it("lays a structure out as components by the items it holds", () => {
    const matrix = componentMatrix(features, config, "Cầu B");
    assert.deepEqual(
      matrix.components.map((c) => c.name),
      ["M1", "T1"],
    );
    assert.deepEqual(
      matrix.items.map((i) => i.key),
      ["coc", "be"],
    );
    const t1coc = matrix.cells.get(cellKey("T1", "coc"))!;
    assert.deepEqual(t1coc.featureIndexes, [0, 1]);
    assert.deepEqual(t1coc.counts, { done: 1, wip: 1, none: 0 });
    assert.equal(t1coc.state, "partial");
    assert.equal(t1coc.pct, 75);
    assert.equal(matrix.cells.get(cellKey("M1", "be"))!.state, "done");
    assert.equal(matrix.cells.get(cellKey("T1", "be"))!.state, "none");
    assert.equal(matrix.cells.has(cellKey("M1", "mat")), false);
  });

  it("orders components naturally when no order is given", () => {
    const unordered = ["T10", "T2", "M1"].map((c) => f("COC", "Cầu C", c, null));
    assert.deepEqual(
      componentMatrix(unordered, config, "Cầu C").components.map((c) => c.name),
      ["M1", "T2", "T10"],
    );
  });
});

describe("cellState", () => {
  it("reads all done, all in progress, none, or a mix", () => {
    assert.equal(cellState({ done: 0, wip: 0, none: 0 }), "none");
    assert.equal(cellState({ done: 0, wip: 0, none: 3 }), "none");
    assert.equal(cellState({ done: 2, wip: 0, none: 0 }), "done");
    assert.equal(cellState({ done: 0, wip: 2, none: 0 }), "wip");
    assert.equal(cellState({ done: 1, wip: 0, none: 1 }), "partial");
  });
});

describe("paintFeatures", () => {
  it("marks given features without touching the selection", async () => {
    const { useAppStore, DEFAULT_LAYER_STYLE } = await import("@geolibre/core");
    const { paintFeatures } = await import("../apps/geolibre-desktop/src/lib/selection-actions");
    const { progressStatusPaint } =
      await import("../apps/geolibre-desktop/src/lib/construction-progress");
    useAppStore.setState({
      layers: [
        {
          id: "d",
          name: "d",
          type: "geojson",
          visible: true,
          opacity: 1,
          source: { type: "geojson" },
          style: { ...DEFAULT_LAYER_STYLE },
          metadata: {},
          geojson: { type: "FeatureCollection", features: features.slice(0, 3) },
        } as never,
      ],
      selectedLayerId: "d",
      selectedFeatureIds: ["2"],
    });
    try {
      const { color, extra } = progressStatusPaint("done");
      assert.equal(paintFeatures("d", new Set(["1", "2"]), color, extra), 2);
      const props = useAppStore
        .getState()
        .layers[0].geojson!.features.map((x) => x.properties?.[PROGRESS_STATUS_PROPERTY]);
      assert.deepEqual(props, ["done", "done", "done"]);
      assert.deepEqual(useAppStore.getState().selectedFeatureIds, ["2"]);
      assert.equal(paintFeatures("missing", new Set(["1"]), color, extra), 0);
    } finally {
      useAppStore.setState({ layers: [], selectedLayerId: null, selectedFeatureIds: [] });
    }
  });
});
