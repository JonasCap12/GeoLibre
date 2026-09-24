/**
 * Find the entities a CAD drawing left far from everything else.
 *
 * Real drawings accumulate strays: a block pasted in from an unrelated file, a
 * hatch left at a scratch coordinate, an entity nudged by a mis-keyed offset.
 * They are a rounding error in count and dominate the extent, because a map
 * zooms to fit its data. A surveyed alignment that spans 90 km arrives looking
 * like a dot because 0.5% of it sits 1,100 km away.
 *
 * The test is distance from the drawing's own centre, not a fixed coordinate
 * range: a CAD file carries no CRS, so there is no absolute notion of "too far
 * east". Both the centre and the threshold come from the data.
 *
 * Nothing here deletes anything. It reports, so the caller can ask.
 */

import type { Feature, FeatureCollection, Position } from "geojson";

/**
 * How many times the typical spread a feature must exceed to count as stray.
 *
 * Tuned against a 117,200-feature highway drawing whose real content reached
 * 96 km from centre while its strays reached 1,139 km — a gap of more than an
 * order of magnitude, which is what makes this separable at all. Set low, a
 * long-but-legitimate route (a national highway crossing the sheet) would be
 * flagged; this sits well above that.
 */
export const OUTLIER_DISTANCE_MULTIPLE = 8;

/**
 * Fraction of features that define "typical spread".
 *
 * The 95th percentile, not the mean: a handful of very distant features drags
 * a mean far enough to hide the very outliers being looked for.
 */
const SPREAD_PERCENTILE = 0.95;

/** Never propose dropping more than this share of a drawing. */
const MAX_OUTLIER_SHARE = 0.05;

/** A drawing's stray entities, and what removing them would do to the extent. */
export interface OutlierReport {
  /** Indices into the source `features` array, ascending. */
  indices: number[];
  /** How many features are stray. */
  count: number;
  /** Total features examined. */
  total: number;
  /** CAD layers the strays sit on, busiest first. */
  layers: { name: string; count: number }[];
  /** Furthest stray distance from the centre, in drawing units. */
  farthest: number;
  /** Distance covered by the features that remain, in drawing units. */
  keptSpan: number;
}

/** Every coordinate in a geometry, flattened. */
function positions(feature: Feature): Position[] {
  const out: Position[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number") {
      out.push(value as Position);
      return;
    }
    for (const entry of value) visit(entry);
  };
  const geometry = feature.geometry;
  if (!geometry) return out;
  if (geometry.type === "GeometryCollection") {
    for (const member of geometry.geometries) {
      if ("coordinates" in member) visit(member.coordinates);
    }
    return out;
  }
  visit(geometry.coordinates);
  return out;
}

/** The centre of a feature's coordinates, or null when it has none usable. */
function centreOf(feature: Feature): Position | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of positions(feature)) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Number.isFinite(minX) ? [(minX + maxX) / 2, (minY + maxY) / 2] : null;
}

/** The value at `fraction` through a sorted copy of `values`. */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}

/**
 * Report the stray features in a drawing, or null when there are none worth
 * mentioning.
 *
 * Returns null rather than an empty report when the drawing is coherent, when
 * it is too small to judge, or when the "strays" are too numerous to be
 * strays — a bimodal drawing (two sites in one file) is a legitimate thing to
 * have, and silently proposing to delete half of it would be worse than the
 * zoom problem this solves.
 *
 * @param collection - The parsed drawing.
 * @returns What to offer to drop, or null to offer nothing.
 */
export function findCadOutliers(collection: FeatureCollection): OutlierReport | null {
  const centres: (Position | null)[] = collection.features.map(centreOf);
  const usable = centres.filter((centre): centre is Position => centre !== null);
  // Below this there is no "typical" to compare against; a 20-feature drawing
  // with one distant entity is as likely to be two sites as one plus a stray.
  if (usable.length < 50) return null;

  // Median centre, not mean: a long thin alignment plus a few distant strays
  // pulls a mean off the drawing entirely.
  const medianX = percentile(usable.map((centre) => centre[0]), 0.5);
  const medianY = percentile(usable.map((centre) => centre[1]), 0.5);

  const distances = centres.map((centre) =>
    centre === null ? 0 : Math.hypot(centre[0] - medianX, centre[1] - medianY),
  );
  const spread = percentile(
    distances.filter((_, index) => centres[index] !== null),
    SPREAD_PERCENTILE,
  );
  // A drawing whose content is all at one point has no spread to scale by, so
  // there is nothing to separate.
  if (!(spread > 0)) return null;

  const threshold = spread * OUTLIER_DISTANCE_MULTIPLE;
  const indices: number[] = [];
  for (let i = 0; i < distances.length; i += 1) {
    if (centres[i] !== null && distances[i] > threshold) indices.push(i);
  }
  if (indices.length === 0) return null;
  if (indices.length > collection.features.length * MAX_OUTLIER_SHARE) return null;

  const layerCounts = new Map<string, number>();
  let farthest = 0;
  for (const index of indices) {
    const layer = String(collection.features[index].properties?.Layer ?? "");
    layerCounts.set(layer, (layerCounts.get(layer) ?? 0) + 1);
    if (distances[index] > farthest) farthest = distances[index];
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const stray = new Set(indices);
  for (let i = 0; i < collection.features.length; i += 1) {
    if (stray.has(i)) continue;
    for (const [x, y] of positions(collection.features[i])) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    indices,
    count: indices.length,
    total: collection.features.length,
    layers: [...layerCounts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    farthest,
    keptSpan: Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0,
  };
}

/**
 * A copy of `collection` without the reported features.
 *
 * @param collection - The drawing.
 * @param report - What {@link findCadOutliers} returned.
 * @returns The drawing with the strays removed.
 */
export function dropCadOutliers(
  collection: FeatureCollection,
  report: OutlierReport,
): FeatureCollection {
  const stray = new Set(report.indices);
  return {
    ...collection,
    features: collection.features.filter((_, index) => !stray.has(index)),
  };
}
