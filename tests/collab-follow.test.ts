import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollaborationParticipant, MapViewState } from "@geolibre/core";
import {
  followAfterParticipants,
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
