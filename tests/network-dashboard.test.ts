import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createEmptyProject,
  lineWidthValue,
  progressDashboardLayer,
  serializeProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import type { Feature } from "geojson";
import {
  categoryColors,
  collectSegments,
  parsePercent,
  fieldValues,
  foldText,
  isNetworkCandidate,
  layerConfigPatch,
  layerView,
  lineKm,
  NETWORK_LINE_WIDTH,
  NETWORK_METADATA_KEY,
  parseYear,
  readLayerConfig,
  segmentsBounds,
  shownIndexes,
  suggestFields,
  UNCLASSIFIED_COLOR,
} from "../apps/geolibre-desktop/src/lib/network-dashboard";
import { constructionProgressEnabled } from "../apps/geolibre-desktop/src/lib/construction-progress-flag";

function line(coordinates: [number, number][], properties: Record<string, unknown>): Feature {
  return { type: "Feature", geometry: { type: "LineString", coordinates }, properties };
}

/** One degree of latitude along a meridian: ~111.2 km. */
const ONE_DEGREE: [number, number][] = [
  [106, 10],
  [106, 11],
];

function routes(): GeoLibreLayer {
  return {
    id: "routes",
    name: "Tuyến dự án",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        line(ONE_DEGREE, {
          Ten_du_an: "Cao tốc A",
          Trang_thai: "Đang thi công",
          Loai: "Cao tốc",
          Nam_KC: 2023,
        }),
        line(ONE_DEGREE, {
          Ten_du_an: "QL 14",
          Trang_thai: "Hoàn thành",
          Loai: "Quốc lộ",
          Nam_KC: "2021-05-01",
        }),
        line(ONE_DEGREE, {
          Ten_du_an: "Cầu B",
          Trang_thai: "Chuẩn bị đầu tư",
          Loai: "Cầu",
          Nam_KC: null,
        }),
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [106, 10] },
          properties: { Ten_du_an: "Mốc" },
        },
      ],
    },
  } as unknown as GeoLibreLayer;
}

describe("road network dashboard: geometry", () => {
  it("measures a line in kilometres", () => {
    const km = lineKm({ type: "LineString", coordinates: ONE_DEGREE });
    assert.ok(Math.abs(km - 111.19) < 0.1, `got ${km}`);
    const multi = lineKm({ type: "MultiLineString", coordinates: [ONE_DEGREE, ONE_DEGREE] });
    assert.ok(Math.abs(multi - 2 * km) < 1e-9);
    assert.equal(lineKm({ type: "Point", coordinates: [0, 0] }), 0);
  });

  it("takes part only with line features", () => {
    assert.equal(isNetworkCandidate(routes()), true);
    const points = {
      ...routes(),
      geojson: { type: "FeatureCollection", features: [routes().geojson!.features[3]] },
    };
    assert.equal(isNetworkCandidate(points as GeoLibreLayer), false);
  });

  it("frames the given lines", () => {
    const layer = routes();
    assert.deepEqual(segmentsBounds([layer], collectSegments([layer])), [106, 10, 106, 11]);
    assert.equal(segmentsBounds([layer], []), null);
  });
});

describe("road network dashboard: fields", () => {
  it("folds Vietnamese diacritics", () => {
    assert.equal(foldText("  Đang Thi Công "), "dang thi cong");
  });

  it("guesses Vietnamese attribute names", () => {
    assert.deepEqual(suggestFields(routes().geojson!.features), {
      name: "Ten_du_an",
      status: "Trang_thai",
      type: "Loai",
      year: "Nam_KC",
      progress: "",
      plan: "",
    });
  });

  it("tells percent done from planned, and skips the gap between them", () => {
    const features = [
      line(ONE_DEGREE, {
        Ten: "Đoạn 1",
        Chenh_lech_pct: -10,
        Tien_do_pct: 40,
        Ke_hoach_tien_do: 50,
      }),
    ];
    const fields = suggestFields(features);
    assert.equal(fields.progress, "Tien_do_pct");
    assert.equal(fields.plan, "Ke_hoach_tien_do");
  });

  it("reads percents from numbers and text", () => {
    assert.equal(parsePercent(45), 45);
    assert.equal(parsePercent("45,5 %"), 45.5);
    assert.equal(parsePercent("120"), 100);
    assert.equal(parsePercent(-3), 0);
    assert.equal(parsePercent(""), null);
    assert.equal(parsePercent("n/a"), null);
  });

  it("reads a year from numbers, years and dates", () => {
    assert.equal(parseYear(2024), 2024);
    assert.equal(parseYear("2024"), 2024);
    assert.equal(parseYear("01/03/2024"), 2024);
    assert.equal(parseYear("2021-05-01"), 2021);
    assert.equal(parseYear("Km 12"), null);
    assert.equal(parseYear(12), null);
  });

  it("suggests a setup until one is saved, then keeps the saved one", () => {
    const layer = routes();
    assert.equal(readLayerConfig(layer).included, true);
    const patch = layerConfigPatch(layer, { ...readLayerConfig(layer), included: false, type: "" });
    const saved = { ...layer, ...patch } as GeoLibreLayer;
    assert.ok(saved.metadata?.[NETWORK_METADATA_KEY]);
    assert.deepEqual(readLayerConfig(saved), {
      included: false,
      name: "Ten_du_an",
      status: "Trang_thai",
      type: "",
      year: "Nam_KC",
      progress: "",
      plan: "",
    });
    assert.deepEqual(collectSegments([saved]), []);
  });

  it("suggests a field an older saved setup does not mention", () => {
    const layer = routes();
    layer.geojson!.features[0].properties!.Tien_do = 60;
    const older = {
      ...layer,
      metadata: {
        [NETWORK_METADATA_KEY]: {
          included: true,
          name: "Ten_du_an",
          status: "",
          type: "",
          year: "",
        },
      },
    } as GeoLibreLayer;
    const config = readLayerConfig(older);
    assert.equal(config.status, "", "a field saved as unset stays unset");
    assert.equal(config.progress, "Tien_do", "a field added later is suggested");
  });
});

