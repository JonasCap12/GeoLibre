import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * `workers/collab/wrangler.selfhost.jsonc` duplicates `wrangler.toml` so this
 * fork can deploy the collaboration Worker without the upstream custom domain,
 * and without editing an upstream-tracked file that every sync fast-forwards.
 *
 * Duplication drifts. The parts that matter are deployed *state*, not
 * preference: the Durable Object binding name, its class name and the migration
 * tag. Rename a class or skip a tag on one side and existing session objects
 * are orphaned — live sessions drop and their history is unreachable. These
 * tests fail the build instead.
 */

const TOML_PATH = new URL("../workers/collab/wrangler.toml", import.meta.url);
const JSONC_PATH = new URL("../workers/collab/wrangler.selfhost.jsonc", import.meta.url);
const WEB_HEADERS_PATH = new URL("../apps/geolibre-desktop/public/_headers", import.meta.url);

/**
 * Strip `//` comments from JSONC.
 *
 * Tracks string state so a `//` inside a value (a URL, say) survives. The
 * config has no block comments, so only line comments are handled.
 */
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

/**
 * Read one `key = "value"` from the TOML.
 *
 * A dependency-free reader is enough here: the file is a handful of top-level
 * keys and array-of-table blocks, and a real TOML parser is not worth adding to
 * the test tree for it.
 */
function tomlString(source: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(source);
  return match ? match[1] : null;
}

/** Read a `key = ["a", "b"]` array from the TOML. */
function tomlStringArray(source: string, key: string): string[] | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(source);
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
}

/**
 * The body of an array-of-tables block, up to the next `[` at line start.
 *
 * Needed because `name` appears both at the top level (the Worker's name) and
 * inside `[[durable_objects.bindings]]` (the binding's); reading the file-wide
 * first match would compare the wrong one and pass for the wrong reason.
 */
function tomlSection(source: string, header: string): string {
  const start = source.indexOf(`[[${header}]]`);
  assert.notEqual(start, -1, `wrangler.toml has no [[${header}]]`);
  const body = source.slice(start + header.length + 4);
  const end = /^\[/m.exec(body);
  return end ? body.slice(0, end.index) : body;
}

const toml = readFileSync(TOML_PATH, "utf8");
const selfhost = parseJsonc(readFileSync(JSONC_PATH, "utf8"));

describe("collab self-host config", () => {
  it("deploys the same Worker and entry point", () => {
    assert.equal(selfhost.name, tomlString(toml, "name"));
    assert.equal(selfhost.main, tomlString(toml, "main"));
  });

  it("keeps the upstream compatibility date", () => {
    assert.equal(selfhost.compatibility_date, tomlString(toml, "compatibility_date"));
  });

  it("binds the same Durable Object class under the same name", () => {
    const binding = tomlSection(toml, "durable_objects.bindings");
    const bindings = (
      selfhost.durable_objects as { bindings: { name: string; class_name: string }[] }
    ).bindings;
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].name, tomlString(binding, "name"));
    assert.equal(bindings[0].class_name, tomlString(binding, "class_name"));
  });

  it("declares the same migration tag and SQLite classes", () => {
    const migration = tomlSection(toml, "migrations");
    const migrations = (selfhost.migrations as { tag: string; new_sqlite_classes: string[] }[])[0];
    assert.equal(migrations.tag, tomlString(migration, "tag"));
    assert.deepEqual(
      migrations.new_sqlite_classes,
      tomlStringArray(migration, "new_sqlite_classes"),
    );
  });

  it("omits the upstream custom domain", () => {
    // The whole reason the file exists: collab.geolibre.app can only be
    // provisioned by the upstream account, and a deploy carrying it fails.
    assert.equal(selfhost.routes, undefined);
    assert.ok(toml.includes("collab.geolibre.app"));
  });

  it("does not hard-code the identity secret", () => {
    // It gates whether sessions require signed identities. A var here would put
    // it in git; it belongs in `wrangler secret put`.
    const raw = readFileSync(JSONC_PATH, "utf8");
    const vars = (selfhost.vars ?? {}) as Record<string, unknown>;
    assert.equal(vars.COLLAB_IDENTITY_SECRET, undefined);
    assert.ok(raw.includes("wrangler secret put COLLAB_IDENTITY_SECRET"));
  });
});

describe("session creation is reachable from this deployment", () => {
  it("names an explicit origin allowlist", () => {
    // The Worker was deployed, VITE_GEOLIBRE_COLLAB_URL was set, and starting a
    // session still failed with 403 "Origin not allowed to create sessions."
    // isAllowedOrigin in src/index.ts falls back to *.geolibre.app, localhost
    // and tauri: when ALLOWED_ORIGINS is unset -- a list this fork is not on.
    // Nothing about the deploy looked wrong, which is why it went unnoticed.
    const vars = (selfhost.vars ?? {}) as Record<string, string>;
    assert.ok(vars.ALLOWED_ORIGINS, "collaboration cannot start without an origin allowlist");
    assert.match(vars.ALLOWED_ORIGINS, /^https:\/\//, "origins must be absolute https URLs");
  });

  it("does not open session creation to every workers.dev site", () => {
    // The tiles Worker admits any *.workers.dev because it fronts public
    // upstreams. This one creates Durable Objects on this account, so the same
    // shortcut would let a stranger's page run up the bill.
    const vars = (selfhost.vars ?? {}) as Record<string, string>;
    const origins = String(vars.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim());
    for (const origin of origins) {
      assert.ok(origin.length > 0, "empty entry in the allowlist");
      assert.ok(!origin.includes("*"), `wildcard origin is not allowed: ${origin}`);
      assert.doesNotThrow(() => new URL(origin), `not a URL: ${origin}`);
    }
  });

  it("allows the self-hosted WebSocket relay in the deployed web CSP", () => {
    const headers = readFileSync(WEB_HEADERS_PATH, "utf8");
    // `https:` in connect-src does not cover WebSockets. The bundle can carry
    // a perfectly valid VITE_GEOLIBRE_COLLAB_URL while the browser blocks every
    // connection before it reaches the relay, which was the production failure.
    assert.ok(
      headers.includes("wss://geolibre-collab.jonasnguyen886.workers.dev"),
      "the web CSP must allow this fork's collaboration relay",
    );
  });
});
