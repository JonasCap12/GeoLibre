/**
 * Resolves the base URL of the GeoLibre tiles Worker (`workers/tiles`).
 *
 * That Worker fronts eight browser-facing services: the OpenPlanetaryMap tile
 * mosaics, the USGS Astrogeology WMS reprojector, the Protomaps planet range
 * proxy, and the OpenAerialMap, Overpass, Source.coop, CKAN and GitHub-raw
 * proxies. Each call site used to name `https://tiles.geolibre.app` directly,
 * which pinned every deployment to one operator's server: a self-hosted
 * GeoLibre kept sending those requests to someone else's account, could not
 * survive that host going away, and — for the five origin-gated routes — was
 * only served at all because the allowlist there happens to admit
 * `*.workers.dev`. Binding a custom domain silently broke all five.
 *
 * Setting `VITE_GEOLIBRE_TILES_URL` at build time points them at your own
 * deployment of `workers/tiles` instead. Unset, the default is unchanged, so
 * this is inert until a deployment opts in.
 *
 * Read from the *build* environment, never the runtime overlay: a
 * `.geolibre.json` a user opens can set `window.__GEOLIBRE_RUNTIME_ENV__`, and
 * a project file that could retarget a proxy would turn every opened map into
 * a way to make the browser issue requests to an attacker's host under this
 * origin. The auth gate withholds runtime overlay for the same reason.
 */

import { getBuildEnvironment } from "./runtime-env";

/** The build-time variable that retargets the tiles Worker. */
export const TILES_URL_ENV = "VITE_GEOLIBRE_TILES_URL";

/** Where the tiles Worker lives when a build names no other host. */
export const DEFAULT_TILES_BASE_URL = "https://tiles.geolibre.app";

/**
 * Normalize a configured tiles base URL, or return null when unusable.
 *
 * Only `http:` and `https:` are accepted. A bare host, a `javascript:` URL or
 * anything else unparseable falls back to the default rather than producing a
 * tile URL that would fail per-tile with no clear cause.
 *
 * @param raw - The configured value, typically from the build environment.
 * @returns The URL without a trailing slash, or null when it cannot be used.
 */
export function normalizeTilesBaseUrl(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return trimmed.replace(/\/+$/, "");
}

/**
 * The base URL every tiles-Worker client should build its paths from.
 *
 * @param env - Environment record; defaults to the allowlisted build env.
 * @returns The base URL, with no trailing slash.
 */
export function resolveTilesBaseUrl(
  env: Record<string, string | undefined> = getBuildEnvironment(),
): string {
  return normalizeTilesBaseUrl(env[TILES_URL_ENV]) ?? DEFAULT_TILES_BASE_URL;
}

/**
 * Join a tiles-Worker route onto the configured base.
 *
 * @param path - Route path, with or without a leading slash (e.g. `/oam`).
 * @returns The absolute URL of that route.
 */
export function tilesUrl(path: string): string {
  const base = resolveTilesBaseUrl();
  if (!path) return base;
  return path.startsWith("/") ? `${base}${path}` : `${base}/${path}`;
}

/** The build-time variable that replaces the GeoLens sample-server bookmarks. */
export const GEOLENS_SERVERS_ENV = "VITE_GEOLIBRE_GEOLENS_SERVERS";

/** One entry in the GeoLens sample-server dropdown. */
export interface GeoLensServerBookmark {
  /** Shown in the dropdown; the URL is the title text. */
  label: string;
  baseUrl: string;
}

/**
 * Parse the configured GeoLens bookmarks, or return null to keep the defaults.
 *
 * The format is `Label|https://host`, entries separated by commas. The literal
 * `none` yields an empty list, which is how a deployment removes the suggested
 * servers outright rather than replacing them. An entry whose URL is not
 * http(s) is dropped rather than failing the whole list, so one typo does not
 * take the picker down with it.
 *
 * @param raw - The configured value, typically from the build environment.
 * @returns The bookmarks, or null when nothing was configured.
 */
export function parseGeoLensServers(raw: string | undefined): GeoLensServerBookmark[] | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  const parsed: GeoLensServerBookmark[] = [];
  for (const entry of trimmed.split(",")) {
    const separator = entry.indexOf("|");
    if (separator === -1) continue;
    const label = entry.slice(0, separator).trim();
    const baseUrl = normalizeTilesBaseUrl(entry.slice(separator + 1));
    if (!label || baseUrl === null) continue;
    parsed.push({ label, baseUrl });
  }
  return parsed;
}

/**
 * The GeoLens bookmarks this build offers.
 *
 * @param fallback - The bookmarks to use when the build configures none.
 * @param env - Environment record; defaults to the allowlisted build env.
 * @returns The bookmarks to show in the picker.
 */
export function resolveGeoLensServers(
  fallback: readonly GeoLensServerBookmark[],
  env: Record<string, string | undefined> = getBuildEnvironment(),
): readonly GeoLensServerBookmark[] {
  return parseGeoLensServers(env[GEOLENS_SERVERS_ENV]) ?? fallback;
}
