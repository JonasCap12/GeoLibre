import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Polygon } from "geojson";
import {
  DEFAULT_REPEAT_MS,
  ENTER_VIBRATION_MS,
  NEAR_VIBRATION_MS,
  acknowledgeZone,
  emptyAlertMemory,
  forgetZone,
  markAlerted,
  shouldAlert,
  triggerVibration,
  type AlertMemory,
} from "../apps/geolibre-desktop/src/lib/hazard-alerts";
import {
  DEFAULT_HAZARD_SETTINGS,
  HAZARD_METRES_PER_DEGREE,
  emptyHazardState,
  evaluateHazards,
  type HazardFix,
  type HazardState,
  type HazardZone,
} from "../apps/geolibre-desktop/src/lib/hazard-zones";

const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const START = 1_000_000;

function square(halfMetres: number): Polygon {
  const d = halfMetres / HAZARD_METRES_PER_DEGREE;
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

const PIT: HazardZone = {
  id: "pit",
  name: "Excavation",
  level: "danger",
  geometry: square(100),
};

function fixAt(offsetMs: number, inside: boolean): HazardFix {
  return {
    lng: 0,
    lat: inside ? 0 : 400 / HAZARD_METRES_PER_DEGREE,
    accuracy: 5,
    timestamp: START + offsetMs,
  };
}

function runReentryReplay(acknowledge: boolean): number[] {
  let state: HazardState = emptyHazardState();
  let memory = emptyAlertMemory();
  const alerts: number[] = [];
  const steps = [
    { offsetMs: 0, inside: true },
    { offsetMs: 4_000, inside: false },
    { offsetMs: 5_000, inside: false },
    { offsetMs: 8_000, inside: true },
  ];

  for (const step of steps) {
    const now = START + step.offsetMs;
    const result = evaluateHazards(
      fixAt(step.offsetMs, step.inside),
      [PIT],
      state,
      DEFAULT_HAZARD_SETTINGS,
      now,
      START,
    );
    state = result.state;
    for (const event of result.events) {
      if (event.type === "exit") {
        memory = forgetZone(memory, event.zone.id);
      } else if (shouldAlert(memory, event.zone.id, event.type, now, DEFAULT_REPEAT_MS)) {
        memory = markAlerted(memory, event.zone.id, now, event.type);
        alerts.push(step.offsetMs);
      }
    }
    if (acknowledge && step.offsetMs === 0)
      memory = acknowledgeZone(memory, PIT.id, START + 1_000, 3 * 60_000);
  }
  return alerts;
}

describe("hazard alerts", () => {
  it("vibrates with the long pattern on enter and the short one when near", () => {
    const patterns: number[][] = [];
    const host = {
      userAgent: DESKTOP,
      vibrate: (pattern: number | number[]) => {
        patterns.push(pattern as number[]);
        return true;
      },
    };
    assert.equal(triggerVibration(host, "enter"), "vibrated");
    assert.equal(triggerVibration(host, "near"), "vibrated");
    assert.deepEqual(patterns, [ENTER_VIBRATION_MS, NEAR_VIBRATION_MS]);
  });

  it("does not vibrate on iPhone or when the API is missing", () => {
    let calls = 0;
    const vibrate = () => {
      calls += 1;
      return true;
    };
    assert.equal(triggerVibration({ userAgent: IPHONE, vibrate }, "enter"), "unsupported");
    assert.equal(triggerVibration({ userAgent: DESKTOP }, "enter"), "unsupported");
    assert.equal(calls, 0);
  });

  it("repeats while inside no more often than the repeat interval", () => {
    const now = START;
    let memory = emptyAlertMemory();
    assert.equal(shouldAlert(memory, "pit", "enter", now, DEFAULT_REPEAT_MS), true);
    memory = markAlerted(memory, "pit", now, "enter");
    assert.equal(shouldAlert(memory, "pit", null, now + 1_000, DEFAULT_REPEAT_MS), false);
    assert.equal(
      shouldAlert(memory, "pit", null, now + DEFAULT_REPEAT_MS - 1, DEFAULT_REPEAT_MS),
      false,
    );
    assert.equal(
      shouldAlert(memory, "pit", null, now + DEFAULT_REPEAT_MS, DEFAULT_REPEAT_MS),
      true,
    );
  });

  it("stays quiet after acknowledgement until the silence timer expires", () => {
    const now = START;
    const silenceMs = 60_000;
    let memory = emptyAlertMemory();
    memory = markAlerted(memory, "pit", now, "enter");
    memory = acknowledgeZone(memory, "pit", now, silenceMs);
    assert.equal(
      shouldAlert(memory, "pit", null, now + DEFAULT_REPEAT_MS, DEFAULT_REPEAT_MS),
      false,
    );
    assert.equal(shouldAlert(memory, "pit", null, now + silenceMs - 1, DEFAULT_REPEAT_MS), false);
    assert.equal(shouldAlert(memory, "pit", null, now + silenceMs, DEFAULT_REPEAT_MS), true);
  });

  it("alerts immediately when an acknowledged near presence escalates to inside", () => {
    let memory = markAlerted(emptyAlertMemory(), "pit", START, "near");
    memory = acknowledgeZone(memory, "pit", START, 3 * 60_000);
    assert.equal(shouldAlert(memory, "pit", null, START + 1_000, DEFAULT_REPEAT_MS), false);
    assert.equal(shouldAlert(memory, "pit", "enter", START + 1_000, DEFAULT_REPEAT_MS), true);
  });

  it("does not make inside to near de-escalation a new immediate alert", () => {
    let state = emptyHazardState();
    const inside = evaluateHazards(
      fixAt(0, true),
      [PIT],
      state,
      { ...DEFAULT_HAZARD_SETTINGS, confirmFixes: 1 },
      START,
      START,
    );
    state = inside.state;
    const near = evaluateHazards(
      {
        lng: 0,
        lat: 110 / HAZARD_METRES_PER_DEGREE,
        accuracy: 5,
        timestamp: START + 1_000,
      },
      [PIT],
      state,
      { ...DEFAULT_HAZARD_SETTINGS, confirmFixes: 1 },
      START + 1_000,
      START,
    );
    assert.equal(near.presence.pit, "near");
    assert.equal(near.events[0]?.type, "near");
    const memory = markAlerted(emptyAlertMemory(), "pit", START, "enter");
    assert.equal(
      shouldAlert(memory, "pit", near.events[0]?.type ?? null, START + 1_000, DEFAULT_REPEAT_MS),
      false,
    );
  });

  it("forgets silence and repeat history when a zone is exited", () => {
    let memory: AlertMemory = {
      silencedUntil: { pit: START + 180_000, other: START + 100 },
      lastAlertAt: { pit: START, other: START },
      lastKind: { pit: "enter", other: "near" },
    };
    memory = forgetZone(memory, "pit");
    assert.deepEqual(memory, {
      silencedUntil: { other: START + 100 },
      lastAlertAt: { other: START },
      lastKind: { other: "near" },
    });
  });

  it("alerts on re-entry inside the repeat window", () => {
    assert.deepEqual(runReentryReplay(false), [0, 8_000]);
  });

  it("alerts on re-entry after the preceding visit was acknowledged", () => {
    assert.deepEqual(runReentryReplay(true), [0, 8_000]);
  });
});
