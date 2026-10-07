import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollaborationParticipant, MapViewState } from "@geolibre/core";
import {
  createFollowClock,
  createThrottledViewSend,
  FOLLOW_SETTLE_MS,
  FOLLOW_STREAM_MAX_MS,
  FOLLOW_STREAM_MIN_MS,
  followAfterParticipants,
  followMotion,
  followOnWelcome,
  followTarget,
  viewToApply,
} from "../apps/geolibre-desktop/src/lib/collab-follow";

const view = (zoom: number): MapViewState => ({
  center: [10, 20],
  zoom,
  bearing: 0,
  pitch: 0,
});

function person(
  clientId: string,
  role: CollaborationParticipant["role"],
): CollaborationParticipant {
  return {
    clientId,
    displayName: clientId,
    color: "#336699",
    role,
    editOverride: null,
  };
}

describe("viewToApply", () => {
  it("applies only the followed person's camera", () => {
    const theirs = view(8);
    assert.equal(viewToApply("alice", { clientId: "alice", view: theirs }), theirs);
    assert.equal(viewToApply("alice", { clientId: "bob", view: view(4) }), null);
    assert.equal(viewToApply(null, { clientId: "alice", view: theirs }), null);
    assert.equal(viewToApply("alice", { clientId: "alice" }), null);
    assert.equal(viewToApply("alice", { clientId: "alice", view: null }), null);
  });
});

describe("followAfterParticipants", () => {
  it("clears the follow when that person leaves", () => {
    const roster = [{ clientId: "alice" }, { clientId: "bob" }];
    assert.equal(followAfterParticipants("alice", roster), "alice");
    assert.equal(followAfterParticipants("alice", [{ clientId: "bob" }]), null);
    assert.equal(followAfterParticipants(null, roster), null);
  });
});

describe("followTarget", () => {
  it("refuses to follow yourself", () => {
    assert.equal(followTarget("me", "me"), null);
    assert.equal(followTarget("alice", "me"), "alice");
    assert.equal(followTarget(null, "me"), null);
  });
});

describe("followOnWelcome", () => {
  const participants = [person("host", "host"), person("guest", "guest")];

  it("has a guest follow the host on the first welcome", () => {
    const decided = followOnWelcome({
      role: "guest",
      selfId: "guest",
      participants,
      currentFollow: null,
      autoFollowHost: true,
    });
    assert.deepEqual(decided, { followClientId: "host", autoFollowHost: false });
  });

  it("does not auto-follow when joining as the host", () => {
    const decided = followOnWelcome({
      role: "host",
      selfId: "host",
      participants,
      currentFollow: null,
      autoFollowHost: false,
    });
    assert.equal(decided.followClientId, null);
  });

  it("keeps a guest's choice across a later welcome", () => {
    const stopped = followOnWelcome({
      role: "guest",
      selfId: "guest",
      participants,
      currentFollow: null,
      autoFollowHost: false,
    });
    assert.equal(stopped.followClientId, null);

    const still = followOnWelcome({
      role: "guest",
      selfId: "guest",
      participants: [...participants, person("carol", "guest")],
      currentFollow: "carol",
      autoFollowHost: false,
    });
    assert.equal(still.followClientId, "carol");
  });
});

function camera(patch: Partial<MapViewState> = {}): MapViewState {
  return { center: [10, 20], zoom: 10, bearing: 0, pitch: 0, ...patch };
}

describe("followMotion", () => {
  it("skips a negligible change, including a bearing that wraps past 0", () => {
    const same = followMotion({
      current: camera(),
      target: camera(),
      msSinceLastFollowedView: 80,
    });
    assert.deepEqual(same, { kind: "skip" });
    const wrapped = followMotion({
      current: camera({ bearing: 359 }),
      target: camera({ bearing: 1 }),
      msSinceLastFollowedView: 80,
    });
    assert.deepEqual(wrapped, { kind: "skip" });
  });

  it("eases for 500 ms on the first view after a follow", () => {
    const motion = followMotion({
      current: camera({ zoom: 10 }),
      target: camera({ zoom: 10.5 }),
      msSinceLastFollowedView: null,
    });
    assert.deepEqual(motion, { kind: "ease", durationMs: FOLLOW_SETTLE_MS });
  });

  it("uses a short ease while views are streaming", () => {
    const motion = followMotion({
      current: camera({ zoom: 10 }),
      target: camera({ zoom: 10.5 }),
      msSinceLastFollowedView: 80,
    });
    assert.equal(motion.kind, "ease");
    if (motion.kind !== "ease") return;
    assert.ok(motion.durationMs >= FOLLOW_STREAM_MIN_MS);
    assert.ok(motion.durationMs <= FOLLOW_STREAM_MAX_MS);
    assert.equal(motion.durationMs, 80);
  });

  it("jumps across a large zoom change", () => {
    const motion = followMotion({
      current: camera({ zoom: 15 }),
      target: camera({ zoom: 5 }),
      msSinceLastFollowedView: 80,
    });
    assert.deepEqual(motion, { kind: "jump" });
  });
});

describe("createThrottledViewSend", () => {
  it("sends the first view and one trailing send of the last view", () => {
    let time = 0;
    const sent: number[] = [];
    const trailers: Array<() => void> = [];
    const publisher = createThrottledViewSend({
      throttleMs: 80,
      now: () => time,
      schedule: (fn) => {
        trailers.push(fn);
        return 1;
      },
      clear: () => {
        trailers.length = 0;
      },
      send: (next) => sent.push(next.zoom),
    });
    publisher.push(camera({ zoom: 1 }));
    time = 10;
    publisher.push(camera({ zoom: 2 }));
    time = 40;
    publisher.push(camera({ zoom: 3 }));
    assert.deepEqual(sent, [1]);
    const fire = trailers[0];
    assert.ok(fire);
    time = 80;
    fire();
    assert.deepEqual(sent, [1, 3]);
  });

  it("sends nothing further after dispose", () => {
    let time = 0;
    const sent: number[] = [];
    const trailers: Array<() => void> = [];
    const publisher = createThrottledViewSend({
      throttleMs: 80,
      now: () => time,
      schedule: (fn) => {
        trailers.push(fn);
        return 1;
      },
      clear: () => {
        trailers.length = 0;
      },
      send: (next) => sent.push(next.zoom),
    });
    publisher.push(camera({ zoom: 1 }));
    time = 10;
    publisher.push(camera({ zoom: 9 }));
    const fire = trailers[0];
    publisher.dispose();
    time = 80;
    fire?.();
    assert.deepEqual(sent, [1]);
  });
});

describe("createFollowClock", () => {
  it("treats the view after a new person as the first", () => {
    let time = 0;
    const clock = createFollowClock(() => time);
    clock.note("alice");
    assert.equal(clock.mark(), null);
    time = 80;
    assert.equal(clock.mark(), 80);
    clock.note(null);
    clock.note("bob");
    time = 90;
    assert.equal(clock.mark(), null);
  });
});
