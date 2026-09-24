import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  OUTLIER_DISTANCE_MULTIPLE,
  dropCadOutliers,
  findCadOutliers,
} from "../apps/geolibre-desktop/src/lib/cad-outliers";

/**
 * A CAD drawing accumulates strays — a block pasted from another file, a hatch
 * left at a scratch coordinate. They are a rounding error in count and they
 * own the extent, because the map zooms to fit its data: a surveyed alignment
 * spanning 90 km arrives as a dot because 0.5% of it sits 1,100 km away.
 *
 * The risk in fixing that is cutting real data, so most of what follows is
 * about what must survive.
 */

const point = (x: number, y: number, layer = "site"): Feature => ({
  type: "Feature",
  properties: { Layer: layer },
  geometry: { type: "Point", coordinates: [x, y] },
});

const collect = (features: Feature[]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

/** A compact cluster of `count` features around (0, 0). */
function cluster(count: number, spread = 100, layer = "site"): Feature[] {
  return Array.from({ length: count }, (_, i) =>
    point((i % 20) * (spread / 20), Math.floor(i / 20) * (spread / 20), layer),
  );
}

describe("findCadOutliers", () => {
  it("finds the strays and names their layers", () => {
    const features = [...cluster(200), point(500_000, 500_000, "noithat")];
    const report = findCadOutliers(collect(features));
    assert.ok(report);
    assert.equal(report.count, 1);
    assert.deepEqual(report.indices, [200]);
    assert.deepEqual(report.layers, [{ name: "noithat", count: 1 }]);
  });

  it("leaves a coherent drawing alone", () => {
    assert.equal(findCadOutliers(collect(cluster(300))), null);
  });

  it("keeps a long thin alignment whole", () => {
    // The shape that makes a fixed radius useless: a road is legitimately
    // 100x longer than it is wide, and every point on it is real.
    const road = Array.from({ length: 400 }, (_, i) => point(i * 250, i * 5));
    assert.equal(findCadOutliers(collect(road)), null);
  });

  it("refuses to cut a drawing that is simply in two places", () => {
    // Two sites in one file is a legitimate thing to have. Proposing to delete
    // half of it would be worse than the zoom problem this solves, so past a
    // share of the drawing the answer is to do nothing.
    const features = [...cluster(100), ...cluster(100).map((f) => {
      const [x, y] = (f.geometry as { coordinates: number[] }).coordinates;
      return point(x + 900_000, y + 900_000, "site-b");
    })];
    assert.equal(findCadOutliers(collect(features)), null);
  });

  it("says nothing about a drawing too small to judge", () => {
    // With 20 features, "one far away" is as likely to be two sites as a stray.
    const features = [...cluster(19), point(900_000, 900_000)];
    assert.equal(findCadOutliers(collect(features)), null);
  });

  it("ignores a drawing with no spread to scale by", () => {
    const features = Array.from({ length: 100 }, () => point(5, 5));
    assert.equal(findCadOutliers(collect(features)), null);
  });

  it("measures against the drawing, not a fixed distance", () => {
    // A CAD file carries no CRS, so "far" has to be relative. The same shape
    // scaled up by 1000 must give the same answer.
    const small = [...cluster(200, 100), point(50_000, 0, "stray")];
    const large = [...cluster(200, 100_000), point(50_000_000, 0, "stray")];
    assert.equal(findCadOutliers(collect(small))?.count, 1);
    assert.equal(findCadOutliers(collect(large))?.count, 1);
  });

  it("draws the line at the configured multiple of the drawing's spread", () => {
    // Measured, not assumed: for a 200-feature cluster 100 units across, the
    // 95th percentile of distance-from-centre is ~56 units, so the cut falls
    // at ~452 (56 x OUTLIER_DISTANCE_MULTIPLE). Both sides are asserted, so
    // changing the multiple fails here rather than silently moving what a
    // drawing loses.
    const flagged = (distance: number): boolean => {
      const features = [...cluster(200, 100), point(distance, 0, "probe")];
      const report = findCadOutliers(collect(features));
      return report?.layers.some((layer) => layer.name === "probe") ?? false;
    };
    assert.equal(flagged(400), false, "inside the threshold must survive");
    assert.equal(flagged(520), true, "outside the threshold must be offered");
    assert.equal(OUTLIER_DISTANCE_MULTIPLE, 8, "the boundary above assumes this multiple");
  });

  it("skips features with no usable geometry instead of placing them at zero", () => {
    const features: Feature[] = [
      ...cluster(200),
      { type: "Feature", properties: { Layer: "empty" }, geometry: null },
    ];
    const report = findCadOutliers(collect(features));
    // A null geometry is not a stray; it is nothing. Treating it as (0, 0)
    // would flag it on any drawing that does not straddle the origin.
    assert.equal(report, null);
  });

  it("reports the extent the drawing gets back", () => {
    const features = [...cluster(200, 1000), point(900_000, 0, "stray")];
    const report = findCadOutliers(collect(features));
    assert.ok(report);
    assert.ok(report.farthest > 800_000, "the stray is far");
    assert.ok(report.keptSpan < 5_000, `what remains is compact, got ${report.keptSpan}`);
  });
});

describe("dropCadOutliers", () => {
  it("removes exactly the reported features", () => {
    const features = [...cluster(200), point(900_000, 900_000, "noithat")];
    const source = collect(features);
    const report = findCadOutliers(source);
    assert.ok(report);
    const kept = dropCadOutliers(source, report);
    assert.equal(kept.features.length, 200);
    assert.ok(
      !kept.features.some((f) => f.properties?.Layer === "noithat"),
      "the stray must be gone",
    );
  });

  it("does not mutate the drawing it was given", () => {
    const source = collect([...cluster(200), point(900_000, 900_000)]);
    const before = source.features.length;
    const report = findCadOutliers(source);
    assert.ok(report);
    dropCadOutliers(source, report);
    assert.equal(source.features.length, before, "the caller keeps the original");
  });
});
