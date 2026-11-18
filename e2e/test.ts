import { test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * How long a page may take to unload. Under SwiftShader a map page takes
 * ~6 s on one core; the cap only keeps a wedged page from holding a passing
 * test open.
 */
const UNLOAD_TIMEOUT_MS = 20_000;

/**
 * Runs in every page before the app: switches MapLibre's 3D terrain off each
 * time its toggle shows it on. 3D terrain is on by default, and drawn by
 * SwiftShader it keeps the CPU busy enough that ordinary clicks took 17-20 s
 * and specs timed out at random. The toggle is clicked from the page
 * (`element.click()`), so focus and the keyboard order specs check do not
 * move. Clicks are spaced wider than the control's 250 ms double-click window,
 * which would otherwise open the exaggeration dialog.
 */
function switchTerrainOffWhenOn(): void {
  const gapMs = 600;
  let lastClick = 0;
  let retryPending = false;
  const check = (): void => {
    const toggle = document.querySelector<HTMLButtonElement>(
      "button.maplibregl-ctrl-terrain.maplibregl-ctrl-terrain-enabled",
    );
    if (!toggle) return;
    const wait = lastClick + gapMs - Date.now();
    if (wait > 0) {
      if (!retryPending) {
        retryPending = true;
        setTimeout(() => {
          retryPending = false;
          check();
        }, wait);
      }
      return;
    }
    lastClick = Date.now();
    toggle.click();
  };
  new MutationObserver(check).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}

/**
 * `@playwright/test`'s `test`, with one change: a passing test's pages are
 * navigated to `about:blank` before Playwright disposes its browser context.
 * Every spec imports `test` from here, not from `@playwright/test`.
 *
 * Disposing a context kills its renderer outright. When that renderer still
 * holds a live software-rendered (SwiftShader) WebGL map, the browser process
 * is left wedged, and the *next* test in the worker pays for it: its
 * `browser.newContext()` took 3 s to over 60 s, all charged to that test's
 * own timeout. That is how a spec fails its first attempt "while setting up
 * context", or runs out of time partway through, and then passes on retry
 * (#2879). Navigating away first lets the page unload in order, a bounded few
 * seconds in the test that owns it, and the next context then opens in ~0.1 s.
 *
 * A failing test is left as it is: Playwright restarts the worker after a
 * failure, so no later test shares its browser, and blanking the page would
 * wipe the failure screenshot and page snapshot.
 *
 * It also switches the default-on 3D terrain off (see `switchTerrainOffWhenOn`).
 * A spec about terrain opts out with `test.use({ flatTerrain: false })`.
 */
export const test = base.extend<{ flatTerrain: boolean }>({
  flatTerrain: [true, { option: true }],
  context: async ({ context, flatTerrain }, use, testInfo) => {
    if (flatTerrain) await context.addInitScript(switchTerrainOffWhenOn);
    await use(context);
    if (testInfo.status !== testInfo.expectedStatus) return;
    // The unload runs after the test body, so give it its own budget rather
    // than failing a test that finished near its timeout.
    // A timeout of 0 means none (`--debug`), which must stay unlimited.
    if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + UNLOAD_TIMEOUT_MS);
    await Promise.all(
      context
        .pages()
        .map((page) =>
          page.goto("about:blank", { timeout: UNLOAD_TIMEOUT_MS }).catch(() => undefined),
        ),
    );
  },
});
