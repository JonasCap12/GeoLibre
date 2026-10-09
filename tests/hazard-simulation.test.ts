import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SIMULATION_FIX_INTERVAL_MS,
  createHazardSimulationStream,
  type SimulationScheduler,
} from "../apps/geolibre-desktop/src/lib/hazard-simulation";
import type { HazardFix } from "../apps/geolibre-desktop/src/lib/hazard-zones";

class FakeScheduler implements SimulationScheduler {
  callback: (() => void) | null = null;
  intervalMs: number | null = null;

  setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return 1;
  }

  clearInterval(): void {
    this.callback = null;
    this.intervalMs = null;
  }

  tick(): void {
    this.callback?.();
  }
}

describe("hazard simulation stream", () => {
  it("emits fresh fixes every second without requiring more clicks", () => {
    let now = 10_000;
    const scheduler = new FakeScheduler();
    const fixes: HazardFix[] = [];
    const stream = createHazardSimulationStream(
      (fix) => fixes.push(fix),
      () => now,
      scheduler,
    );
    stream.move({ lng: 106.7, lat: 10.8 });
    assert.equal(scheduler.intervalMs, SIMULATION_FIX_INTERVAL_MS);
    now += 1_000;
    scheduler.tick();
    now += 1_000;
    scheduler.tick();

    assert.deepEqual(
      fixes.map((fix) => fix.timestamp),
      [10_000, 11_000, 12_000],
    );
    assert.ok(fixes.every((fix) => fix.lng === 106.7 && fix.lat === 10.8));
  });

  it("stops on lost signal and a new click moves and restarts the stream", () => {
    let now = 20_000;
    const scheduler = new FakeScheduler();
    const fixes: HazardFix[] = [];
    const stream = createHazardSimulationStream(
      (fix) => fixes.push(fix),
      () => now,
      scheduler,
    );

    stream.move({ lng: 1, lat: 2 });
    stream.loseSignal();
    now += 1_000;
    scheduler.tick();
    assert.equal(fixes.length, 1);
    assert.equal(scheduler.callback, null);

    stream.move({ lng: 3, lat: 4 });
    now += 1_000;
    scheduler.tick();
    assert.deepEqual(
      fixes.map(({ lng, lat, timestamp }) => ({ lng, lat, timestamp })),
      [
        { lng: 1, lat: 2, timestamp: 20_000 },
        { lng: 3, lat: 4, timestamp: 21_000 },
        { lng: 3, lat: 4, timestamp: 22_000 },
      ],
    );
  });
});
