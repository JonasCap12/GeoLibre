import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LAYER_STYLE, extrusionBaseValue, type LayerStyle } from "@geolibre/core";
import { fillExtrusionPaint } from "../packages/map/src/style-mapper";

const style = (patch: Partial<LayerStyle>): LayerStyle => ({ ...DEFAULT_LAYER_STYLE, ...patch });

describe("extrusionBaseValue", () => {
  it("uses the flat base by default", () => {
    assert.equal(DEFAULT_LAYER_STYLE.extrusionBaseExpression, "");
    assert.equal(extrusionBaseValue(style({ extrusionBase: 4 })), 4);
  });

  it("takes a per-feature expression in advanced mode", () => {
    const value = extrusionBaseValue(
      style({
        extrusionBase: 4,
        extrusionAdvancedStyleEnabled: true,
        extrusionBaseExpression: '["get", "base"]',
      }),
    );
    assert.deepEqual(value, ["get", "base"]);
  });

  it("ignores the expression outside advanced mode, and an invalid one", () => {
    assert.equal(
      extrusionBaseValue(style({ extrusionBase: 2, extrusionBaseExpression: '["get", "base"]' })),
      2,
    );
    assert.equal(
      extrusionBaseValue(
        style({
          extrusionBase: 3,
          extrusionAdvancedStyleEnabled: true,
          extrusionBaseExpression: "not json",
        }),
      ),
      3,
    );
  });

  it("reaches the MapLibre fill-extrusion paint", () => {
    const paint = fillExtrusionPaint(
      style({
        extrusionAdvancedStyleEnabled: true,
        extrusionHeightExpression: '["get", "h"]',
        extrusionBaseExpression: '["get", "base"]',
      }),
      1,
    );
    assert.deepEqual(paint["fill-extrusion-base"], ["get", "base"]);
    assert.deepEqual(paint["fill-extrusion-height"], ["get", "h"]);
    assert.equal(fillExtrusionPaint(style({ extrusionBase: 5 }), 1)["fill-extrusion-base"], 5);
  });
});
