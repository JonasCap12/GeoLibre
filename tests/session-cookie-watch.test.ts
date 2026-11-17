import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { installSessionWatch } from "../apps/geolibre-desktop/src/lib/session-watch";
import {
  getShareFetch,
  resetShareFetch,
  setShareFetch,
} from "../apps/geolibre-desktop/src/lib/share-fetch";
const baseUrl = "https://app.test";
afterEach(resetShareFetch);

describe("cookie session 401 recovery", () => {
  for (const body of [
    undefined,
    "payload",
    new Blob(["payload"]),
    new ArrayBuffer(2),
    new FormData(),
    new URLSearchParams("a=b"),
  ]) {
    it(`refreshes and retries a replayable ${body?.constructor.name ?? "empty"} body once`, async () => {
      let token = "old";
      let requests = 0;
      setShareFetch(async (input, init) => {
        if (String(input).endsWith("/api/account")) return new Response(null, { status: 401 });
        requests++;
        if (new Headers(init?.headers).get("Authorization") === "Bearer new") {
          assert.equal(init?.body, body);
          return new Response("saved");
        }
        return new Response(null, { status: 401 });
      });
      installSessionWatch({
        baseUrl,
        getToken: () => token,
        onExpired: () => assert.fail("must refresh first"),
        refresh: async () => {
          token = "new";
          return token;
        },
      });
      const response = await getShareFetch()(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: { Authorization: "Bearer old" },
        body,
      });
      assert.equal(response.status, 200);
      assert.equal(requests, 2);
    });
  }

  it("returns the original 401 for a stream body while still refreshing", async () => {
    const response = new Response(null, { status: 401 });
    let requests = 0;
    let refreshed = 0;
    setShareFetch(async () => {
      requests++;
      return response;
    });
    installSessionWatch({
      baseUrl,
      getToken: () => "old",
      onExpired: () => {},
      refresh: async () => {
        refreshed++;
        return "new";
      },
    });
    assert.equal(
      await getShareFetch()(`${baseUrl}/api/projects`, {
        body: new ReadableStream(),
        headers: { Authorization: "Bearer old" },
      }),
      response,
    );
    assert.equal(refreshed, 1);
    assert.equal(requests, 2); // original + confirmation, no replay
  });

  for (const outcome of ["401", "network", "valid-account"] as const) {
    it(`handles ${outcome} without treating a transient error as signed out`, async () => {
      let expired = 0;
      let refreshed = 0;
      setShareFetch(
        async (input) =>
          new Response(null, {
            status:
              outcome === "valid-account" && String(input).endsWith("/api/account") ? 200 : 401,
          }),
      );
      installSessionWatch({
        baseUrl,
        getToken: () => "old",
        onExpired: () => {
          expired++;
        },
        refresh: async () => {
          refreshed++;
          if (outcome === "network") throw new TypeError("offline");
          return null;
        },
      });
      assert.equal(
        (
          await getShareFetch()(`${baseUrl}/api/projects`, {
            headers: { Authorization: "Bearer old" },
          })
        ).status,
        401,
      );
      assert.equal(expired, outcome === "401" ? 1 : 0);
      assert.equal(refreshed, outcome === "valid-account" ? 0 : 1);
    });
  }

  it("ignores another credential and honors RequestInit header replacement", async () => {
    let calls = 0;
    setShareFetch(async () => {
      calls++;
      return new Response(null, { status: 401 });
    });
    installSessionWatch({
      baseUrl,
      getToken: () => "current",
      onExpired: () => assert.fail(),
      refresh: async () => assert.fail(),
    });
    await getShareFetch()(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer someone-else" },
    });
    const request = new Request(`${baseUrl}/api/projects`, {
      headers: { Authorization: "Bearer current" },
    });
    await getShareFetch()(request, { headers: {} });
    assert.equal(calls, 2);
  });

  it("never retries the original request more than once", async () => {
    let calls = 0;
    setShareFetch(async () => {
      calls++;
      return new Response(null, { status: 401 });
    });
    installSessionWatch({
      baseUrl,
      getToken: () => "old",
      onExpired: () => {},
      refresh: async () => "new",
    });
    assert.equal(
      (
        await getShareFetch()(`${baseUrl}/api/projects`, {
          headers: { Authorization: "Bearer old" },
        })
      ).status,
      401,
    );
    assert.equal(calls, 3);
  });
});
