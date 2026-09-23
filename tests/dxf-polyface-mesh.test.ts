import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_LAYERS, parseDxfDrawing } from "../apps/geolibre-desktop/src/lib/dxf-loader.ts";

/**
 * A polyface-mesh POLYLINE mixes two kinds of VERTEX in one list: vertices that
 * carry coordinates, and *face records* that carry none. A face record's
 * `faceA`..`faceD` (group codes 71-74) are 1-based indices into the coordinate
 * vertices, negative only to mark an edge invisible. Its own position fields
 * are absent, which parsers report as `x = y = z = 0`.
 *
 * Reading the list as a path therefore draws a line from the drawing out to the
 * coordinate origin and back, once per face. On a VN-2000 survey that origin
 * reprojects to roughly the latitude of Singapore, so a Lâm Đồng alignment
 * arrived on the map with a spike across the South China Sea.
 */

function dxf(...pairs: [number | string, string | number][]): Uint8Array {
  const lines = pairs.flatMap(([code, value]) => [String(code), String(value)]);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

const HEADER: [number | string, string | number][] = [
  [0, "SECTION"],
  [2, "HEADER"],
  [9, "$ACADVER"],
  [1, "AC1021"],
  [0, "ENDSEC"],
];
const ENTITIES_START: [number | string, string | number][] = [
  [0, "SECTION"],
  [2, "ENTITIES"],
];
const END: [number | string, string | number][] = [
  [0, "ENDSEC"],
  [0, "EOF"],
];

/** A coordinate-bearing mesh vertex (flags 128 + 64). */
function meshVertex(x: number, y: number): [number | string, string | number][] {
  return [
    [0, "VERTEX"],
    [8, "surface"],
    [10, x],
    [20, y],
    [30, 0],
    [70, 192],
  ];
}

/** A face record (flag 128) naming 1-based corner indices; no coordinates. */
function faceRecord(...corners: number[]): [number | string, string | number][] {
  const codes: [number | string, string | number][] = [
    [0, "VERTEX"],
    [8, "surface"],
    [10, 0],
    [20, 0],
    [30, 0],
    [70, 128],
  ];
  corners.forEach((corner, index) => codes.push([71 + index, corner]));
  return codes;
}

/** A polyface mesh: a unit square split into two triangles. */
const MESH: [number | string, string | number][] = [
  [0, "POLYLINE"],
  [8, "surface"],
  [66, 1],
  [70, 64],
  ...meshVertex(100, 200),
  ...meshVertex(110, 200),
  ...meshVertex(110, 210),
  ...meshVertex(100, 210),
  ...faceRecord(1, 2, 3),
  // A negative index marks that edge invisible; it is still corner 1.
  ...faceRecord(1, 3, -4),
  [0, "SEQEND"],
];

describe("polyface mesh", () => {
  it("never emits a vertex at the coordinate origin", async () => {
    // The regression itself. Every corner of the fixture sits near (100, 200);
    // a (0, 0) anywhere means face records were read as positions again.
    const drawing = await parseDxfDrawing(dxf(...HEADER, ...ENTITIES_START, ...MESH, ...END));
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    const coordinates = JSON.stringify(fc);
    assert.ok(
      !/\[0,0\]/.test(coordinates.replace(/\s/g, "")),
      `a face record leaked into the geometry: ${coordinates.slice(0, 400)}`,
    );
  });

  it("builds one polygon per face", async () => {
    const drawing = await parseDxfDrawing(dxf(...HEADER, ...ENTITIES_START, ...MESH, ...END));
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    assert.equal(fc.features.length, 1);
    const geometry = fc.features[0].geometry;
    assert.equal(geometry?.type, "MultiPolygon");
    const polygons = (geometry as { coordinates: number[][][][] }).coordinates;
    assert.equal(polygons.length, 2, "two faces in, two polygons out");
    for (const polygon of polygons) {
      const ring = polygon[0];
      // 3 corners + the repeated closing point.
      assert.equal(ring.length, 4);
      assert.deepEqual(ring[0], ring[ring.length - 1], "ring must close");
    }
  });

  it("resolves a negative corner index to the same vertex", async () => {
    const drawing = await parseDxfDrawing(dxf(...HEADER, ...ENTITIES_START, ...MESH, ...END));
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    const polygons = (fc.features[0].geometry as { coordinates: number[][][][] }).coordinates;
    // Second face is (1, 3, -4): corners 1, 3 and 4 of the square.
    assert.deepEqual(polygons[1][0].slice(0, 3), [
      [100, 200],
      [110, 210],
      [100, 210],
    ]);
  });

  it("leaves an ordinary polyline alone", async () => {
    // Guard against the new branch swallowing every POLYLINE: without face
    // records this must still be the LineString it always was.
    const plain: [number | string, string | number][] = [
      [0, "POLYLINE"],
      [8, "road"],
      [66, 1],
      [70, 0],
      ...meshVertex(0, 0),
      ...meshVertex(10, 5),
      [0, "SEQEND"],
    ];
    const drawing = await parseDxfDrawing(dxf(...HEADER, ...ENTITIES_START, ...plain, ...END));
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    assert.equal(fc.features[0].geometry?.type, "LineString");
  });
});
