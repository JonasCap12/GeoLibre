import {
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { createElement } from "react";

const { SelfHostGate } = await import("../apps/geolibre-desktop/src/components/auth/SelfHostGate");
const { serializeDesktopSettingsForStorage, useDesktopSettingsPersistence } =
  await import("../apps/geolibre-desktop/src/hooks/useDesktopSettings");
const { DESKTOP_SETTINGS_STORAGE_KEY } =
  await import("../apps/geolibre-desktop/src/lib/storage-keys");
const { resetCapturedSelfHostRoute } =
  await import("../apps/geolibre-desktop/src/lib/selfhost-routes");
const { sessionCookieMode } =
  await import("../apps/geolibre-desktop/src/lib/selfhost-session-mode");
const { resolveShareBaseUrl } = await import("../apps/geolibre-desktop/src/lib/share-geolibre");
const { signOut } = await import("../apps/geolibre-desktop/src/lib/share-account");
const t = i18n.t.bind(i18n);
const globals = window as unknown as {
  __GEOLIBRE_DEPLOYMENT_ENV__?: Record<string, string>;
  __TAURI_INTERNALS__?: object;
};
beforeEach(() => {
  globals.__GEOLIBRE_DEPLOYMENT_ENV__ = { VITE_GEOLIBRE_SESSION_COOKIE: "1" };
});
afterEach(() => {
  delete globals.__GEOLIBRE_DEPLOYMENT_ENV__;
  delete globals.__TAURI_INTERNALS__;
  resetCapturedSelfHostRoute();
});
const access = () =>
  Response.json({
    accessToken: "short-access",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
const account = () =>
  Response.json({
    account: { id: "owner", username: "surveyor", email: "a@example.com", mfaEnabled: true },
  });
function App() {
  useDesktopSettingsPersistence(); // Real persistence effect, including its initial write.
  return createElement(SelfHostGate, { children: createElement("p", null, "private app") });
}

it("shows loading without a sign-in flash, then restores a valid cookie", async () => {
  let finish!: (response: Response) => void;
  mockFetch(async (url) =>
    String(url).endsWith("/api/auth/refresh")
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : account(),
  );
  render(createElement(App));
  assert.ok(screen.getByText(t("auth.sessionLoading")));
  assert.equal(screen.queryByLabelText(t("auth.usernameOrEmail")), null);
  finish(access());
  await screen.findByText("private app");
  assert.equal(useDesktopSettingsStore.getState().desktopSettings.shareToken, "short-access");
  assert.equal(
    JSON.parse(window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)!).shareToken,
    "",
  );
});

it("shows sign-in only after refresh confirms there is no session", async () => {
  mockFetch(async () => new Response(null, { status: 401 }));
  render(createElement(App));
  await screen.findByLabelText(t("auth.usernameOrEmail"));
  assert.equal(screen.queryByText("private app"), null);
  // A first visit has no session to have ended.
  assert.equal(screen.queryByText(t("auth.sessionEnded")), null);
});

it("tells the user only when a session ends after it was restored", async () => {
  let refreshes = 0;
  mockFetch(async (url) => {
    if (String(url).endsWith("/api/auth/refresh")) {
      refreshes++;
      return refreshes === 1 ? access() : new Response(null, { status: 401 });
    }
    // The access token is refused, so session-watch asks refresh, which 401s.
    return new Response(null, { status: 401 });
  });
  render(createElement(App));
  await screen.findByText("private app");
  const { getShareFetch } = await import("../apps/geolibre-desktop/src/lib/share-fetch");
  await getShareFetch()(`${window.location.origin}/api/projects`, {
    headers: { Authorization: "Bearer short-access" },
  });
  await screen.findByText(t("auth.sessionEnded"));
  assert.equal(useDesktopSettingsStore.getState().desktopSettings.shareToken, "");
});

it("does not restart the session when the language changes", async () => {
  let refreshes = 0;
  mockFetch(async (url) => {
    if (String(url).endsWith("/api/auth/refresh")) {
      refreshes++;
      return access();
    }
    return account();
  });
  render(createElement(App));
  await screen.findByText("private app");
  const before = i18n.language;
  await i18n.changeLanguage(before === "vi" ? "en" : "vi");
  await i18n.changeLanguage(before);
  assert.equal(screen.queryByText(t("auth.sessionLoading")), null);
  assert.equal(refreshes, 1);
});

it("keeps saving other settings while a failed migration keeps the old bearer for next boot", async () => {
  const state = useDesktopSettingsStore.getState();
  state.setDesktopSettings({ ...state.desktopSettings, shareToken: "legacy-session" });
  window.localStorage.setItem(
    DESKTOP_SETTINGS_STORAGE_KEY,
    JSON.stringify({ ...state.desktopSettings, shareToken: "legacy-session" }),
  );
  mockFetch(async () => {
    throw new TypeError("offline");
  });
  render(createElement(App));
  await screen.findByText(t("auth.sessionUnavailable"));
  const current = useDesktopSettingsStore.getState();
  current.setDesktopSettings({ ...current.desktopSettings, foldedPluginMenus: ["kept"] });
  await waitFor(() => {
    const saved = JSON.parse(window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)!);
    assert.deepEqual(saved.foldedPluginMenus, ["kept"]);
    assert.equal(saved.shareToken, "legacy-session");
  });
});

for (const outcome of ["ok", "401", "network"] as const) {
  it(`boot adoption ${outcome} preserves the expected storage and UI`, async () => {
    const state = useDesktopSettingsStore.getState();
    state.setDesktopSettings({ ...state.desktopSettings, shareToken: "legacy-session" });
    window.localStorage.setItem(
      DESKTOP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...state.desktopSettings, shareToken: "legacy-session" }),
    );
    mockFetch(async (url, init) => {
      if (String(url).endsWith("/api/auth/session/adopt")) {
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer legacy-session");
        assert.equal(
          JSON.parse(window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)!).shareToken,
          "legacy-session",
        );
        if (outcome === "network") throw new TypeError("offline");
        return outcome === "401" ? new Response(null, { status: 401 }) : access();
      }
      return account();
    });
    render(createElement(App));
    if (outcome === "ok") await screen.findByText("private app");
    if (outcome === "401") await screen.findByLabelText(t("auth.usernameOrEmail"));
    if (outcome === "network") {
      await screen.findByText(t("auth.sessionUnavailable"));
      assert.equal(screen.queryByLabelText(t("auth.usernameOrEmail")), null);
      assert.equal(screen.queryByText("private app"), null);
    }
    assert.equal(
      JSON.parse(window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY)!).shareToken,
      outcome === "network" ? "legacy-session" : "",
    );
  });
}

