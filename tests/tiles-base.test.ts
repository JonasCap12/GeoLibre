import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TILES_BASE_URL,
  GEOLENS_SERVERS_ENV,
  TILES_URL_ENV,
  normalizeTilesBaseUrl,
  parseGeoLensServers,
  resolveGeoLensServers,
  resolveTilesBaseUrl,
} from "../packages/core/src/tiles-base";

/**
 * `VITE_GEOLIBRE_TILES_URL` is what makes a self-hosted GeoLibre independent of
 * the upstream project's Cloudflare account: one variable retargets eight
 * browser-facing services at once. The failure mode that matters is silence —
 * a value that looks configured but does not take effect leaves every request
 * going to someone else's server, and nothing in the UI says so.
 */

describe("tiles base URL", () => {
  it("falls back to the upstream host when nothing is configured", () => {
    // Deliberate: an unconfigured build must keep working exactly as before,
    // so deploying the code change alone breaks nothing.
    assert.equal(resolveTilesBaseUrl({}), DEFAULT_TILES_BASE_URL);
    assert.equal(resolveTilesBaseUrl({ [TILES_URL_ENV]: undefined }), DEFAULT_TILES_BASE_URL);
    assert.equal(resolveTilesBaseUrl({ [TILES_URL_ENV]: "   " }), DEFAULT_TILES_BASE_URL);
  });

  it("uses a configured host", () => {
    assert.equal(
      resolveTilesBaseUrl({ [TILES_URL_ENV]: "https://tiles.example.workers.dev" }),
      "https://tiles.example.workers.dev",
    );
  });

  it("strips trailing slashes so joined paths never double up", () => {
    assert.equal(
      resolveTilesBaseUrl({ [TILES_URL_ENV]: "https://t.example.com///" }),
      "https://t.example.com",
    );
  });

  it("tolerates surrounding whitespace from a CI variable", () => {
    assert.equal(
      resolveTilesBaseUrl({ [TILES_URL_ENV]: "  https://t.example.com  " }),
      "https://t.example.com",
    );
  });

  it("rejects a non-http scheme rather than building unusable tile URLs", () => {
    for (const bad of ["javascript:alert(1)", "data:text/plain,x", "file:///etc/passwd"]) {
      assert.equal(normalizeTilesBaseUrl(bad), null, bad);
      assert.equal(resolveTilesBaseUrl({ [TILES_URL_ENV]: bad }), DEFAULT_TILES_BASE_URL, bad);
    }
  });

  it("rejects a bare host, which would resolve relative to the app origin", () => {
    assert.equal(normalizeTilesBaseUrl("tiles.example.com"), null);
    assert.equal(normalizeTilesBaseUrl("//tiles.example.com"), null);
  });

  it("keeps a path prefix, for a Worker mounted under a route", () => {
    assert.equal(normalizeTilesBaseUrl("https://example.com/tiles"), "https://example.com/tiles");
  });
});

describe("GeoLens server bookmarks", () => {
  const fallback = [{ label: "Upstream", baseUrl: "https://datasets.example.app" }];

  it("keeps the defaults when nothing is configured", () => {
    assert.deepEqual(resolveGeoLensServers(fallback, {}), fallback);
    assert.deepEqual(resolveGeoLensServers(fallback, { [GEOLENS_SERVERS_ENV]: "" }), fallback);
  });

  it("offers no bookmarks at all for `none`", () => {
    // The point of the escape hatch: a private deployment should be able to
    // suggest nothing rather than suggest a stranger's catalog server.
    assert.deepEqual(resolveGeoLensServers(fallback, { [GEOLENS_SERVERS_ENV]: "none" }), []);
    assert.deepEqual(resolveGeoLensServers(fallback, { [GEOLENS_SERVERS_ENV]: " NONE " }), []);
  });

  it("parses label and URL pairs", () => {
    assert.deepEqual(parseGeoLensServers("Nội bộ|https://a.example.com,Khác|https://b.example.com"), [
      { label: "Nội bộ", baseUrl: "https://a.example.com" },
      { label: "Khác", baseUrl: "https://b.example.com" },
    ]);
  });

  it("drops a malformed entry instead of discarding the whole list", () => {
    assert.deepEqual(parseGeoLensServers("Good|https://a.example.com,broken,Bad|nope"), [
      { label: "Good", baseUrl: "https://a.example.com" },
    ]);
  });

  it("drops an entry with no label, which would render an unnamed option", () => {
    assert.deepEqual(parseGeoLensServers("|https://a.example.com"), []);
  });
});
