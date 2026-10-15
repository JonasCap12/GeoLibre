import difference from "@turf/difference";
import { featureCollection, feature as turfFeature } from "@turf/helpers";
import intersect from "@turf/intersect";
import type {
  Feature,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position,
} from "geojson";

/**
 * Split a geometry into the part inside a drawn area and the part outside it,
 * so an edit can touch only what the user swept, such as recolouring one
 * stretch of a road in a technical drawing rather than the whole polyline.
 *
 * Lines are cut where they cross the area's boundary, polygons are clipped
 * with intersect/difference, and points are sorted by containment. Geometry
 * collections are not split: they come back whole as `outside`.
 */
export interface AreaSplit {
  /** The part inside the area, or null when nothing of it is inside. */
  inside: Geometry | null;
  /** The part outside the area, or null when all of it is inside. */
  outside: Geometry | null;
}

type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

function ringBounds(ring: Position[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function positionsOf(geometry: Geometry): Position[] {
  switch (geometry.type) {
    case "Point":
      return [geometry.coordinates];
    case "MultiPoint":
    case "LineString":
      return geometry.coordinates;
    case "MultiLineString":
    case "Polygon":
      return geometry.coordinates.flat();
    case "MultiPolygon":
      return geometry.coordinates.flat(2);
    case "GeometryCollection":
      return geometry.geometries.flatMap(positionsOf);
  }
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** Even-odd containment, so a self-crossing freehand lasso still behaves. */
function insideRing(point: Position, ring: Position[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Parameters along segment a→b where it crosses any edge of the ring. */
function crossings(a: Position, b: Position, ring: Position[]): number[] {
  const ts: number[] = [];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let i = 0; i < ring.length - 1; i++) {
    const p = ring[i];
    const q = ring[i + 1];
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const denominator = dx * ey - dy * ex;
    if (denominator === 0) continue;
    const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / denominator;
    const u = ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / denominator;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  return ts.sort((left, right) => left - right);
}

const lerp = (a: Position, b: Position, t: number): Position => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
];

/** Cut one polyline into its runs inside and outside the ring. */
function splitLine(
  line: Position[],
  ring: Position[],
): { inside: Position[][]; outside: Position[][] } {
  const inside: Position[][] = [];
  const outside: Position[][] = [];
  let run: Position[] = [];
  let runInside: boolean | null = null;
  const close = () => {
    if (run.length > 1) (runInside ? inside : outside).push(run);
  };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const cuts = [0, ...crossings(a, b, ring), 1];
    for (let k = 0; k < cuts.length - 1; k++) {
      const start = lerp(a, b, cuts[k]);
      const end = lerp(a, b, cuts[k + 1]);
      // Each piece lies wholly on one side, so its midpoint decides.
      const pieceInside = insideRing(lerp(a, b, (cuts[k] + cuts[k + 1]) / 2), ring);
      if (pieceInside !== runInside) {
        close();
        run = [start];
        runInside = pieceInside;
      }
      run.push(end);
    }
  }
  close();
  return { inside, outside };
}

function lines(parts: Position[][]): LineString | MultiLineString | null {
  if (parts.length === 0) return null;
  return parts.length === 1
    ? { type: "LineString", coordinates: parts[0] }
    : { type: "MultiLineString", coordinates: parts };
}

function clipPolygon(geometry: Polygon | MultiPolygon, area: Polygon): AreaSplit {
  const pair = featureCollection<Polygon | MultiPolygon>([
    turfFeature(geometry) as Feature<Polygon | MultiPolygon>,
    turfFeature(area) as Feature<Polygon>,
  ]);
  return {
    inside: intersect(pair)?.geometry ?? null,
    outside: difference(pair)?.geometry ?? null,
  };
}

/**
 * Split a geometry by a drawn area.
 *
 * @param geometry - The feature geometry to split.
 * @param area - The drawn area, a single ring without holes.
 * @returns The inside and outside parts; a geometry the area misses comes back
 *   whole as `outside`, and one it covers whole as `inside`.
 */
export function splitGeometryByArea(geometry: Geometry, area: Polygon): AreaSplit {
  const ring = area.coordinates[0];
  const untouched: AreaSplit = { inside: null, outside: geometry };
  if (!ring || ring.length < 4) return untouched;
  const positions = positionsOf(geometry);
  if (positions.length === 0 || !boundsOverlap(ringBounds(positions), ringBounds(ring))) {
    return untouched;
  }

  switch (geometry.type) {
    case "Point":
      return insideRing(geometry.coordinates, ring)
        ? { inside: geometry, outside: null }
        : untouched;
    case "MultiPoint": {
      const inPoints = geometry.coordinates.filter((point) => insideRing(point, ring));
      const outPoints = geometry.coordinates.filter((point) => !insideRing(point, ring));
      return {
        inside: inPoints.length ? { type: "MultiPoint", coordinates: inPoints } : null,
        outside: outPoints.length ? { type: "MultiPoint", coordinates: outPoints } : null,
      };
    }
    case "LineString":
    case "MultiLineString": {
      const parts = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      const inside: Position[][] = [];
      const outside: Position[][] = [];
      for (const part of parts) {
        const split = splitLine(part, ring);
        inside.push(...split.inside);
        outside.push(...split.outside);
      }
      // Hand back the original object when nothing was cut, so an untouched
      // or wholly covered line keeps its exact coordinates.
      if (inside.length === 0) return untouched;
      if (outside.length === 0) return { inside: geometry, outside: null };
      return { inside: lines(inside), outside: lines(outside) };
    }
    case "Polygon":
    case "MultiPolygon": {
      try {
        const split = clipPolygon(geometry, area);
        if (!split.inside) return untouched;
        if (!split.outside) return { inside: geometry, outside: null };
        return split;
      } catch {
        // A ring the clipper cannot handle stays whole rather than vanishing.
        return untouched;
      }
    }
    case "GeometryCollection":
      return untouched;
  }
}
