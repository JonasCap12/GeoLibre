import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CollaborationState } from "@geolibre/core";
import {
  collaborationCanEdit,
  collaborationCanEditLayer,
} from "../apps/geolibre-desktop/src/lib/collaboration-permissions";

function session(patch: Partial<CollaborationState>): CollaborationState {
  return {
    isActive: true,
    clientId: "me",
    role: "guest",
    mode: "co-edit",
    participants: [{ clientId: "me", role: "guest" }],
    lockedLayerIds: [],
    ...patch,
  } as CollaborationState;
}

describe("collaboration edit rights", () => {
  it("outside a session: no project edits, but every layer is editable", () => {
    const off = session({ isActive: false });
    assert.equal(collaborationCanEdit(off), false);
    assert.equal(collaborationCanEditLayer(off, "a"), true);
  });

  it("the host edits everything, locked layers included", () => {
    const host = session({ role: "host", mode: "view-only", lockedLayerIds: ["a"] });
    assert.equal(collaborationCanEdit(host), true);
    assert.equal(collaborationCanEditLayer(host, "a"), true);
  });

  it("a co-edit guest edits unlocked layers only", () => {
    const guest = session({ lockedLayerIds: ["a"] });
    assert.equal(collaborationCanEdit(guest), true);
    assert.equal(collaborationCanEditLayer(guest, "a"), false);
    assert.equal(collaborationCanEditLayer(guest, "b"), true);
  });

  it("a view-mode guest edits nothing unless the host granted an override", () => {
    const viewer = session({ mode: "view-only" });
    assert.equal(collaborationCanEdit(viewer), false);
    assert.equal(collaborationCanEditLayer(viewer, "b"), false);
    const granted = session({
      mode: "view-only",
      participants: [{ clientId: "me", role: "guest", editOverride: true }] as never,
    });
    assert.equal(collaborationCanEdit(granted), true);
    assert.equal(collaborationCanEditLayer(granted, "b"), true);
  });

  it("before its own participant row arrives, a guest follows the session mode and locks", () => {
    const early = session({ participants: [], lockedLayerIds: ["a"] });
    assert.equal(collaborationCanEditLayer(early, "a"), false);
    assert.equal(collaborationCanEditLayer(early, "b"), true);
    assert.equal(
      collaborationCanEditLayer(session({ participants: [], mode: "view-only" }), "b"),
      false,
    );
  });
});
