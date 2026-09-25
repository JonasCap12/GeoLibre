import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DATASET_LIST_WHERE_VISIBILITY,
  datasetJson,
  datasetKey,
  datasetListedFor,
  datasetVisibility,
  type DatasetRow,
  ownedDataset,
  safeContentType,
  safeFilename,
  visibleDataset,
} from "../workers/projects-api/src/datasets.ts";
import type { Config } from "../workers/projects-api/src/model.ts";

const CONFIG = {
  baseUrl: "https://api.example.test",
  viewerUrl: "https://app.example.test/",
  maxProjectBytes: 1,
  maxThumbnailBytes: 1,
  maxDatasetBytes: 1,
  activityRetentionDays: 90,
  corsOrigins: [],
} satisfies Config;

const row = (over: Partial<DatasetRow> = {}): DatasetRow => ({
  id: "abc",
  owner_id: "owner-1",
  name: "Drawing",
  description: "",
  filename: "drawing.dxf",
  content_type: "image/vnd.dxf",
  size_bytes: 10,
  object_key: "datasets/abc/content",
  visibility: "public",
  downloads: 0,
  created_at: "2026-09-22T00:00:00Z",
  updated_at: "2026-09-22T00:00:00Z",
  owner_username: "nhut",
  ...over,
});

describe("safeFilename", () => {
  it("keeps an ordinary name", () => {
    assert.equal(safeFilename("BL-LK testHeMet.dxf"), "BL-LK testHeMet.dxf");
  });

  it("strips directory components", () => {
    // The R2 key is built from the id alone, so this cannot escape a prefix —
    // but a stored value that still LOOKS like a path would mislead a client
    // that joins it onto a directory of its own.
    assert.equal(safeFilename("../../etc/passwd"), "passwd");
    assert.equal(safeFilename("C:\\Users\\nhut\\drawing.dxf"), "drawing.dxf");
  });

  it("removes control characters", () => {
    assert.equal(safeFilename("a\u0000b\u001fc.txt"), "abc.txt");
  });

  it("falls back for a name that reduces to nothing", () => {
    assert.equal(safeFilename(""), "dataset");
    assert.equal(safeFilename("   "), "dataset");
    assert.equal(safeFilename("/"), "dataset");
  });

  it("bounds the length", () => {
    assert.equal(safeFilename("x".repeat(500)).length, 200);
  });
});

describe("safeContentType", () => {
  it("keeps a normal type and drops its parameters", () => {
    assert.equal(safeContentType("application/geo+json; charset=utf-8"), "application/geo+json");
  });

  it("lowercases", () => {
    assert.equal(safeContentType("IMAGE/PNG"), "image/png");
  });

  // The content endpoint serves from the API origin. A stored HTML document
  // (or an SVG, which can carry script) would otherwise run as same-origin
  // script against the API. These are neutralized rather than rejected, so a
  // legitimately named file still uploads.
  it("neutralizes types that could execute on the API origin", () => {
    assert.equal(safeContentType("text/html"), "application/octet-stream");
    assert.equal(safeContentType("text/html; charset=utf-8"), "application/octet-stream");
    assert.equal(safeContentType("image/svg+xml"), "application/octet-stream");
    assert.equal(safeContentType("application/xhtml+xml"), "application/octet-stream");
  });

  it("rejects a malformed type", () => {
    assert.equal(safeContentType("notatype"), "application/octet-stream");
    assert.equal(safeContentType("a/b/c"), "application/octet-stream");
    assert.equal(safeContentType(""), "application/octet-stream");
    assert.equal(safeContentType(null), "application/octet-stream");
  });
});

describe("datasetVisibility", () => {
  it("defaults to team, not the open internet", () => {
    // Public used to be the silent default. A survey drawing uploaded without
    // a choice was then readable by anyone who knew the API hostname.
    assert.equal(datasetVisibility(undefined), "team");
    assert.equal(datasetVisibility(null), "team");
    assert.equal(datasetVisibility(""), "team");
  });

  it("accepts public, team, and private", () => {
    assert.equal(datasetVisibility("public"), "public");
    assert.equal(datasetVisibility("team"), "team");
    assert.equal(datasetVisibility("private"), "private");
  });

  it("rejects anything else rather than silently sharing it", () => {
    // "unlisted" is valid for a project but meaningless here, and treating an
    // unknown value as public would leak a file the uploader meant to keep.
    assert.throws(() => datasetVisibility("unlisted"), /public, team, or private/);
    assert.throws(() => datasetVisibility("PUBLIC"), /public, team, or private/);
  });
});

