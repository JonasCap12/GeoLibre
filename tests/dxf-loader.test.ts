import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_LAYERS, parseDxfDrawing } from "../apps/geolibre-desktop/src/lib/dxf-loader.ts";

/**
 * Build DXF bytes from flat group-code pairs.
 *
 * DXF is a line-oriented format: a group code on one line, its value on the
 * next. Writing fixtures as pairs keeps them readable and lets a test assert on
 * geometry rather than on parser plumbing.
 */
function dxf(...pairs: [number | string, string | number][]): Uint8Array {
  const lines = pairs.flatMap(([code, value]) => [String(code), String(value)]);
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

/** A HEADER declaring an R2007 drawing, whose strings are UTF-8. */
const UTF8_HEADER: [number | string, string | number][] = [
  [0, "SECTION"],
  [2, "HEADER"],
  [9, "$ACADVER"],
  [1, "AC1021"],
  [0, "ENDSEC"],
];

/** One LINE entity on `layer`, from (x1, y1) to (x2, y2). */
function line(
  layer: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number | string, string | number][] {
  return [
    [0, "LINE"],
    [8, layer],
    [10, x1],
    [20, y1],
    [11, x2],
    [21, y2],
  ];
}

const ENTITIES_START: [number | string, string | number][] = [
  [0, "SECTION"],
  [2, "ENTITIES"],
];
const SECTION_END: [number | string, string | number][] = [[0, "ENDSEC"]];
const FILE_END: [number | string, string | number][] = [[0, "EOF"]];

describe("parseDxfDrawing", () => {
  it("reads a line into a LineString in drawing coordinates", async () => {
    const drawing = await parseDxfDrawing(
      dxf(...UTF8_HEADER, ...ENTITIES_START, ...line("road", 0, 0, 10, 5), ...SECTION_END, ...FILE_END),
    );
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    assert.equal(fc.features.length, 1);
    assert.deepEqual(fc.features[0].geometry, {
      type: "LineString",
      coordinates: [
        [0, 0],
        [10, 5],
      ],
    });
    assert.equal(fc.features[0].properties?.Layer, "road");
  });

  it("lists layers busiest first with their counts", async () => {
    const drawing = await parseDxfDrawing(
      dxf(
        ...UTF8_HEADER,
        ...ENTITIES_START,
        ...line("quiet", 0, 0, 1, 1),
        ...line("busy", 0, 0, 1, 1),
        ...line("busy", 1, 1, 2, 2),
        ...SECTION_END,
        ...FILE_END,
      ),
    );
    assert.deepEqual(
      drawing.layers.map((layer) => [layer.name, layer.featureCount]),
      [
        ["busy", 2],
        ["quiet", 1],
      ],
    );
    assert.equal(drawing.featureCount, 3);
  });

  it("loads a single CAD layer without the rest", async () => {
    const drawing = await parseDxfDrawing(
      dxf(
        ...UTF8_HEADER,
        ...ENTITIES_START,
        ...line("keep", 0, 0, 1, 1),
        ...line("drop", 5, 5, 6, 6),
        ...SECTION_END,
        ...FILE_END,
      ),
    );
    const fc = drawing.toFeatureCollection("keep");
    assert.equal(fc.features.length, 1);
    assert.equal(fc.features[0].properties?.Layer, "keep");
  });

  it("recodes Vietnamese layer names from an R2007 drawing", async () => {
    // The drawing declares a legacy codepage while actually holding UTF-8, the
    // combination AutoCAD writes for R2007+ — and the one native GDAL gets
    // wrong on real files.
    const bytes = dxf(
      [0, "SECTION"],
      [2, "HEADER"],
      [9, "$ACADVER"],
      [1, "AC1021"],
      [9, "$DWGCODEPAGE"],
      [3, "ANSI_1252"],
      [0, "ENDSEC"],
      ...ENTITIES_START,
      ...line("Tim tuyến", 0, 0, 1, 1),
      ...SECTION_END,
      ...FILE_END,
    );
    const drawing = await parseDxfDrawing(bytes);
    assert.equal(drawing.layers[0].name, "Tim tuyến");
  });

  it("keeps TEXT content as a point attribute", async () => {
    const drawing = await parseDxfDrawing(
      dxf(
        ...UTF8_HEADER,
        ...ENTITIES_START,
        [0, "TEXT"],
        [8, "labels"],
        [10, 3],
        [20, 4],
        [40, 2],
        [1, "KM 12+500"],
        ...SECTION_END,
        ...FILE_END,
      ),
    );
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    assert.equal(fc.features[0].geometry.type, "Point");
    assert.equal(fc.features[0].properties?.Text, "KM 12+500");
  });
});

describe("parseDxfDrawing block handling", () => {
  /** A drawing whose block `sym` holds one line, inserted by `inserts`. */
  function withBlock(
    blockEntities: [number | string, string | number][],
    inserts: [number | string, string | number][],
    basePoint: [number, number] = [0, 0],
  ): Uint8Array {
    return dxf(
      ...UTF8_HEADER,
      [0, "SECTION"],
      [2, "BLOCKS"],
      [0, "BLOCK"],
      [2, "sym"],
      [8, "0"],
      [10, basePoint[0]],
      [20, basePoint[1]],
      ...blockEntities,
      [0, "ENDBLK"],
      [0, "ENDSEC"],
      ...ENTITIES_START,
      ...inserts,
      ...SECTION_END,
      ...FILE_END,
    );
  }

  it("places block geometry at the insertion point", async () => {
    const drawing = await parseDxfDrawing(
      withBlock(line("0", 0, 0, 1, 0), [
        [0, "INSERT"],
        [2, "sym"],
        [8, "signs"],
        [10, 100],
        [20, 200],
      ]),
    );
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    assert.equal(fc.features.length, 1);
    assert.deepEqual(fc.features[0].geometry, {
      type: "LineString",
      coordinates: [
        [100, 200],
        [101, 200],
      ],
    });
  });

  // AutoCAD's rule: geometry drawn on layer "0" inside a block takes the layer
  // of the reference that places it, so one symbol serves many layers.
  it("inherits the insert's layer for block contents on layer 0", async () => {
    const drawing = await parseDxfDrawing(
      withBlock(line("0", 0, 0, 1, 0), [
        [0, "INSERT"],
        [2, "sym"],
        [8, "signs"],
        [10, 0],
        [20, 0],
      ]),
    );
    assert.equal(drawing.toFeatureCollection(ALL_LAYERS).features[0].properties?.Layer, "signs");
    assert.equal(drawing.toFeatureCollection("signs").features.length, 1);
  });

  it("leaves a block entity's own layer alone", async () => {
    const drawing = await parseDxfDrawing(
      withBlock(line("guardrail", 0, 0, 1, 0), [
        [0, "INSERT"],
        [2, "sym"],
        [8, "signs"],
        [10, 0],
        [20, 0],
      ]),
    );
    assert.equal(
      drawing.toFeatureCollection(ALL_LAYERS).features[0].properties?.Layer,
      "guardrail",
    );
  });

  it("applies rotation and scale about the block base point", async () => {
    const drawing = await parseDxfDrawing(
      withBlock(
        line("0", 1, 0, 2, 0),
        [
          [0, "INSERT"],
          [2, "sym"],
          [8, "signs"],
          [10, 0],
          [20, 0],
          [41, 2],
          [42, 2],
          [50, 90],
        ],
        [1, 0],
      ),
    );
    const coordinates = (
      drawing.toFeatureCollection(ALL_LAYERS).features[0].geometry as {
        coordinates: number[][];
      }
    ).coordinates;
    // The base point (1, 0) becomes the origin, so the line runs 0→1 locally;
    // doubled and turned a quarter turn it runs from (0, 0) up to (0, 2).
    assert.ok(Math.abs(coordinates[0][0]) < 1e-9 && Math.abs(coordinates[0][1]) < 1e-9);
    assert.ok(Math.abs(coordinates[1][0]) < 1e-9 && Math.abs(coordinates[1][1] - 2) < 1e-9);
  });

  it("emits one feature per block entity rather than merging them", async () => {
    const drawing = await parseDxfDrawing(
      withBlock([...line("0", 0, 0, 1, 0), ...line("0", 0, 1, 1, 1)], [
        [0, "INSERT"],
        [2, "sym"],
        [8, "signs"],
        [10, 0],
        [20, 0],
      ]),
    );
    const fc = drawing.toFeatureCollection(ALL_LAYERS);
    // Native GDAL collapses a block reference into one multi-part feature,
    // which is what produces GeometryCollections the renderer cannot decode.
    assert.equal(fc.features.length, 2);
    for (const feature of fc.features) assert.equal(feature.geometry.type, "LineString");
  });

  it("does not hang on a block that inserts itself", async () => {
    const drawing = await parseDxfDrawing(
      withBlock(
        [
          ...line("0", 0, 0, 1, 0),
          [0, "INSERT"],
          [2, "sym"],
          [8, "0"],
          [10, 1],
          [20, 1],
        ],
        [
          [0, "INSERT"],
          [2, "sym"],
          [8, "signs"],
          [10, 0],
          [20, 0],
        ],
      ),
    );
    assert.ok(drawing.featureCount >= 1);
    assert.ok(Number.isFinite(drawing.featureCount));
  });

  it("ignores an insert naming a block that is not defined", async () => {
    const drawing = await parseDxfDrawing(
      dxf(
        ...UTF8_HEADER,
        ...ENTITIES_START,
        [0, "INSERT"],
        [2, "missing"],
        [8, "signs"],
        [10, 0],
        [20, 0],
        ...line("road", 0, 0, 1, 1),
        ...SECTION_END,
        ...FILE_END,
      ),
    );
    assert.equal(drawing.featureCount, 1);
    assert.equal(drawing.layers[0].name, "road");
  });
});
