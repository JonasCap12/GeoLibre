/**
 * Where this deployment's own viewer lives.
 *
 * Two features hand a URL to someone else: the HTML export embeds the viewer in
 * the file it writes, and the desktop build's "Copy link" for a Whitebox tool
 * cannot share its own `tauri://` origin. Both used to name the upstream
 * project's web app, so a self-hosted GeoLibre produced links into a deployment
 * that holds none of its data and none of its configuration.
 *
 * Split out of `html-export.ts` so `whitebox-tool-url.ts` can resolve the same
 * value without importing that module's `fflate` dependency chain, and so the
 * two cannot drift into separate validation rules. `html-export.ts` re-exports
 * both names, which is where callers and tests already reach for them.
 */

import { getBuildEnvironment } from "@geolibre/core";

/** Hosted viewer used as the default embed target (matches Python's default). */
export const DEFAULT_VIEWER_BASE_URL = "https://web.geolibre.app/";

/**
 * Resolve the viewer URL from the env, accepting only HTTPS (or loopback HTTP)
 * and matching the hostname exactly; mirrors resolveShareBaseUrl.
 *
 * @param configured - The configured value; defaults to the build env.
 * @returns The viewer base URL, or the default when unset or unusable.
 */
export function resolveViewerBaseUrl(
  configured: unknown = getBuildEnvironment().VITE_GEOLIBRE_VIEWER_URL,
): string {
  if (typeof configured === "string" && configured.trim()) {
    const trimmed = configured.trim();
    try {
      const url = new URL(trimmed);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))
      ) {
        return trimmed;
      }
    } catch {
      // Invalid URL; fall through to the production default.
    }
  }
  return DEFAULT_VIEWER_BASE_URL;
}
