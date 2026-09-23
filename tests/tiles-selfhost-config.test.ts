import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * `workers/tiles/wrangler.selfhost.jsonc` duplicates `wrangler.toml` so this
 * fork can deploy the tiles Worker without the upstream custom domain, and
 * without editing an upstream-tracked file that every sync fast-forwards.
 *
 * Duplication drifts, and here the drift is expensive: this Worker fronts eight
 * browser-facing services. A stale `compatibility_date` changes runtime
 * semantics under the same code, and a missing `cpu_ms` silently drops the /wms
 * reprojection route back to the default budget, where it times out per tile
 * with no error the user can act on.
 */

const TOML_PATH = new URL("../workers/tiles/wrangler.toml", import.meta.url);
const JSONC_PATH = new URL("../workers/tiles/wrangler.selfhost.jsonc", import.meta.url);

/** Strip `//` comments from JSONC, leaving any `//` inside a string intact. */
function parseJsonc(source: string): Record<string, unknown> {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
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
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += char;
  }
  return JSON.parse(out) as Record<string, unknown>;
}

/** Read one `key = "value"` from the TOML. */
function tomlString(source: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(source);
  return match ? match[1] : null;
}

/** Read one `key = 123` from the TOML. */
function tomlNumber(source: string, key: string): number | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m").exec(source);
  return match ? Number(match[1]) : null;
}

const toml = readFileSync(TOML_PATH, "utf8");
const raw = readFileSync(JSONC_PATH, "utf8");
const selfhost = parseJsonc(raw);

describe("tiles self-host config", () => {
  it("deploys the same Worker and entry point", () => {
    assert.equal(selfhost.name, tomlString(toml, "name"));
    assert.equal(selfhost.main, tomlString(toml, "main"));
  });

  it("keeps the upstream compatibility date", () => {
    assert.equal(selfhost.compatibility_date, tomlString(toml, "compatibility_date"));
  });

  it("keeps the raised CPU budget the /wms route needs", () => {
    const limits = selfhost.limits as { cpu_ms?: number } | undefined;
    assert.equal(limits?.cpu_ms, tomlNumber(toml, "cpu_ms"));
  });

  it("omits the upstream custom domain", () => {
    // The whole reason the file exists: tiles.geolibre.app can only be
    // provisioned by the upstream account, and a deploy carrying it fails.
    assert.equal(selfhost.routes, undefined);
    assert.ok(toml.includes("tiles.geolibre.app"));
  });

  it("warns that the CPU budget needs a paid plan", () => {
    // Deploying this on the free tier looks successful and then fails per tile
    // on /wms only. Say so where the operator is reading.
    assert.match(raw, /free tier is capped at 10 ms/);
  });

  it("names the variable that points the app at this deployment", () => {
    // Deploying the Worker changes nothing on its own; the app keeps calling
    // upstream until this is set. That step belongs next to the deploy command.
    assert.ok(raw.includes("VITE_GEOLIBRE_TILES_URL"));
  });

  it("warns that a custom domain breaks the origin-gated routes", () => {
    assert.ok(raw.includes("isAllowedProxyOrigin"));
  });
});
