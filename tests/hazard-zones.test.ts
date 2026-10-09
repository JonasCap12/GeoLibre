import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MultiPolygon, Polygon, Position } from "geojson";
import {
  DEFAULT_HAZARD_SETTINGS,
  HAZARD_METRES_PER_DEGREE,
  collectHazardZones,
  emptyHazardState,
  evaluateHazards,
  hazardZoneFromFeature,
  type HazardFix,
  type HazardSettings,
  type HazardState,
  type HazardZone,
} from "../apps/geolibre-desktop/src/lib/hazard-zones";

function degrees(metres: number): number {
  return metres / HAZARD_METRES_PER_DEGREE;
}

/** A square centred on the equator, `halfMetres` from the centre to each edge. */
function square(halfMetres: number): Polygon {
  const d = degrees(halfMetres);
  return {
    type: "Polygon",
    coordinates: [
      [
        [-d, -d],
        [d, -d],
        [d, d],
        [-d, d],
        [-d, -d],
      ],
    ],
  };
}

function zone(geometry: Polygon | MultiPolygon, id = "pit"): HazardZone {
  return { id, name: "Hố móng", level: "danger", geometry };
}

function fix(lng: number, lat: number, accuracy = 5, timestamp = 1_000): HazardFix {
  return { lng, lat, accuracy, timestamp };
}

function settings(overrides: Partial<HazardSettings> = {}): HazardSettings {
  return { ...DEFAULT_HAZARD_SETTINGS, confirmFixes: 1, marginM: 0, ...overrides };
}

function step(
  point: HazardFix | null,
  zones: HazardZone[],
  state: HazardState,
  options: Partial<HazardSettings> = {},
  now = 1_000,
  watchingSince = 0,
) {
  return evaluateHazards(point, zones, state, settings(options), now, watchingSince);
}

