import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublicRoute } from "../workers/projects-api/src/public-routes.ts";
import { API_SECURITY_HEADERS } from "../workers/projects-api/src/public-routes";
import { apiScope, worker } from "./helpers/projects-api";

/**
 * Check both the path policy and the actual fetch handler's dispatch.
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

  it("serves health publicly and refuses protected requests without a token", async () => {
    for (const [path, status] of [
      ["/health", 200],
      ["/api/projects", 401],
    ] as const) {
      const h = apiScope({ path, account: null });
      const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
      assert.equal(response.status, status);
      assert.deepEqual(
        await response.json(),
        status === 200
          ? { ok: true, service: "geolibre-server" }
          : { error: "authentication required" },
      );
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
        assert.equal(response.headers.get(name), value);
      }
      assert.equal(h.db.calls.length, 0);
    }
  });

  it("includes security headers on preflight and never caches auth errors", async () => {
    for (const method of ["OPTIONS", "GET"]) {
      const h = apiScope({ path: "/api/auth/sessions", method });
      const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
      assert.equal(response.status, method === "OPTIONS" ? 204 : 401);
      for (const [name, value] of Object.entries(API_SECURITY_HEADERS))
        assert.equal(response.headers.get(name), value);
      if (method === "GET") assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });
});
