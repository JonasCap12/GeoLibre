import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { apiScope, signedInRow, worker } from "./helpers/projects-api";

/**
 * `GET /api/datasets/:id/content` is the cheapest way to spend someone else's
 * money in this API. It needs no credentials for a public dataset, streams up
 * to the size cap out of R2 (billed egress) and writes a D1 row to count the
 * download. An id and a loop is the whole attack, and nothing about it looks
 * unusual in a log.
 *
 * The auth limiter could not be reused: it exists to stop scrypt being run as
 * a CPU burn, so its allowance is deliberately tiny, and pointing downloads at
 * it would either throttle a team pulling a project's files or force the auth
 * allowance up to where brute-forcing becomes practical again.
 */

// fileURLToPath, not .pathname: the latter keeps %20 for a space in the path.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const config = readFileSync(`${ROOT}workers/projects-api/wrangler.jsonc`, "utf8");

/** Strip `//` comments so a binding named in prose is not read as a binding. */
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += char;
  }
  return out;
}

const parsed = JSON.parse(stripComments(config)) as {
  ratelimits?: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
};
const limiters = parsed.ratelimits ?? [];

describe("dataset download rate limit", () => {
  it("declares a limiter dedicated to downloads", () => {
    const names = limiters.map((entry) => entry.name);
    assert.ok(names.includes("DOWNLOAD_RATE_LIMITER"), `bindings are ${names.join(", ")}`);
  });

  it("gives each limiter its own namespace", () => {
    // Two bindings sharing a namespace_id share one budget, so downloads would
    // silently consume the allowance protecting the login route. Nothing fails
    // loudly when that happens — the first symptom is users being locked out.
    const ids = limiters.map((entry) => entry.namespace_id);
    assert.equal(new Set(ids).size, ids.length, `namespace ids collide: ${ids.join(", ")}`);
  });

  it("keeps the auth allowance tight and the download allowance workable", () => {
    const auth = limiters.find((entry) => entry.name === "AUTH_RATE_LIMITER");
    const download = limiters.find((entry) => entry.name === "DOWNLOAD_RATE_LIMITER");
    assert.ok(auth && download);
    assert.ok(auth.simple.limit <= 10, "the scrypt routes must stay tightly limited");
    assert.ok(
      download.simple.limit > auth.simple.limit,
      "a download is a normal bulk action; limiting it like a login attempt would break real use",
    );
  });

  it("refuses exhausted downloads before R2 access and uses only the download budget", async () => {
    const h = apiScope({ path: "/api/datasets/ds-1/content" });
    h.db.on("first", /FROM accounts a JOIN tokens/, signedInRow());
    h.scope.request.headers.set("Authorization", "Bearer session-token");
    h.scope.request.headers.set("CF-Connecting-IP", "192.0.2.42");
    const keys: string[] = [];
    let r2Reads = 0;
    let authLimits = 0;
    h.scope.env.DOWNLOAD_RATE_LIMITER = {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    };
    h.scope.env.AUTH_RATE_LIMITER = {
      async limit() {
        authLimits++;
        return { success: false };
      },
    };
    h.scope.env.OBJECTS = {
      async get() {
        r2Reads++;
        throw new Error("R2 must not be read");
      },
    } as unknown as typeof h.scope.env.OBJECTS;
    const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: "too many downloads; retry later" });
    assert.deepEqual(keys, ["download:192.0.2.42"]);
    assert.equal(r2Reads, 0);
    assert.equal(authLimits, 0);
    assert.equal(
      h.db.calls.some((c) => c.sql.startsWith("UPDATE datasets")),
      false,
    );
    await h.drain();
  });
});
