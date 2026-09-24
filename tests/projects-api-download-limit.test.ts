import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

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

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const source = readFileSync(`${ROOT}workers/projects-api/src/index.ts`, "utf8");
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

  it("applies the limiter on the content route, before any R2 read", () => {
    const route = source.indexOf('path[2] === "content" && method === "GET"');
    assert.notEqual(route, -1, "the download route moved; update this test");
    const body = source.slice(route, route + 900);
    const guard = body.indexOf("rateLimitDownload");
    const read = body.indexOf("objects.get");
    assert.notEqual(guard, -1, "the download route is no longer rate-limited");
    assert.ok(guard < read, "the limiter must run before the object is fetched, not after");
  });

  it("does not spend the auth limiter's budget on downloads", () => {
    const helper = source.slice(source.indexOf("async function rateLimitDownload"));
    assert.ok(
      helper.includes("env.DOWNLOAD_RATE_LIMITER"),
      "downloads must use their own binding",
    );
    assert.ok(
      !helper.slice(0, 400).includes("AUTH_RATE_LIMITER"),
      "downloads must not fall back to the auth binding",
    );
  });
});