describe("visibleDataset", () => {
  it("shows a public dataset to anyone", () => {
    assert.equal(visibleDataset(row(), null).id, "abc");
  });

  it("hides a team dataset from an anonymous caller", () => {
    // 404, not 403: the status must not confirm the file exists.
    assert.throws(() => visibleDataset(row({ visibility: "team" }), null), /not found/);
  });

  it("shows a team dataset to any signed-in account", () => {
    assert.equal(visibleDataset(row({ visibility: "team" }), "someone-else").id, "abc");
    assert.equal(visibleDataset(row({ visibility: "team" }), "owner-1").id, "abc");
  });

  it("shows a private dataset to its owner", () => {
    assert.equal(visibleDataset(row({ visibility: "private" }), "owner-1").id, "abc");
  });

  it("reports a private dataset as missing, not forbidden", () => {
    // A 403 would confirm the dataset exists; 404 reveals nothing.
    assert.throws(() => visibleDataset(row({ visibility: "private" }), "someone-else"), /not found/);
    assert.throws(() => visibleDataset(row({ visibility: "private" }), null), /not found/);
  });

  it("reports a missing row the same way", () => {
    assert.throws(() => visibleDataset(null, "owner-1"), /not found/);
  });
});

describe("ownedDataset", () => {
  it("returns the row to its owner", () => {
    assert.equal(ownedDataset(row(), "owner-1").id, "abc");
  });

  it("refuses a non-owner", () => {
    assert.throws(() => ownedDataset(row(), "someone-else"), /ownership required/);
  });

  it("404s a missing row", () => {
    assert.throws(() => ownedDataset(null, "owner-1"), /not found/);
  });
});

describe("datasetJson", () => {
  it("builds an absolute content URL", () => {
    const json = datasetJson(row(), CONFIG);
    assert.equal(json.contentUrl, "https://api.example.test/datasets/abc/content");
  });

  it("uses camelCase keys, matching the rest of the API", () => {
    const json = datasetJson(row(), CONFIG);
    assert.equal(json.sizeBytes, 10);
    assert.equal(json.contentType, "image/vnd.dxf");
    assert.equal(json.createdAt, "2026-09-22T00:00:00Z");
    assert.equal(json.owner, "nhut");
  });

  it("never exposes the storage key or the owner's id", () => {
    const json = datasetJson(row(), CONFIG);
    assert.equal(json.object_key, undefined);
    assert.equal(json.owner_id, undefined);
  });
});

describe("dataset listing", () => {
  it("reuses the already-bound account id", () => {
    assert.match(DATASET_LIST_WHERE_VISIBILITY, /\?1 IS NOT NULL/);
    assert.match(DATASET_LIST_WHERE_VISIBILITY, /d\.owner_id = \?1/);
    assert.equal(DATASET_LIST_WHERE_VISIBILITY.includes("?6"), false);
  });

  it("admits a team row for a signed-in caller and excludes it anonymously", () => {
    assert.equal(datasetListedFor("team", "owner-1", "colleague"), true);
    assert.equal(datasetListedFor("team", "owner-1", null), false);
  });

  it("still lists a public row for an anonymous caller", () => {
    assert.equal(datasetListedFor("public", "owner-1", null), true);
  });

  it("still lists a private row only for its owner", () => {
    assert.equal(datasetListedFor("private", "owner-1", "owner-1"), true);
    assert.equal(datasetListedFor("private", "owner-1", "colleague"), false);
    assert.equal(datasetListedFor("private", "owner-1", null), false);
  });
});

describe("datasetKey", () => {
  it("derives the key from the id alone", () => {
    // Deliberately independent of the filename, so no uploaded name can steer
    // where bytes land in the bucket.
    assert.equal(datasetKey("abc"), "datasets/abc/content");
  });
});
