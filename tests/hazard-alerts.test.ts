import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_REPEAT_MS,
  ENTER_VIBRATION_MS,
  NEAR_VIBRATION_MS,
  acknowledgeZone,
  emptyAlertMemory,
  markAlerted,
  shouldAlert,
  triggerVibration,
} from "../apps/geolibre-desktop/src/lib/hazard-alerts";

const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

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

  it("stays quiet after acknowledgement until the silence timer expires", () => {
    const now = 1_000_000;
    const silenceMs = 60_000;
    let memory = emptyAlertMemory();
    assert.equal(shouldAlert(memory, "pit", now, DEFAULT_REPEAT_MS), true);
    memory = markAlerted(memory, "pit", now);
    assert.equal(shouldAlert(memory, "pit", now + 1_000, DEFAULT_REPEAT_MS), false);
    assert.equal(shouldAlert(memory, "pit", now + DEFAULT_REPEAT_MS, DEFAULT_REPEAT_MS), true);

    memory = markAlerted(memory, "pit", now, "near");
    assert.equal(shouldAlert(memory, "pit", now + 1_000, DEFAULT_REPEAT_MS, "enter"), true);
    assert.equal(shouldAlert(memory, "pit", now + 1_000, DEFAULT_REPEAT_MS, "near"), false);

    memory = acknowledgeZone(memory, "pit", now, silenceMs);
    assert.equal(shouldAlert(memory, "pit", now + DEFAULT_REPEAT_MS, DEFAULT_REPEAT_MS), false);
    assert.equal(shouldAlert(memory, "pit", now + silenceMs - 1, DEFAULT_REPEAT_MS), false);
    assert.equal(shouldAlert(memory, "pit", now + silenceMs, DEFAULT_REPEAT_MS), true);
  });
});
