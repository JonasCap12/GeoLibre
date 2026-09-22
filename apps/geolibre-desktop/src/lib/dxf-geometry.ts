/**
 * Curve tessellation for DXF entities, kept apart from the parser so the maths
 * can be unit-tested without loading `dxf-parser` or a 45 MB fixture.
 *
 * DXF stores curves analytically (an ARC is a centre, a radius and two angles);
 * GeoJSON has only straight segments, so every curve is sampled here. Sampling
 * is adaptive — the segment count follows the swept angle rather than being
 * fixed — so a 5° fillet does not cost the same 64 points as a full circle.
 */

/** A planar point. DXF elevations are dropped: the map renders in 2D. */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Segments used for a full 360° sweep. Everything else is pro-rated from this,
 * floored at {@link MIN_ARC_SEGMENTS}. 64 keeps a circle's sagitta under 0.1%
 * of its radius, which is well inside a pixel at any sane map scale.
 */
const FULL_CIRCLE_SEGMENTS = 64;
/** Even a hairline arc gets this many, so it never degenerates to a chord. */
const MIN_ARC_SEGMENTS = 4;
/** Samples per spline span. Splines are rare in survey drawings; be generous. */
const SPLINE_SAMPLES_PER_SPAN = 16;

/** Segment count for a sweep of `radians`, adaptive but bounded. */
function segmentsForSweep(radians: number): number {
  const fraction = Math.abs(radians) / (Math.PI * 2);
  return Math.max(MIN_ARC_SEGMENTS, Math.ceil(fraction * FULL_CIRCLE_SEGMENTS));
}

/**
 * Sample a circular arc counter-clockwise from `startAngle` by `sweep`.
 *
 * @param centre Arc centre.
 * @param radius Arc radius in drawing units.
 * @param startAngle Start angle in radians, measured from +X.
 * @param sweep Signed swept angle in radians; negative sweeps clockwise.
 * @returns Points along the arc, both endpoints included.
 */
export function sampleArc(
  centre: Vec2,
  radius: number,
  startAngle: number,
  sweep: number,
): Vec2[] {
  const steps = segmentsForSweep(sweep);
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const angle = startAngle + (sweep * i) / steps;
    points.push({
      x: centre.x + radius * Math.cos(angle),
      y: centre.y + radius * Math.sin(angle),
    });
  }
  return points;
}

/**
 * Sample an ellipse, which DXF stores as a centre plus a *major axis vector*
 * and a minor/major ratio — so the rotation is implicit in the vector and must
 * not be applied twice.
 *
 * @param centre Ellipse centre.
 * @param majorAxis Vector from the centre to the major axis endpoint.
 * @param axisRatio Minor axis length as a fraction of the major.
 * @param startAngle Start parameter in radians (not a geometric angle).
 * @param endAngle End parameter in radians.
 * @returns Points along the elliptical arc.
 */
export function sampleEllipse(
  centre: Vec2,
  majorAxis: Vec2,
  axisRatio: number,
  startAngle: number,
  endAngle: number,
): Vec2[] {
  const major = Math.hypot(majorAxis.x, majorAxis.y);
  const minor = major * axisRatio;
  const tilt = Math.atan2(majorAxis.y, majorAxis.x);
  const cos = Math.cos(tilt);
  const sin = Math.sin(tilt);

  // A closed ellipse arrives as 0 → 2π; anything else is a partial sweep that
  // may wrap past 2π, so normalise into a single positive turn.
  let sweep = endAngle - startAngle;
  if (sweep <= 0) sweep += Math.PI * 2;

  const steps = segmentsForSweep(sweep);
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = startAngle + (sweep * i) / steps;
    const ex = major * Math.cos(t);
    const ey = minor * Math.sin(t);
    points.push({
      x: centre.x + ex * cos - ey * sin,
      y: centre.y + ex * sin + ey * cos,
    });
  }
  return points;
}