it("persists no access credential and leaves the native and flag-off modes unchanged", () => {
  const settings = { ...useDesktopSettingsStore.getState().desktopSettings, shareToken: "secret" };
  assert.equal(JSON.parse(serializeDesktopSettingsForStorage(settings)).shareToken, "");
  assert.equal(resolveShareBaseUrl(), window.location.origin);
  globals.__TAURI_INTERNALS__ = {};
  assert.equal(sessionCookieMode(), false);
  delete globals.__TAURI_INTERNALS__;
  globals.__GEOLIBRE_DEPLOYMENT_ENV__ = {};
  assert.equal(sessionCookieMode(), false);
  assert.equal(JSON.parse(serializeDesktopSettingsForStorage(settings)).shareToken, "secret");
});

it("sends cookie sign-out to the same origin and waits for the server before clearing memory", async () => {
  let finish!: (response: Response) => void;
  mockFetch(async (url, init) => {
    assert.equal(url, `${window.location.origin}/api/auth/token`);
    assert.equal(init?.method, "DELETE");
    assert.equal(init?.credentials, "same-origin");
    assert.equal(new Headers(init?.headers).get("X-GeoLibre-Session"), "cookie");
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  let cleared = false;
  const done = signOut({ token: "access" }).then(() => {
    cleared = true;
  });
  assert.equal(cleared, false);
  finish(new Response(null, { status: 204 }));
  await done;
  assert.equal(cleared, true);
});

it("can retry restoring a session after the network returns", async () => {
  let offline = true;
  mockFetch(async (url) => {
    if (String(url).endsWith("/api/auth/refresh")) {
      if (offline) throw new TypeError("offline");
      return access();
    }
    return account();
  });
  render(createElement(App));
  await screen.findByText(t("auth.sessionUnavailable"));
  offline = false;
  fireEvent.click(screen.getByRole("button", { name: t("auth.retry") }));
  await waitFor(() => assert.ok(screen.getByText("private app")));
});