describe("road network dashboard: figures", () => {
  const layer = routes();
  const segments = collectSegments([layer]);

  it("collects the lines with their attributes", () => {
    assert.equal(segments.length, 3, "the point is left out");
    assert.deepEqual(
      segments.map((s) => [s.index, s.name, s.status, s.type, s.year]),
      [
        [0, "Cao tốc A", "Đang thi công", "Cao tốc", 2023],
        [1, "QL 14", "Hoàn thành", "Quốc lộ", 2021],
        [2, "Cầu B", "Chuẩn bị đầu tư", "Cầu", null],
      ],
    );
  });

  it("gives known statuses meaningful colours", () => {
    const colors = categoryColors("status", [
      "Đang thi công",
      "Hoàn thành",
      "Chuẩn bị đầu tư",
      "Tạm dừng",
      "",
    ]);
    assert.equal(colors.get("Đang thi công"), "#dc2626");
    assert.equal(colors.get("Hoàn thành"), "#16a34a");
    assert.equal(colors.get("Chuẩn bị đầu tư"), "#f59e0b");
    assert.equal(colors.get("Tạm dừng"), "#6b7280");
    assert.equal(colors.get(""), UNCLASSIFIED_COLOR);
  });

  it("greys out a value that says there is no report yet, in both modes", () => {
    for (const mode of ["status", "type"] as const) {
      const colors = categoryColors(mode, [
        "Gói XL01",
        "Chưa có báo cáo",
        "Chưa có dữ liệu",
        "No data",
      ]);
      for (const value of ["Chưa có báo cáo", "Chưa có dữ liệu", "No data"]) {
        assert.equal(colors.get(value), UNCLASSIFIED_COLOR, `${mode}: ${value}`);
      }
      // A real category keeps a palette colour, and the grey ones do not use up a slot.
      assert.notEqual(colors.get("Gói XL01"), UNCLASSIFIED_COLOR);
    }
    assert.equal(
      categoryColors("type", ["Chưa có báo cáo", "Gói XL05"]).get("Gói XL05"),
      categoryColors("type", ["Gói XL05"]).get("Gói XL05"),
    );
  });

  it("sums the legend's kilometres by category", () => {
    const values = fieldValues(segments, "type");
    assert.equal(values.length, 3);
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value.km, 0) - 3 * 111.19) < 0.3);
    assert.ok(values.every((value) => value.count === 1));
  });
});

describe("road network dashboard: map view", () => {
  const layer = routes();
  const config = readLayerConfig(layer);
  const segments = collectSegments([layer]);

  it("shows all included lines, by original feature index", () => {
    const shown = shownIndexes(segments);
    assert.deepEqual(shown.get("routes"), [0, 1, 2]);
    const view = layerView(config, "status", new Map(), shown.get("routes") ?? []);
    assert.deepEqual(view.filter, [
      "match",
      ["get", "__geolibre_progress_index"],
      [0, 1, 2],
      true,
      false,
    ]);
    assert.deepEqual(layerView(config, "status", new Map(), []).filter, ["literal", false]);
  });

  it("colours by the chosen field and scales the width with zoom", () => {
    const colors = categoryColors("status", ["Đang thi công", ""]);
    const view = layerView(config, "status", colors, [0]);
    assert.deepEqual(JSON.parse(view.colorExpression), [
      "match",
      ["to-string", ["coalesce", ["get", "Trang_thai"], ""]],
      "Đang thi công",
      "#dc2626",
      UNCLASSIFIED_COLOR,
    ]);
    assert.equal(view.lineWidth, NETWORK_LINE_WIDTH);
    const noField = layerView({ ...config, type: "" }, "type", new Map(), [0]);
    assert.deepEqual(JSON.parse(noField.colorExpression), ["to-color", UNCLASSIFIED_COLOR]);
  });
});

describe("dashboard line width reaches the renderer only", () => {
  it("replaces the line width on the renderer copy and never on the stored layer", () => {
    const layer = routes();
    const viewed = {
      ...layer,
      progressDashboard: layerView(readLayerConfig(layer), "status", new Map(), [0]),
    } as GeoLibreLayer;

    const rendered = progressDashboardLayer(viewed);

    assert.equal(lineWidthValue(rendered.style), NETWORK_LINE_WIDTH);
    assert.equal(viewed.style.dashboardLineWidth, undefined);
    assert.equal(typeof lineWidthValue(viewed.style), "number");
    const project = { ...createEmptyProject("Network"), layers: [viewed] };
    const saved = serializeProject(project);
    assert.doesNotMatch(saved, /dashboardLineWidth|progressDashboard/);
  });
});

describe("construction progress flag", () => {
  it("is hidden unless the deployment turns it on", () => {
    assert.equal(
      constructionProgressEnabled(() => undefined),
      false,
    );
    assert.equal(
      constructionProgressEnabled(() => "0"),
      false,
    );
    assert.equal(
      constructionProgressEnabled(() => "1"),
      true,
    );
  });
});
