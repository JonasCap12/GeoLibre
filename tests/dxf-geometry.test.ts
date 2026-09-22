import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sampleArc,
  sampleBulge,
  sampleEllipse,
  sampleSpline,
  type Vec2,
} from "../apps/geolibre-desktop/src/lib/dxf-geometry.ts";

/** Tolerance for tessellated geometry compared against the exact curve. */
const EPS = 1e-6;

const distance = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const last = <T,>(items: T[]): T => items[items.length - 1];

describe("sampleArc", () => {
  it("starts and ends on the requested angles", () => {
    const points = sampleArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2);
    assert.ok(distance(points[0], { x: 10, y: 0 }) < EPS);
    assert.ok(distance(last(points), { x: 0, y: 10 }) < EPS);
  });

  it("keeps every sample on the circle", () => {
    const points = sampleArc({ x: 3, y: -7 }, 4.25, 1, 2.5);
    for (const point of points) {
      assert.ok(Math.abs(distance(point, { x: 3, y: -7 }) - 4.25) < EPS);
    }
  });

  it("sweeps clockwise for a negative sweep", () => {
    const points = sampleArc({ x: 0, y: 0 }, 1, 0, -Math.PI / 2);
    assert.ok(distance(last(points), { x: 0, y: -1 }) < EPS);
  });

  it("spends more segments on a longer sweep", () => {
    const short = sampleArc({ x: 0, y: 0 }, 1, 0, 0.05);
    const full = sampleArc({ x: 0, y: 0 }, 1, 0, Math.PI * 2);
    assert.ok(full.length > short.length);
  });
});

describe("sampleBulge", () => {
  // Sweep direction is not a matter of taste: these expectations were taken
  // from native GDAL's own DXF output for the same one-segment drawing, so the
  // browser path and the desktop path agree on which side an arc falls.
  it("treats bulge 1 as a semicircle below the chord", () => {
    const points = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, 1);
    const apex = points[Math.floor(points.length / 2)];
    assert.ok(distance(apex, { x: 5, y: -5 }) < EPS);
    for (const point of points) {
      assert.ok(Math.abs(distance(point, { x: 5, y: 0 }) - 5) < EPS);
    }
  });

  it("mirrors the arc for a negative bulge", () => {
    const points = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 0 }, -1);
    const apex = points[Math.floor(points.length / 2)];
    assert.ok(distance(apex, { x: 5, y: 5 }) < EPS);
  });

  it("puts a quarter-turn bulge on the right centre", () => {
    // tan(90°/4) bulges a 45° chord into a quarter circle about (0, 10) —
    // again matching GDAL, which places the centre left of the travel
    // direction for a positive bulge.
    const points = sampleBulge({ x: 0, y: 0 }, { x: 10, y: 10 }, Math.tan(Math.PI / 8));
    for (const point of points) {
      assert.ok(Math.abs(distance(point, { x: 0, y: 10 }) - 10) < EPS);
    }
  });

  it("degrades to a straight segment when the endpoints coincide", () => {
    const points = sampleBulge({ x: 4, y: 4 }, { x: 4, y: 4 }, 0.5);
    assert.equal(points.length, 2);
  });

  it("keeps both endpoints exactly", () => {
    const from = { x: -2, y: 3 };
    const to = { x: 6, y: 1 };
    const points = sampleBulge(from, to, 0.3);
    assert.ok(distance(points[0], from) < EPS);
    assert.ok(distance(last(points), to) < EPS);
  });
});

describe("sampleEllipse", () => {
  it("reaches the major and minor extents", () => {
    const points = sampleEllipse({ x: 0, y: 0 }, { x: 10, y: 0 }, 0.5, 0, Math.PI * 2);
    assert.ok(Math.abs(Math.max(...points.map((p) => p.x)) - 10) < EPS);
    assert.ok(Math.abs(Math.max(...points.map((p) => p.y)) - 5) < EPS);
  });

  it("takes its rotation from the major axis vector", () => {
    const points = sampleEllipse({ x: 0, y: 0 }, { x: 0, y: 10 }, 0.5, 0, Math.PI * 2);
    assert.ok(Math.abs(Math.max(...points.map((p) => p.y)) - 10) < EPS);
    assert.ok(Math.abs(Math.max(...points.map((p) => p.x)) - 5) < EPS);
  });

  it("normalises a sweep that wraps past zero", () => {
    const points = sampleEllipse({ x: 0, y: 0 }, { x: 1, y: 0 }, 1, Math.PI * 1.5, Math.PI * 0.5);
    assert.ok(points.length > 2);
    assert.ok(distance(points[0], { x: 0, y: -1 }) < EPS);
    assert.ok(distance(last(points), { x: 0, y: 1 }) < EPS);
  });

  it("offsets by the centre", () => {
    const points = sampleEllipse({ x: 100, y: 200 }, { x: 5, y: 0 }, 1, 0, Math.PI * 2);
    for (const point of points) {
      assert.ok(Math.abs(distance(point, { x: 100, y: 200 }) - 5) < EPS);
    }
  });
});

describe("sampleSpline", () => {
  const control: Vec2[] = [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
    { x: 2, y: 0 },
  ];

  it("interpolates the endpoints of a clamped spline", () => {
    const points = sampleSpline(1, [0, 0, 1, 2, 2], control);
    assert.ok(distance(points[0], { x: 0, y: 0 }) < EPS);
    assert.ok(distance(last(points), { x: 2, y: 0 }) < 1e-5);
  });

  it("stays inside the control hull", () => {
    const points = sampleSpline(2, [0, 0, 0, 1, 1, 1], control);
    for (const point of points) {
      assert.ok(point.y >= -EPS && point.y <= 1 + EPS);
      assert.ok(point.x >= -EPS && point.x <= 2 + EPS);
    }
  });

  // Third-party exporters emit splines whose knot count disagrees with the
  // degree. Dropping the entity would silently lose linework, so the control
  // polygon stands in.
  it("falls back to the control polygon on an inconsistent knot vector", () => {
    const points = sampleSpline(3, [0, 1], control);
    assert.deepEqual(points, control);
  });

  it("falls back when there are too few control points for the degree", () => {
    const points = sampleSpline(3, undefined, control);
    assert.deepEqual(points, control);
  });
});
