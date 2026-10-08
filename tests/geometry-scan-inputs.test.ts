import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geometryScanInputs } from "../apps/geolibre-desktop/src/components/panels/style-panel/layer-capabilities";

describe("geometry scan inputs", () => {
  it("keeps the same inputs when only the style object is replaced", () => {
    const geojson = { type: "FeatureCollection", features: [] };
    const beforeLayer = { type: "geojson", geojson, style: { fillColor: "#111111" } };
    const afterLayer = { type: "geojson", geojson, style: { fillColor: "#222222" } };
    const before = geometryScanInputs(beforeLayer);
    const after = geometryScanInputs(afterLayer);
    assert.equal(before[0], after[0]);
    assert.equal(before[1], after[1]);
  });

  it("changes when the feature collection is replaced", () => {
    const first = { type: "FeatureCollection", features: [] };
    const second = { type: "FeatureCollection", features: [] };
    const before = geometryScanInputs({ type: "geojson", geojson: first });
    const after = geometryScanInputs({ type: "geojson", geojson: second });
    assert.notEqual(before[1], after[1]);
  });

  it("is empty when no layer is selected", () => {
    assert.deepEqual(geometryScanInputs(undefined), [undefined, undefined]);
  });
});
