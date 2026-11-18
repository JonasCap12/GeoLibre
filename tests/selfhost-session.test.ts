import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  createSelfHostSession,
  readAccessToken,
} from "../apps/geolibre-desktop/src/lib/selfhost-session";

const baseUrl = "https://app.test";
const access = (token = "short-access") =>
  Response.json({ accessToken: token, expiresAt: new Date(Date.now() + 600000).toISOString() });
const controllers: ReturnType<typeof createSelfHostSession>[] = [];
afterEach(() => {
  for (const session of controllers.splice(0)) session.stop();
});

function setup(fetchImpl: typeof fetch, legacy = "") {
  let token = legacy;
  let expired = 0;
  const doc = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  doc.visibilityState = "hidden";
  const session = createSelfHostSession({
    baseUrl,
    fetchImpl,
    document: doc,
    getToken: () => token,
    setToken: (fresh) => {
      token = fresh;
    },
    onExpired: () => {
      expired++;
    },
    readLegacy: () => legacy,
    clearLegacy: () => {
      legacy = "";
    },
  });
  controllers.push(session);
  return {
    session,
    doc,
    get token() {
      return token;
    },
    get legacy() {
      return legacy;
    },
    get expired() {
      return expired;
    },
    setToken: (fresh: string) => {
      token = fresh;
      session.tokenChanged();
    },
  };
}

describe("web cookie session lifecycle", () => {
  it("boots through refresh with the custom header and same-origin credentials", async () => {
    const h = setup(async (url, init) => {
      assert.equal(url, `${baseUrl}/api/auth/refresh`);
      assert.equal(init?.credentials, "same-origin");
      assert.equal(new Headers(init?.headers).get("X-GeoLibre-Session"), "cookie");
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      return access();
    });
    assert.equal(await h.session.boot(), "short-access");
    assert.equal(h.token, "short-access");
  });

  for (const outcome of ["ok", "401", "network", "503"] as const) {
    it(`migration ${outcome} ${outcome === "network" || outcome === "503" ? "preserves" : "erases"} the legacy bearer`, async () => {
      const h = setup(async (url, init) => {
        assert.equal(url, `${baseUrl}/api/auth/session/adopt`);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer legacy-secret");
        if (outcome === "network") throw new TypeError("offline");
        return outcome === "ok" ? access() : new Response(null, { status: Number(outcome) });
      }, "legacy-secret");
      if (outcome === "network" || outcome === "503") {
        await assert.rejects(h.session.boot());
        assert.equal(h.legacy, "legacy-secret");
        assert.equal(h.expired, 0);
      } else {
        await h.session.boot();
        assert.equal(h.legacy, "");
        assert.equal(h.token, outcome === "ok" ? "short-access" : "");
        assert.equal(h.expired, outcome === "401" ? 1 : 0);
      }
    });
  }

  it("only a refresh 401 signs the user out", async () => {
    for (const status of [401, 403, 429, 503]) {
      const h = setup(async () => new Response(null, { status }));
      if (status === 401) assert.equal(await h.session.boot(), null);
      else await assert.rejects(h.session.boot());
      assert.equal(h.expired, status === 401 ? 1 : 0);
    }
  });

  it("refreshes at 80 percent and again on returning to a near-expired tab", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    let calls = 0;
    const h = setup(async () => {
      calls++;
      return access(`access-${calls}`);
    });
    await h.session.boot();
    t.mock.timers.tick(479999);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await h.session.refresh();
    assert.equal(calls, 2);
    // Simulate background timer throttling by advancing Date without firing timers.
    t.mock.timers.setTime(Date.now() + 500000);
    h.doc.visibilityState = "visible";
    h.doc.dispatchEvent(new Event("visibilitychange"));
    await h.session.refresh();
    assert.equal(calls, 3);
  });

  it("deduplicates concurrent refreshes and ignores responses after sign-out", async () => {
    let resolve!: (response: Response) => void;
    let calls = 0;
    const h = setup(() => {
      calls++;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    h.setToken("old-access");
    const first = h.session.refresh();
    assert.equal(first, h.session.refresh());
    h.setToken("");
    resolve(access("must-not-resurrect"));
    await first;
    assert.equal(calls, 1);
    assert.equal(h.token, "");
  });

  it("never accepts a session bearer in place of an access response", () => {
    assert.throws(() =>
      readAccessToken({ accessToken: undefined, expiresAt: new Date().toISOString() }),
    );
  });
});
