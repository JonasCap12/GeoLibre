import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LineString, MultiLineString, Polygon } from "geojson";
import { splitGeometryByArea } from "../packages/processing/src/split-by-area";

/** The square [0,10] × [0,10]. */
const AREA: Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe("splitGeometryByArea", () => {
  it("cuts a line where it crosses the area's edge", () => {
    const line: LineString = {
      type: "LineString",
      coordinates: [
        [-5, 5],
        [15, 5],
      ],
    };
    const { inside, outside } = splitGeometryByArea(line, AREA);
    assert.deepEqual(inside, {
      type: "LineString",
      coordinates: [
        [0, 5],
        [10, 5],
      ],
    });
    assert.deepEqual(outside, {
      type: "MultiLineString",
      coordinates: [
        [
          [-5, 5],
          [0, 5],
        ],
        [
          [10, 5],
          [15, 5],
        ],
      ],
    });
  });

  it("keeps a polyline's vertices inside the area in the inside run", () => {
    const line: LineString = {
      type: "LineString",
      coordinates: [
        [-5, 2],
        [5, 2],
        [5, 8],
        [15, 8],
      ],
    };
    const inside = splitGeometryByArea(line, AREA).inside as LineString;
    assert.deepEqual(inside.coordinates, [
      [0, 2],
      [5, 2],
      [5, 8],
      [10, 8],
    ]);
  });

  it("returns the original line when it is wholly inside or wholly outside", () => {
    const within: LineString = {
      type: "LineString",
      coordinates: [
        [1, 1],
        [9, 9],
      ],
    };
    assert.deepEqual(splitGeometryByArea(within, AREA), { inside: within, outside: null });
    const away: LineString = {
      type: "LineString",
      coordinates: [
        [20, 20],
        [30, 30],
      ],
    };
    assert.deepEqual(splitGeometryByArea(away, AREA), { inside: null, outside: away });
  });

  it("splits each part of a multi-line on its own", () => {
    const multi: MultiLineString = {
      type: "MultiLineString",
      coordinates: [
        [
          [-5, 5],
          [5, 5],
        ],
        [
          [20, 5],
          [30, 5],
        ],
      ],
    };
    const { inside, outside } = splitGeometryByArea(multi, AREA);
    assert.deepEqual((inside as LineString).coordinates, [
      [0, 5],
      [5, 5],
    ]);
    assert.equal((outside as MultiLineString).coordinates.length, 2);
  });

  it("clips a polygon into the parts inside and outside", () => {
    const square: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [5, 2],
          [15, 2],
          [15, 8],
          [5, 8],
          [5, 2],
        ],
      ],
    };
    const { inside, outside } = splitGeometryByArea(square, AREA);
    assert.equal(inside?.type, "Polygon");
    assert.equal(outside?.type, "Polygon");
    const xs = (geometry: typeof inside) => (geometry as Polygon).coordinates[0].map(([x]) => x);
    assert.ok(xs(inside).every((x) => x >= 5 && x <= 10));
    assert.ok(xs(outside).every((x) => x >= 10 && x <= 15));
  });

  it("sorts points by containment", () => {
    assert.equal(splitGeometryByArea({ type: "Point", coordinates: [5, 5] }, AREA).outside, null);
    assert.equal(splitGeometryByArea({ type: "Point", coordinates: [50, 5] }, AREA).inside, null);
    const { inside, outside } = splitGeometryByArea(
      {
        type: "MultiPoint",
        coordinates: [
          [5, 5],
          [50, 5],
        ],
      },
      AREA,
    );
    assert.deepEqual(inside, { type: "MultiPoint", coordinates: [[5, 5]] });
    assert.deepEqual(outside, { type: "MultiPoint", coordinates: [[50, 5]] });
  });

  it("leaves a geometry collection whole", () => {
    const collection = {
      type: "GeometryCollection" as const,
      geometries: [{ type: "Point" as const, coordinates: [5, 5] }],
    };
    assert.deepEqual(splitGeometryByArea(collection, AREA), {
      inside: null,
      outside: collection,
    });
  });
});
