import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installSessionWatch } from "../apps/geolibre-desktop/src/lib/session-watch";
import {
  getShareFetch,
  resetShareFetch,
  setShareFetch,
} from "../apps/geolibre-desktop/src/lib/share-fetch";

/**
 * Tokens expire and can be revoked from elsewhere. When the saved one stops
 * working the gate must notice and show the sign-in page, but a 401 for some
 * other reason (a mistyped current password) must not sign anyone out.
 */

const BASE = "https://api.example.test";

function scripted(statusFor: (url: string, auth: string | null) => number) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const auth = new Headers(init.headers).get("Authorization");
    calls.push(`${init.method ?? "GET"} ${url}`);
    return new Response("{}", { status: statusFor(url, auth) });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("installSessionWatch", () => {
  afterEach(() => resetShareFetch());

  it("clears the token once the server confirms it is gone", async () => {
    const { impl, calls } = scripted(() => 401);
    setShareFetch(impl);
    const expired: string[] = [];
    installSessionWatch({
      baseUrl: BASE,
      getToken: () => "tok",
      onExpired: (t) => expired.push(t),
    });
    await getShareFetch()(`${BASE}/api/projects`, { headers: { Authorization: "Bearer tok" } });
    await settle();
    assert.deepEqual(expired, ["tok"]);
    assert.equal(calls.at(-1), `GET ${BASE}/api/account`);
  });

  it("keeps the token when the 401 was about something else", async () => {
    // POST /api/auth/password answers 401 for a wrong current password.
    const { impl } = scripted((url) => (url.endsWith("/api/account") ? 200 : 401));
    setShareFetch(impl);
    const expired: string[] = [];
    installSessionWatch({
      baseUrl: BASE,
      getToken: () => "tok",
      onExpired: (t) => expired.push(t),
    });
    await getShareFetch()(`${BASE}/api/auth/password`, {
      method: "POST",
      headers: { Authorization: "Bearer tok" },
    });
    await settle();
    assert.deepEqual(expired, []);
  });

  it("ignores 401s that did not carry the saved token, or went elsewhere", async () => {
    const { impl, calls } = scripted(() => 401);
    setShareFetch(impl);
    const expired: string[] = [];
    installSessionWatch({
      baseUrl: BASE,
      getToken: () => "tok",
      onExpired: (t) => expired.push(t),
    });
    // A failed sign-in has no bearer at all.
    await getShareFetch()(`${BASE}/api/auth/token`, { method: "POST" });
    await getShareFetch()("https://tiles.example.test/x", {
      headers: { Authorization: "Bearer tok" },
    });
    await settle();
    assert.deepEqual(expired, []);
    assert.equal(calls.length, 2, "no verification request was made");
  });

  it("does not sign out when offline", async () => {
    let first = true;
    const impl = (async () => {
      if (first) {
        first = false;
        return new Response("{}", { status: 401 });
      }
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    setShareFetch(impl);
    const expired: string[] = [];
    installSessionWatch({
      baseUrl: BASE,
      getToken: () => "tok",
      onExpired: (t) => expired.push(t),
    });
    await getShareFetch()(`${BASE}/api/projects`, { headers: { Authorization: "Bearer tok" } });
    await settle();
    assert.deepEqual(expired, []);
  });

  it("restores the previous fetch on uninstall", () => {
    const { impl } = scripted(() => 200);
    setShareFetch(impl);
    const uninstall = installSessionWatch({
      baseUrl: BASE,
      getToken: () => "tok",
      onExpired: () => {},
    });
    assert.notEqual(getShareFetch(), impl);
    uninstall();
    assert.equal(getShareFetch(), impl);
  });
});
