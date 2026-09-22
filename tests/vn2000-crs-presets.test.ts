import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMMON_CRS_PRESETS,
  VN2000_CRS_PRESETS,
} from "../apps/geolibre-desktop/src/components/layout/add-data/constants.ts";

/**
 * Central meridian of each VN-2000 TM-3 code, in degrees east, read from PROJ
 * (`projinfo -o PROJ EPSG:<code>` → `+lon_0`).
 *
 * Duplicated here on purpose: the labels are what a surveyor picks by, and a
 * label that disagrees with the code sends a drawing a few hundred metres off
 * without any error. Pinning the pairing makes that a test failure instead.
 */
const CENTRAL_MERIDIAN: Record<string, number> = {
  "EPSG:5896": 102,
  "EPSG:9205": 103,
  "EPSG:9206": 104,
  "EPSG:9207": 104.5,
  "EPSG:9208": 104.75,
  "EPSG:5897": 105,
  "EPSG:9209": 105.5,
  "EPSG:9210": 105.75,
  "EPSG:9211": 106,
  "EPSG:9212": 106.25,
  "EPSG:9213": 106.5,
  "EPSG:9214": 107,
  "EPSG:9215": 107.25,
  "EPSG:9216": 107.5,
  "EPSG:5899": 107.75,
  "EPSG:5898": 108,
  "EPSG:9217": 108.25,
  "EPSG:9218": 108.5,
};

/** Parse `107°45′` out of a label into decimal degrees. */
function meridianFromLabel(label: string): number | null {
  const match = /(\d+)°(\d+)′/.exec(label);
  if (!match) return null;
  return Number(match[1]) + Number(match[2]) / 60;
}

describe("VN2000_CRS_PRESETS", () => {
  it("labels every TM-3 zone with its real central meridian", () => {
    for (const preset of VN2000_CRS_PRESETS) {
      const expected = CENTRAL_MERIDIAN[preset.value];
      if (expected === undefined) continue; // UTM zones and the geographic CRS
      assert.equal(
        meridianFromLabel(preset.label),
        expected,
        `${preset.value} is labelled "${preset.label}"`,
      );
    }
  });

  it("covers every TM-3 zone exactly once", () => {
    const listed = VN2000_CRS_PRESETS.map((preset) => preset.value).filter(
      (value) => value in CENTRAL_MERIDIAN,
    );
    assert.equal(listed.length, Object.keys(CENTRAL_MERIDIAN).length);
    assert.equal(new Set(listed).size, listed.length);
  });

  it("orders the TM-3 zones west to east", () => {
    const meridians = VN2000_CRS_PRESETS.map((preset) => CENTRAL_MERIDIAN[preset.value]).filter(
      (value): value is number => value !== undefined,
    );
    assert.deepEqual(meridians, [...meridians].sort((a, b) => a - b));
  });

  it("uses well-formed EPSG codes", () => {
    for (const preset of VN2000_CRS_PRESETS) {
      assert.match(preset.value, /^EPSG:\d+$/);
      assert.ok(preset.label.includes(preset.value.replace("EPSG:", "")));
    }
  });
});

describe("COMMON_CRS_PRESETS", () => {
  it("offers the VN-2000 systems", () => {
    const values = new Set(COMMON_CRS_PRESETS.map((preset) => preset.value));
    for (const preset of VN2000_CRS_PRESETS) assert.ok(values.has(preset.value));
  });

  it("keeps the upstream entries ahead of them", () => {
    const first = COMMON_CRS_PRESETS.findIndex((preset) =>
      VN2000_CRS_PRESETS.some((vn) => vn.value === preset.value),
    );
    assert.ok(first > 0);
    assert.equal(COMMON_CRS_PRESETS[0].value, "EPSG:4326");
  });

  it("lists no code twice", () => {
    const values = COMMON_CRS_PRESETS.map((preset) => preset.value);
    assert.equal(new Set(values).size, values.length);
  });
});
