import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

/**
 * Guards this fork's independence from the upstream project's servers.
 *
 * Every `*.geolibre.app` host in the source is one of two things: a link a
 * human clicks, or an endpoint the app calls on its own. The second kind is a
 * live dependency on a Cloudflare account this deployment does not control —
 * it stops working when that account does, and for the origin-gated tiles
 * routes it only works at all because the upstream allowlist happens to admit
 * `*.workers.dev`.
 *
 * Those endpoints are now each reachable through a build-time variable. The
 * failure this file exists to catch is a *new* hardcoded endpoint arriving
 * later — from a feature, or from an upstream merge — because nothing about it
 * looks wrong in review and nothing fails at runtime until the day it does.
 *
 * Adding a host here is deliberate: either give it an override variable and
 * list it under SERVICE_DEFAULTS, or confirm it is a link and list it under
 * DOCUMENTATION_LINKS.
 */

const ROOTS = [
  "apps/geolibre-desktop/src",
  "packages/core/src",
  "packages/plugins/src",
  "packages/map/src",
  "packages/ui/src",
  "packages/embed/src",
];

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * Endpoints the app calls on its own. Each must name the variable that
 * retargets it *in the same file*, so the default and its escape hatch cannot
 * drift apart or be silently deleted.
 */
const SERVICE_DEFAULTS: Record<string, string> = {
  "packages/core/src/tiles-base.ts": "VITE_GEOLIBRE_TILES_URL",
  "packages/plugins/src/plugins/maplibre-geolens.ts": "VITE_GEOLIBRE_GEOLENS_SERVERS",
  "apps/geolibre-desktop/src/lib/language-pack.ts": "VITE_LANGUAGE_PACK_BASE_URL",
  "apps/geolibre-desktop/src/lib/plugin-registry.ts": "VITE_GEOLIBRE_PLUGIN_REGISTRY_URL",
  "apps/geolibre-desktop/src/lib/share-geolibre.ts": "VITE_GEOLIBRE_SHARE_URL",
  "apps/geolibre-desktop/src/lib/viewer-base-url.ts": "VITE_GEOLIBRE_VIEWER_URL",
  "apps/geolibre-desktop/src/lib/whitebox-tool-url.ts": "VITE_GEOLIBRE_VIEWER_URL",
};

/**
 * Hosts a human reaches by clicking, plus strings that merely *name* a host
 * (a search keyword, an error message, a placeholder, a schema identifier).
 * None of these causes the app to fetch from the upstream project.
 */
const DOCUMENTATION_LINKS = new Set([
  "apps/geolibre-desktop/src/components/layout/AboutDialog.tsx",
  "apps/geolibre-desktop/src/components/layout/ManagePluginsDialog.tsx",
  "apps/geolibre-desktop/src/components/layout/NoServiceWorkerBanner.tsx",
  "apps/geolibre-desktop/src/components/layout/ShareProjectDialog.tsx",
  "apps/geolibre-desktop/src/components/layout/TopToolbar.tsx",
  "apps/geolibre-desktop/src/components/layout/toolbar/constants.ts",
  "apps/geolibre-desktop/src/components/processing/model-builder/ModelBuilderPanel.tsx",
  "apps/geolibre-desktop/src/lib/geolens-fetch.ts",
  "apps/geolibre-desktop/src/lib/updates.ts",
]);

/** Every source file under the roots, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) {
        out.push(relative(REPO_ROOT, full).split(sep).join("/"));
      }
    }
  };
  for (const root of ROOTS) walk(join(REPO_ROOT, root));
  return out;
}

/**
 * Strip line and block comments so a host named in prose does not read as a
 * call site. Tracks string state so a `//` inside a URL literal survives.
 */
function stripComments(source: string): string {
  let out = "";
  let inString: string | null = null;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  return out;
}

const files = sourceFiles();
const withHost = files.filter((file) =>
  /geolibre\.app/.test(stripComments(readFileSync(join(REPO_ROOT, file), "utf8"))),
);

describe("upstream independence", () => {
  it("scans a source tree that actually exists", () => {
    // A path typo above would silently scan nothing and pass everything.
    assert.ok(files.length > 500, `expected a full source tree, walked ${files.length} files`);
  });

  it("has no unreviewed geolibre.app host in source", () => {
    const known = new Set([...Object.keys(SERVICE_DEFAULTS), ...DOCUMENTATION_LINKS]);
    const unexpected = withHost.filter((file) => !known.has(file));
    assert.deepEqual(
      unexpected,
      [],
      `New geolibre.app reference(s). Give the endpoint an override variable and add it to ` +
        `SERVICE_DEFAULTS, or confirm it is a link and add it to DOCUMENTATION_LINKS:\n` +
        unexpected.join("\n"),
    );
  });

  it("keeps every service default beside the variable that overrides it", () => {
    for (const [file, variable] of Object.entries(SERVICE_DEFAULTS)) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      assert.ok(
        source.includes(variable),
        `${file} hardcodes an upstream endpoint but no longer names ${variable}`,
      );
    }
  });

  it("allowlists no file that has stopped referencing the host", () => {
    // A stale entry would keep passing while hiding a real regression later.
    const present = new Set(withHost);
    for (const file of Object.keys(SERVICE_DEFAULTS)) {
      assert.ok(present.has(file), `${file} no longer references geolibre.app; drop its entry`);
    }
    for (const file of DOCUMENTATION_LINKS) {
      assert.ok(present.has(file), `${file} no longer references geolibre.app; drop its entry`);
    }
  });

  it("routes every tiles-Worker service through the shared resolver", () => {
    // The eight browser-facing tiles routes are the dependency that matters:
    // one variable moves them all, but only while they all go through it.
    const callers = [
      "packages/core/src/ellipsoids.ts",
      "packages/plugins/src/plugins/maplibre-openaerialmap.ts",
      "packages/plugins/src/plugins/osm-downloader-api.ts",
      "packages/plugins/src/plugins/source-coop-api.ts",
      "packages/plugins/src/plugins/maplibre-open-data-catalogs.ts",
      "apps/geolibre-desktop/src/hooks/usePlugins.ts",
      "apps/geolibre-desktop/src/components/layout/BasemapExtractPanel.tsx",
    ];
    for (const file of callers) {
      const source = stripComments(readFileSync(join(REPO_ROOT, file), "utf8"));
      assert.ok(source.includes("tilesUrl("), `${file} no longer builds its URL from tilesUrl()`);
      assert.ok(
        !/["'`]https:\/\/tiles\.geolibre\.app/.test(source),
        `${file} hardcodes the upstream tiles host again`,
      );
    }
  });
});
