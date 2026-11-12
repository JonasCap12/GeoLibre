import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, type GeoLibreLayer } from "@geolibre/core";
import type { Feature, FeatureCollection } from "geojson";
import {
  PROGRESS_V2_COLORS,
  packageFeatureIndexes,
  progressFeatureTarget,
  progressV2LayerPatch,
  stateColors,
} from "../apps/geolibre-desktop/src/lib/progress-colors";
import {
  PROGRESS_V2_ITEM_KEYS,
  type ProgressV2,
} from "../apps/geolibre-desktop/src/lib/progress-v2";

const feature = (properties: Record<string, unknown>): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties,
});

function state(): ProgressV2 {
  return {
    version: 2,
    meta: { title: "", subtitle: "", reportDate: "2026-10-16" },
    packages: [
      { id: "p1", name: "P1", fromStation: 0, toStation: 1000 },
      { id: "p2", name: "P2", fromStation: 1000, toStation: 2000 },
    ],
    weights: Object.fromEntries(
      PROGRESS_V2_ITEM_KEYS.map((key) => [key, 1]),
    ) as ProgressV2["weights"],
    plan: { p1: {}, p2: {} },
    bridges: [
      {
        id: "b1",
        name: "B1",
        station: 500,
        yard: { beds: 1 },
        supports: [
          {
            id: "M1",
            kind: "mo",
            inc: true,
            coc: { t: 3, D: 1, L: 12 },
            piles: [0, 1, 2],
            be: 25,
            than: 100,
            xm: 0,
          },
        ],
        spans: [
          {
            id: "N1",
            L: 40,
            lien: "",
            bmc: 50,
            ht: 25,
            girders: [
              { t: "T", st: 0, dob: "", bed: 0 },
              { t: "T", st: 3, dob: "2026-10-01", bed: 1 },
              { t: "T", st: 5, dob: "2026-09-01", bed: 0 },
            ],
          },
        ],
      },
    ],
    road: {
      km: [
        {
          id: "Km0",
          from: 0,
          to: 1000,
          pct: { nen: 0, mat_trai: 20, mat_phai: 100, le: 0, dpc: 0, ranh: 0 },
        },
      ],
    },
    underpasses: [{ id: "HC1", station: 1500, pct: { tuong: 75, nap: 100 } }],
    history: [],
    notes: "",
  };
}

const features = [
  feature({ bridge_id: "b1", support_id: "M1", pile_index: 0 }),
  feature({ bridge_id: "b1", support_id: "M1", pile_index: 1 }),
  feature({ bridge_id: "b1", support_id: "M1", pile_index: 2 }),
  feature({ bridge_id: "b1", support_id: "M1", progress_item: "be" }),
  feature({ bridge_id: "b1", support_id: "M1", progress_item: "than" }),
  feature({ bridge_id: "b1", span_id: "N1", girder_index: 1 }),
  feature({ bridge_id: "b1", span_id: "N1", progress_item: "bmc" }),
  feature({ bridge_id: "b1", span_id: "N1", progress_item: "ht" }),
  feature({ bridge_id: "b1", progress_item: "approach" }),
  feature({ km_id: "Km0", progress_item: "mat_trai" }),
  feature({ km_id: "Km0", progress_item: "mat_phai" }),
  feature({ underpass_id: "HC1", progress_item: "ham_tuong" }),
  feature({ underpass_id: "HC1", progress_item: "ham_nap" }),
  feature({ unrelated: true }),
];

describe("stateColors", () => {
  it("maps piles, support percentages, six girder stages, spans, road and underpasses", () => {
    const colors = stateColors(features, state());
    assert.equal(colors.size, features.length - 1);
    assert.deepEqual(colors.get(0), { color: PROGRESS_V2_COLORS.empty, status: "empty" });
    assert.deepEqual(colors.get(1), { color: PROGRESS_V2_COLORS.wip, status: "wip" });
    assert.deepEqual(colors.get(2), { color: PROGRESS_V2_COLORS.done, status: "done" });
    assert.equal(colors.get(3)?.status, "wip");
    assert.equal(colors.get(4)?.status, "done");
    assert.deepEqual(colors.get(5), { color: PROGRESS_V2_COLORS.girder[3], status: "stage-3" });
    assert.equal(colors.get(6)?.status, "wip");
    assert.equal(colors.get(7)?.status, "wip");
    assert.equal(colors.get(8)?.status, "wip");
    assert.equal(colors.get(9)?.status, "wip");
    assert.equal(colors.get(10)?.status, "done");
    assert.equal(colors.get(11)?.status, "wip");
    assert.equal(colors.get(12)?.status, "done");
  });

  it("creates one layer patch with stored state, colors, and geometryEdited semantics", () => {
    const geojson: FeatureCollection = { type: "FeatureCollection", features };
    const layer = {
      id: "drawing",
      name: "drawing",
      type: "geojson",
      source: { type: "geojson" },
      visible: true,
      opacity: 1,
      geojson,
      style: { ...DEFAULT_LAYER_STYLE },
      metadata: { keep: true },
    } as GeoLibreLayer;
    const patch = progressV2LayerPatch(layer, state());
    assert.equal(patch.metadata?.keep, true);
    assert.equal(patch.metadata?.geometryEdited, true);
    assert.equal((patch.metadata?.constructionProgress as ProgressV2).version, 2);
    assert.equal(patch.style?.simpleStyleEnabled, true);
    assert.equal(patch.geojson?.features[1].properties?.fill, PROGRESS_V2_COLORS.wip);
    assert.equal(patch.geojson?.features[1].properties?.tiendo, "wip");
    assert.equal(patch.geojson?.features[0].properties?.tiendo, undefined);
    assert.equal(patch.geojson?.features.at(-1), features.at(-1));
  });
});

describe("feature targets and package extents", () => {
  it("resolves editor targets without map-package changes", () => {
    assert.deepEqual(progressFeatureTarget(features[0]), {
      kind: "support",
      bridgeId: "b1",
      id: "M1",
    });
    assert.deepEqual(progressFeatureTarget(features[5]), {
      kind: "span",
      bridgeId: "b1",
      id: "N1",
    });
    assert.deepEqual(progressFeatureTarget(features[9]), { kind: "km", id: "Km0" });
    assert.deepEqual(progressFeatureTarget(features[11]), { kind: "underpass", id: "HC1" });
    assert.equal(progressFeatureTarget(features.at(-1)!), null);
  });

  it("collects only features belonging to a selected package", () => {
    assert.deepEqual(packageFeatureIndexes(features, state(), "p1"), [...Array(11).keys()]);
    assert.deepEqual(packageFeatureIndexes(features, state(), "p2"), [11, 12]);
    assert.equal(packageFeatureIndexes(features, state(), null).length, features.length);
  });
});
