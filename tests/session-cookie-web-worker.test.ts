import assert from "node:assert/strict";
import { describe, it } from "node:test";
import entry from "../workers/web/src/index";
const worker = "fetch" in entry ? entry : (entry as unknown as { default: typeof entry }).default;

describe("same-origin projects API proxy", () => {
  it("forwards the identical Request including cookie, IP, Origin, UA and body", async () => {
    const request = new Request("https://app.test/api/projects?q=1", {
      method: "PATCH",
      body: "unchanged body",
      headers: {
        "CF-Connecting-IP": "203.0.113.7",
        Origin: "https://app.test",
        "User-Agent": "a browser",
        Cookie: "__Host-geolibre_session=secret",
        Authorization: "Bearer access",
      },
    });
    const answer = new Response("api", {
      status: 201,
      headers: { "Set-Cookie": "__Host-geolibre_session=value; Secure; HttpOnly" },
    });
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          throw new Error("must not fetch assets");
        },
      },
      PROJECTS_API: {
        fetch: async (incoming: Request) => {
          assert.equal(incoming, request);
          assert.equal(await incoming.text(), "unchanged body");
          return answer;
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[1]);
    assert.equal(response, answer);
    assert.ok(response.headers.has("Set-Cookie"));
  });

  for (const [path, method, status, assetCalls] of [
    ["/a-project", "GET", 200, 1],
    ["/register", "GET", 200, 1],
    ["/assets/missing.js", "GET", 404, 0],
    ["/plugins/missing.js", "GET", 404, 0],
    ["/missing.json", "GET", 404, 0],
    ["/a-project", "POST", 404, 0],
    ["/jupyterlite/lab/index.html", "GET", 200, 1],
    ["/api-elsewhere", "GET", 200, 1],
  ] as const) {
    it(`preserves asset / fallback behavior for ${method} ${path}`, async () => {
      let calls = 0;
      const response = await worker.fetch(new Request(`https://app.test${path}`, { method }), {
        PROJECTS_API: {
          fetch: async () => {
            throw new Error("not an API route");
          },
        },
        ASSETS: {
          fetch: async () => {
            calls++;
            return new Response("shell");
          },
        },
      } as unknown as Parameters<typeof worker.fetch>[1]);
      assert.equal(response.status, status);
      assert.equal(calls, assetCalls);
      if (path === "/register")
        assert.ok(
          response.headers.get("Content-Security-Policy")?.includes("frame-ancestors 'self'"),
        );
    });
  }
});
