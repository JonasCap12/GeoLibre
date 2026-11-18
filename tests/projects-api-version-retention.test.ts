import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_VERSION_LIMIT,
  pruneVersions,
} from "../workers/projects-api/src/version-retention";
import { FakeD1 } from "./helpers/fake-d1";

type Db = Parameters<typeof pruneVersions>[0];

function fakeObjects(log: string[]) {
  return {
    async delete(key: string) {
      log.push(`object ${key}`);
    },
  };
}

describe("projects API version retention", () => {
  it("keeps a modest default history", () => {
    assert.ok(DEFAULT_VERSION_LIMIT >= 3 && DEFAULT_VERSION_LIMIT <= 50);
  });

  it("does nothing while a project has no more versions than it keeps", async () => {
    const db = new FakeD1();
    const log: string[] = [];
    const removed = await pruneVersions(db as unknown as Db, fakeObjects(log), "p1", 10, 10);
    assert.equal(removed, 0);
    assert.equal(db.calls.length, 0);
    assert.deepEqual(log, []);
  });

  it("removes every version older than the newest `keep`, rows before objects", async () => {
    const log: string[] = [];
    const db = new FakeD1().on("all", /DELETE FROM versions/, (call: { bindings: unknown[] }) => {
      log.push(`rows ${call.bindings.join(",")}`);
      return [
        { object_key: "projects/p1/versions/1.json" },
        { object_key: "projects/p1/versions/2.json" },
      ];
    });
    const removed = await pruneVersions(db as unknown as Db, fakeObjects(log), "p1", 12, 10);
    assert.equal(removed, 2);
    const call = db.calls[0];
    assert.match(
      call.sql,
      /DELETE FROM versions WHERE project_id = \? AND number <= \? RETURNING object_key/,
    );
    // Versions 3..12 stay: the cutoff is newest - keep.
    assert.deepEqual(call.bindings, ["p1", 2]);
    assert.deepEqual(log, [
      "rows p1,2",
      "object projects/p1/versions/1.json",
      "object projects/p1/versions/2.json",
    ]);
  });

  it("still removes the other objects when one delete fails, then reports it", async () => {
    const db = new FakeD1().on("all", /DELETE FROM versions/, [
      { object_key: "a" },
      { object_key: "b" },
    ]);
    const deleted: string[] = [];
    const objects = {
      async delete(key: string) {
        if (key === "a") throw new Error("R2 down");
        deleted.push(key);
      },
    };
    await assert.rejects(pruneVersions(db as unknown as Db, objects, "p1", 20, 10), /R2 down/);
    assert.deepEqual(deleted, ["b"]);
  });

  it("refuses a limit below one, so a misconfiguration cannot delete the latest version", async () => {
    const db = new FakeD1();
    await assert.rejects(
      pruneVersions(db as unknown as Db, fakeObjects([]), "p1", 5, 0),
      /at least 1/,
    );
    assert.equal(db.calls.length, 0);
  });
});
