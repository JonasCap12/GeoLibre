import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_LANGUAGE_PACK_BASE_URL,
  languagePackBaseUrl,
} from "../apps/geolibre-desktop/src/lib/language-pack";

/**
 * The last two ties to the upstream project's servers that a variable alone
 * could not cut.
 *
 * Whitebox translation downloads had no "off": an empty
 * `VITE_LANGUAGE_PACK_BASE_URL` falls through to the default host, so the only
 * way to stop the traffic was `GEOLIBRE_NO_EXTERNAL_CDN`, which also strips
 * Pyodide and the 3D Tiles decoders. `none` turns off just this one thing.
 *
 * The plugin registry needed no code change — its URL already resolves against
 * the app's own origin — but it did need a file to point at.
 */

describe("language pack host", () => {
  it("falls back to the upstream host when unset", () => {
    assert.equal(languagePackBaseUrl({}), DEFAULT_LANGUAGE_PACK_BASE_URL);
  });

  it("still falls back on an empty value, as it always did", () => {
    // Worth pinning: an operator who "blanks" the variable expecting the
    // feature off would otherwise keep sending traffic upstream and never know.
    assert.equal(
      languagePackBaseUrl({ VITE_LANGUAGE_PACK_BASE_URL: "   " }),
      DEFAULT_LANGUAGE_PACK_BASE_URL,
    );
  });

  it("turns downloads off for `none`", () => {
    // SettingsDialog gates the whole download UI on this being "".
    assert.equal(languagePackBaseUrl({ VITE_LANGUAGE_PACK_BASE_URL: "none" }), "");
    assert.equal(languagePackBaseUrl({ VITE_LANGUAGE_PACK_BASE_URL: " NONE " }), "");
  });

  it("uses a self-hosted host, without a trailing slash", () => {
    assert.equal(
      languagePackBaseUrl({ VITE_LANGUAGE_PACK_BASE_URL: "https://packs.example.com//" }),
      "https://packs.example.com",
    );
  });
});

describe("self-hosted plugin registry", () => {
  it("ships a registry the app can serve from its own origin", () => {
    // VITE_GEOLIBRE_PLUGIN_REGISTRY_URL resolves relative values against
    // window.location, so "/plugin-registry.json" reads this file rather than
    // plugins.geolibre.app. The loader rejects a non-array payload.
    const raw = readFileSync(
      new URL("../apps/geolibre-desktop/public/plugin-registry.json", import.meta.url),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    assert.ok(Array.isArray(parsed), "registry must be a JSON array");
  });
});