/**
 * Expand one bulged polyline segment into an arc.
 *
 * A DXF "bulge" is `tan(θ/4)` for the included angle θ, signed
 * counter-clockwise — the compact way DXF curves a polyline edge. Zero means a
 * straight edge, which callers handle without calling here.
 *
 * @param from Segment start.
 * @param to Segment end.
 * @param bulge The DXF bulge value; must be non-zero.
 * @returns Points from `from` to `to` along the arc, both ends included.
 */
export function sampleBulge(from: Vec2, to: Vec2, bulge: number): Vec2[] {
  const theta = 4 * Math.atan(bulge);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const chord = Math.hypot(dx, dy);
  // Coincident endpoints carry no arc: a radius would divide by zero.
  if (chord === 0 || !Number.isFinite(theta) || Math.sin(theta / 2) === 0) {
    return [from, to];
  }

  const radius = chord / (2 * Math.sin(theta / 2));
  // Perpendicular to the chord, rotated +90°, so a positive bulge puts the
  // centre on the counter-clockwise side.
  const perpX = -dy / chord;
  const perpY = dx / chord;
  const offset = radius * Math.cos(theta / 2);
  const centre: Vec2 = {
    x: (from.x + to.x) / 2 + perpX * offset,
    y: (from.y + to.y) / 2 + perpY * offset,
  };

  const startAngle = Math.atan2(from.y - centre.y, from.x - centre.x);
  return sampleArc(centre, Math.abs(radius), startAngle, theta);
}

/**
 * Evaluate a B-spline at one parameter value with de Boor's algorithm.
 *
 * @param degree Spline degree.
 * @param knots The knot vector.
 * @param control Control points.
 * @param t Parameter inside the valid domain.
 * @returns The point on the curve.
 */
function deBoor(degree: number, knots: number[], control: Vec2[], t: number): Vec2 {
  // Locate the knot span containing t.
  let span = degree;
  while (span < control.length - 1 && knots[span + 1] <= t) span += 1;

  // Working copy of the d+1 control points that influence this span.
  const working: Vec2[] = [];
  for (let i = 0; i <= degree; i += 1) {
    const point = control[span - degree + i];
    working.push({ x: point.x, y: point.y });
  }

  for (let r = 1; r <= degree; r += 1) {
    for (let i = degree; i >= r; i -= 1) {
      const index = span - degree + i;
      const denominator = knots[index + degree - r + 1] - knots[index];
      const alpha = denominator === 0 ? 0 : (t - knots[index]) / denominator;
      working[i] = {
        x: working[i - 1].x * (1 - alpha) + working[i].x * alpha,
        y: working[i - 1].y * (1 - alpha) + working[i].y * alpha,
      };
    }
  }
  return working[degree];
}

/**
 * Sample a B-spline into a polyline.
 *
 * Falls back to the control polygon when the knot vector is missing or
 * inconsistent — a coarse shape beats dropping the entity, and malformed
 * splines are common in drawings exported by third-party CAD tools.
 *
 * @param degree Spline degree from the DXF.
 * @param knots The knot vector, or undefined.
 * @param control Control points.
 * @returns Points along the curve.
 */
export function sampleSpline(
  degree: number,
  knots: number[] | undefined,
  control: Vec2[],
): Vec2[] {
  const usable =
    degree >= 1 &&
    control.length > degree &&
    Array.isArray(knots) &&
    knots.length === control.length + degree + 1;
  if (!usable) return control;

  const knotVector = knots as number[];
  const start = knotVector[degree];
  const end = knotVector[control.length];
  if (!(end > start)) return control;

  const steps = Math.max(
    MIN_ARC_SEGMENTS,
    (control.length - degree) * SPLINE_SAMPLES_PER_SPAN,
  );
  const points: Vec2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    // Nudge the final sample inside the domain: t === end sits outside the
    // last span and de Boor would read past the knot vector.
    const t = i === steps ? end - (end - start) * 1e-9 : start + ((end - start) * i) / steps;
    points.push(deBoor(degree, knotVector, control, t));
  }
  return points;
}