describe("hazard zones", () => {
  const pit = zone(square(100));

  it("reports inside, near, and outside in metres", () => {
    const far = fix(0, degrees(400));
    const centre = fix(0, 0);
    const near = fix(0, degrees(110));

    let state = emptyHazardState();
    let result = step(far, [pit], state);
    state = result.state;
    assert.equal(result.summary, "safe");
    assert.equal(result.presence.pit, "outside");
    assert.deepEqual(result.events, []);

    result = step(centre, [pit], state);
    state = result.state;
    assert.equal(result.summary, "inside");
    assert.equal(result.events[0]?.type, "enter");

    result = step(near, [pit], state);
    state = result.state;
    assert.equal(result.summary, "near");
    assert.equal(result.presence.pit, "near");
    assert.equal(result.events[0]?.type, "near");

    result = step(far, [pit], state);
    assert.equal(result.summary, "safe");
    assert.equal(result.events[0]?.type, "exit");
  });

  it("treats the hole of a polygon as outside", () => {
    const outer = degrees(200);
    const hole = degrees(40);
    const holed: Polygon = {
      type: "Polygon",
      coordinates: [
        [
          [-outer, -outer],
          [outer, -outer],
          [outer, outer],
          [-outer, outer],
          [-outer, -outer],
        ],
        [
          [-hole, -hole],
          [hole, -hole],
          [hole, hole],
          [-hole, hole],
          [-hole, -hole],
        ],
      ],
    };
    const ring = zone(holed);
    const inHole = step(fix(0, 0), [ring], emptyHazardState());
    assert.equal(inHole.presence.pit, "outside");
    const inSolid = step(fix(degrees(100), 0), [ring], emptyHazardState());
    assert.equal(inSolid.presence.pit, "inside");
  });

  it("matches a point in either part of a MultiPolygon", () => {
    const shift = degrees(500);
    const rings = square(50).coordinates;
    const moved = rings.map((ring) => ring.map(([lng, lat]) => [lng + shift, lat] as Position));
    const both: MultiPolygon = { type: "MultiPolygon", coordinates: [rings, moved] };
    const result = step(fix(shift, 0), [zone(both)], emptyHazardState());
    assert.equal(result.presence.pit, "inside");
    assert.equal(result.events[0]?.type, "enter");
  });

  it("reports uncertain when the accuracy circle overlaps the zone", () => {
    const thirtyMetresOut = fix(0, degrees(130), 40);
    const result = step(thirtyMetresOut, [pit], emptyHazardState());
    assert.equal(result.presence.pit, "uncertain");
    assert.equal(result.summary, "near");
    assert.equal(result.events[0]?.type, "near");
  });

  it("does not call a poor fix safe", () => {
    const result = step(fix(0, degrees(400), 80), [pit], emptyHazardState());
    assert.equal(result.presence.pit, "outside");
    assert.equal(result.summary, "poor");
    assert.deepEqual(result.events, []);
  });

  it("does not flap when fixes alternate across the boundary", () => {
    let state = emptyHazardState();
    const inside = fix(0, 0);
    const outside = fix(0, degrees(400));
    for (const point of [inside, outside, inside, outside]) {
      const result = step(point, [pit], state, { confirmFixes: 2 });
      state = result.state;
      assert.equal(result.events.length, 0);
      assert.equal(result.summary, "safe");
    }
    const first = step(inside, [pit], state, { confirmFixes: 2 });
    assert.equal(first.events.length, 0);
    const second = step(inside, [pit], first.state, { confirmFixes: 2 });
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0]?.type, "enter");
  });

  it("holds a presence until the fix clears the margin", () => {
    const entered = step(fix(0, 0), [pit], emptyHazardState(), { marginM: 3 });
    assert.equal(entered.presence.pit, "inside");
    const barelyOut = step(fix(0, degrees(101)), [pit], entered.state, { marginM: 3 });
    assert.equal(barelyOut.presence.pit, "inside");
    assert.equal(barelyOut.events.length, 0);
  });

  it("reports lost signal instead of safe when the fix is stale", () => {
    const entered = step(fix(0, 0), [pit], emptyHazardState());
    const lost = step(fix(0, degrees(400), 5, 0), [pit], entered.state, {}, 20_000);
    assert.equal(lost.summary, "lost");
    assert.equal(lost.events.length, 0);
    assert.equal(lost.presence.pit, "inside");
  });

  it("waits, then reports lost signal when no fix arrives", () => {
    const waiting = step(null, [pit], emptyHazardState(), {}, 1_000, 0);
    assert.equal(waiting.summary, "waiting");
    const lost = step(null, [pit], emptyHazardState(), {}, 20_000, 0);
    assert.equal(lost.summary, "lost");
  });

  it("reads a zone name and level, and falls back to the layer name", () => {
    const named = hazardZoneFromFeature(
      {
        geometry: square(10),
        properties: { ten: "Cần cẩu", muc: "canh_bao" },
      },
      "Layer",
      "a:0",
    );
    assert.equal(named?.name, "Cần cẩu");
    assert.equal(named?.level, "caution");
    const fallback = hazardZoneFromFeature(
      { geometry: square(10), properties: {} },
      "Đào đất",
      "a:1",
    );
    assert.equal(fallback?.name, "Đào đất");
    assert.equal(fallback?.level, "danger");
  });

  it("collects polygon features only from flagged layers", () => {
    const zones = collectHazardZones([
      {
        id: "walls",
        name: "Walls",
        type: "geojson",
        metadata: { hazardZone: true },
        geojson: {
          features: [
            { geometry: { type: "LineString", coordinates: [] }, properties: {} },
            { geometry: square(10), properties: { name: "Pit" } },
          ],
        },
      },
      {
        id: "other",
        name: "Other",
        type: "geojson",
        geojson: { features: [{ geometry: square(10), properties: {} }] },
      },
    ]);
    assert.equal(zones.length, 1);
    assert.equal(zones[0]?.name, "Pit");
    assert.equal(zones[0]?.id, "walls:1");
  });
});
