import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_SNAPSHOT_BYTES, authorizeSnapshot } from "../packages/collab-core/src/index";
import {
  parseStoredSnapshot,
  parseStoredSessionLog,
  snapshotByteLimit,
} from "../workers/collab/src/session-state";

describe("Durable Object stored session values", () => {
  it("preserves valid snapshots and treats missing or corrupt values as empty", () => {
    for (const raw of [undefined, "", "{broken"]) assert.equal(parseStoredSnapshot(raw), null);
    for (const value of [null, { layers: [], name: "Cầu 日本 🗺️" }, [1, 2], 0]) {
      assert.deepEqual(parseStoredSnapshot(JSON.stringify(value)), value);
    }
  });
  it("accepts legacy log arrays and JSON arrays, and drops invalid log values", () => {
    const log = [{ type: "snapshot", ts: 1, rev: 2, origin: "host" }];
    assert.deepEqual(parseStoredSessionLog(log), log);
    assert.deepEqual(parseStoredSessionLog(JSON.stringify(log)), log);
    for (const raw of [undefined, null, 0, "", "{bad", "{}", "null", "1"]) {
      assert.deepEqual(parseStoredSessionLog(raw), []);
    }
  });
  it("accepts only positive safe integer byte limits and enforces the boundary in UTF-8", () => {
    for (const raw of [undefined, "", "0", "-1", "0.5", "NaN", "Infinity", "9007199254740992"]) {
      assert.equal(snapshotByteLimit(raw), MAX_SNAPSHOT_BYTES);
    }
    assert.equal(snapshotByteLimit(" 256 "), 256);
    const bytes = new TextEncoder().encode('{"name":"日本"}').length;
    const host = { clientId: "h", role: "host" as const, displayName: "Host", color: "#123456" };
    assert.deepEqual(authorizeSnapshot(host, "co-edit", bytes, snapshotByteLimit(String(bytes))), {
      ok: true,
    });
    assert.equal(
      authorizeSnapshot(host, "co-edit", bytes, snapshotByteLimit(String(bytes - 1))).ok,
      false,
    );
  });
});
