import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isPublicRoute } from "../workers/projects-api/src/public-routes.ts";

/**
 * The Worker entry imports the Workers runtime, so Node cannot load it. The
 * open-or-closed decision lives in public-routes.ts, which this file imports.
 * The source check below only proves index.ts still calls that decision. It
 * cannot catch a route whose path string was renamed inside a handler — that
 * is what the cases here are for.
 */

const OPEN = [
  ["GET", ["health"]],
  ["POST", ["api", "accounts"]],
  ["POST", ["api", "auth", "token"]],
  ["POST", ["api", "auth", "reset-request"]],
  ["POST", ["api", "auth", "reset-confirm"]],
] as const;

const CLOSED = [
  ["DELETE", ["api", "auth", "token"]],
  ["POST", ["api", "auth", "password"]],
  ["POST", ["api", "invites"]],
  ["GET", ["api", "datasets"]],
  ["GET", ["api", "datasets", "ds-1", "content"]],
  ["GET", ["api", "projects"]],
  ["GET", ["surveyor", "span.geolibre.json"]],
  // `as const` the way OPEN above has it: without it each row widens to
  // (string | string[])[] and the method and the segments stop being distinct.
] as const;

describe("projects API public routes", () => {
  for (const [method, segments] of OPEN) {
    it(`leaves ${method} /${segments.join("/")} open`, () => {
      assert.equal(isPublicRoute(method, segments), true);
    });
  }

  for (const [method, segments] of CLOSED) {
    it(`closes ${method} /${segments.join("/")}`, () => {
      assert.equal(isPublicRoute(method, segments), false);
    });
  }

  it("is what the worker calls before dispatch", () => {
    const source = readFileSync(
      new URL("../workers/projects-api/src/index.ts", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("if (!isPublicRoute(method, segments))"));
    assert.equal(source.includes("const account = await optionalAccount"), false);
  });
});
