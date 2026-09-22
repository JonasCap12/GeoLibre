/**
 * Guard for dynamic `import()` in the production web build.
 *
 * A dynamic import normally either resolves to a module namespace or rejects.
 * In this app it has a third outcome. {@link installStaleChunkReload} listens
 * for Vite's cancelable `vite:preloadError` and calls `preventDefault()` when it
 * decides not to reload — it defers rather than throwing away unsaved work.
 * Vite's `__vitePreload` helper reads that cancellation as "handled" and lets
 * the import **resolve to `undefined`**.
 *
 * Every call site that destructures or dereferences the result then fails with
 * a message about whatever property it happened to touch first — the user sees
 * `Cannot read properties of undefined (reading 'resolveXyzTileUrlTemplate')`
 * rather than "the app updated, reload the page". `getComponentsConstructors`
 * in `@geolibre/plugins` already guards its own imports this way; this is the
 * same check, in one place, for the rest.
 *
 * Wrap a dynamic import whose failure should be reported to the user:
 *
 * ```ts
 * const { fetchWfsGeoJson } = await loadLazyModule(() => import("./layer-refresh"));
 * ```
 */

import { DEFERRED_RELOAD_MESSAGE } from "./stale-chunk-reload";

/** Thrown when a chunk went missing, so callers can tell it from a real fault. */
export class StaleModuleError extends Error {
  constructor() {
    super(DEFERRED_RELOAD_MESSAGE);
    this.name = "StaleModuleError";
  }
}

/**
 * Await a dynamic import and reject clearly if the chunk could not be loaded.
 *
 * @param load Thunk performing the `import()`. Passed as a thunk, not a
 *   promise, so the bundler still sees a literal `import()` at the call site and
 *   can code-split it.
 * @returns The module namespace, never `undefined`.
 * @throws {StaleModuleError} When the import resolved to `undefined`, which
 *   means the chunk is gone and the page needs reloading.
 */
export async function loadLazyModule<T>(load: () => Promise<T | undefined>): Promise<T> {
  const module = await load();
  if (module === undefined) throw new StaleModuleError();
  return module;
}
