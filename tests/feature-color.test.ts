import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, vectorLineColorValue, type GeoLibreLayer } from "@geolibre/core";
import type { FeatureCollection } from "geojson";
import {
  FEATURE_COLOR_KEYS,
  FEATURE_COLOR_PRESETS,
  featureColorPatch,
} from "../apps/geolibre-desktop/src/lib/feature-color";

function makeLayer(patch: Partial<GeoLibreLayer> = {}): GeoLibreLayer {
  const geojson: FeatureCollection = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 0],
            [1, 0],
          ],
        },
        properties: { Layer: "TIM", EntityHandle: "1A" },
      },
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: [
            [1, 0],
            [2, 0],
          ],
        },
        properties: { Layer: "TIM", EntityHandle: "1B" },
      },
      {
        type: "Feature",
        id: "edge",
        geometry: {
          type: "LineString",
          coordinates: [
            [0, 1],
            [2, 1],
          ],
        },
        properties: { Layer: "MEP" },
      },
    ],
  };
  return {
    id: "drawing",
    name: "Drawing",
    type: "geojson",
    source: { type: "geojson" },
    visible: true,
    opacity: 1,
    style: { ...DEFAULT_LAYER_STYLE },
    metadata: {},
    geojson,
    ...patch,
  };
}

describe("featureColorPatch", () => {
  it("paints only the selected features, by selection id", () => {
    // Index ids for features without one, the feature's own id otherwise.
    const patch = featureColorPatch(makeLayer(), new Set(["1", "edge"]), "#16a34a");
    const features = patch?.geojson?.features ?? [];
    assert.equal(features[0].properties?.stroke, undefined);
    for (const index of [1, 2]) {
      for (const key of FEATURE_COLOR_KEYS) {
        assert.equal(features[index].properties?.[key], "#16a34a");
      }
    }
    // The drawing's own attributes survive the paint.
    assert.equal(features[1].properties?.EntityHandle, "1B");
  });

  it("switches simplestyle on so the paint overrides the layer style", () => {
    const layer = makeLayer();
    const patch = featureColorPatch(layer, new Set(["0"]), "#dc2626");
    assert.equal(patch?.style?.simpleStyleEnabled, true);
    // The rest of the style is carried over, not reset.
    assert.equal(patch?.style?.strokeColor, layer.style.strokeColor);
    assert.deepEqual(vectorLineColorValue(patch!.style!), [
      "coalesce",
      ["get", "stroke"],
      vectorLineColorValue(layer.style),
    ]);
  });

  it("leaves the style alone when simplestyle is already on", () => {
    const layer = makeLayer({ style: { ...DEFAULT_LAYER_STYLE, simpleStyleEnabled: true } });
    const patch = featureColorPatch(layer, new Set(["0"]), "#dc2626");
    assert.ok(patch?.geojson);
    assert.equal(patch.style, undefined);
  });

  it("repaints a feature with a later color", () => {
    const first = makeLayer();
    const painted = { ...first, ...featureColorPatch(first, new Set(["0"]), "#f97316") };
    const patch = featureColorPatch(painted, new Set(["0"]), "#16a34a");
    assert.equal(patch?.geojson?.features[0].properties?.stroke, "#16a34a");
  });

  it("strips the paint when the color is null", () => {
    const first = makeLayer();
    const painted = { ...first, ...featureColorPatch(first, new Set(["0", "1"]), "#f97316") };
    const patch = featureColorPatch(painted, new Set(["0"]), null);
    const features = patch?.geojson?.features ?? [];
    for (const key of FEATURE_COLOR_KEYS) {
      assert.equal(key in (features[0].properties ?? {}), false);
    }
    assert.equal(features[0].properties?.Layer, "TIM");
    assert.equal(features[1].properties?.stroke, "#f97316");
    // Other features still carry paint, so the flag stays on.
    assert.equal(patch?.style, undefined);
  });

  it("marks the layer edited so a save keeps the painted features", () => {
    const layer = makeLayer({ metadata: { sharedDatasetId: "dataset-1" } });
    for (const color of ["#16a34a", null]) {
      const patch = featureColorPatch(layer, new Set(["0"]), color);
      assert.equal(patch?.metadata?.geometryEdited, true);
      // The rest of the metadata is carried over, not replaced.
      assert.equal(patch?.metadata?.sharedDatasetId, "dataset-1");
    }
  });

  it("stamps the edit on a layer with editor tracking", () => {
    const layer = makeLayer({ editorTracking: { enabled: true } });
    const patch = featureColorPatch(layer, new Set(["0"]), "#2563eb");
    const properties = patch?.geojson?.features[0].properties ?? {};
    assert.equal(typeof properties.edited_at, "string");
    assert.equal(patch?.geojson?.features[1].properties?.edited_at, undefined);
  });

  it("is a no-op without features or a matching id", () => {
    assert.equal(featureColorPatch(makeLayer(), new Set(), "#2563eb"), null);
    assert.equal(featureColorPatch(makeLayer(), new Set(["99"]), "#2563eb"), null);
    assert.equal(
      featureColorPatch(makeLayer({ geojson: undefined }), new Set(["0"]), "#2563eb"),
      null,
    );
  });

  it("offers only colors the renderer accepts", () => {
    for (const { color } of FEATURE_COLOR_PRESETS) {
      assert.match(color, /^#[0-9a-f]{6}$/);
    }
  });
});
