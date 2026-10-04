import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createSession, endSession } from "../apps/geolibre-desktop/src/lib/collab-client";
import {
  deleteSavedSession,
  fetchSessionHostToken,
  listSavedSessions,
  saveSession,
} from "../apps/geolibre-desktop/src/lib/collab-sessions";
import {
  MAX_COLLAB_SESSION_NAME,
  isCollabHostToken,
  normalizeCollabCode,
  normalizeCollabMode,
  normalizeCollabName,
} from "../workers/projects-api/src/collab-session-policy";
import { isAuthRoute } from "../workers/projects-api/src/public-routes";
import { importSealKey, openSecret, sealSecret } from "../workers/projects-api/src/totp";

const RELAY = "wss://collab.example.test";
const API = "https://api.example.test";
const HOST_TOKEN = "ab".repeat(24);

function recorder(respond: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("saved session validation", () => {
  it("accepts only the relay's code alphabet, in any case", () => {
    assert.equal(normalizeCollabCode(" abcd2345 "), "ABCD2345");
    assert.equal(normalizeCollabCode("ABCD0O1I"), null, "0, O, 1 and I are not in the alphabet");
    assert.equal(normalizeCollabCode("ABCD234"), null);
    assert.equal(normalizeCollabCode(42), null);
  });

  it("tidies a name and bounds its length", () => {
    assert.equal(normalizeCollabName("  Nhóm   khảo sát\tA "), "Nhóm khảo sát A");
    assert.equal(normalizeCollabName("   "), null);
    assert.equal(normalizeCollabName("x".repeat(MAX_COLLAB_SESSION_NAME)), "x".repeat(60));
    assert.equal(normalizeCollabName("x".repeat(MAX_COLLAB_SESSION_NAME + 1)), null);
  });

  it("knows the two modes and the relay's token shape", () => {
    assert.equal(normalizeCollabMode("view-only"), "view-only");
    assert.equal(normalizeCollabMode("admin"), null);
    assert.ok(isCollabHostToken(HOST_TOKEN));
    assert.ok(!isCollabHostToken(HOST_TOKEN.toUpperCase()));
    assert.ok(!isCollabHostToken("ab"));
  });

  it("never lets a shared cache keep a host token", () => {
    assert.ok(isAuthRoute(["api", "collab-sessions", "x", "host-token"]));
  });
});

describe("sealing a host token", () => {
  const key = importSealKey(Buffer.alloc(32, 7).toString("base64"));

  it("opens for the same account and purpose", async () => {
    const secret = new TextEncoder().encode(HOST_TOKEN);
    const sealed = await sealSecret((await key)!, secret, "acct-1", "collab-host");
    const opened = await openSecret((await key)!, sealed, "acct-1", "collab-host");
    assert.equal(new TextDecoder().decode(opened), HOST_TOKEN);
  });

  it("refuses to open as a TOTP secret, or for another account", async () => {
    const secret = new TextEncoder().encode(HOST_TOKEN);
    const sealed = await sealSecret((await key)!, secret, "acct-1", "collab-host");
    await assert.rejects(openSecret((await key)!, sealed, "acct-1"));
    await assert.rejects(openSecret((await key)!, sealed, "acct-2", "collab-host"));
  });

  it("still opens TOTP secrets sealed before purposes existed", async () => {
    const secret = new Uint8Array([1, 2, 3]);
    const sealed = await sealSecret((await key)!, secret, "acct-1");
    assert.deepEqual(await openSecret((await key)!, sealed, "acct-1", "mfa"), secret);
  });
});

describe("relay client", () => {
  it("asks for a persistent session when told to", async () => {
    const { calls, fetchImpl } = recorder(
      () =>
        new Response(
          JSON.stringify({ sessionId: "ABCD2345", hostToken: HOST_TOKEN, mode: "co-edit" }),
          {
            status: 200,
          },
        ),
    );
    await createSession({ mode: "co-edit", persistent: true }, RELAY, fetchImpl);
    assert.equal(calls[0].url, "https://collab.example.test/sessions");
    assert.equal(JSON.parse(String(calls[0].init.body)).persistent, true);
  });

  it("ends a session with the host token as a bearer, and treats a gone session as ended", async () => {
    for (const status of [204, 404]) {
      const { calls, fetchImpl } = recorder(() => new Response(null, { status }));
      await endSession("abcd2345", HOST_TOKEN, RELAY, fetchImpl);
      assert.equal(calls[0].url, "https://collab.example.test/sessions/ABCD2345");
      assert.equal(calls[0].init.method, "DELETE");
      assert.equal(
        (calls[0].init.headers as Record<string, string>).Authorization,
        `Bearer ${HOST_TOKEN}`,
      );
    }
  });

  it("reports a refused token", async () => {
    const { fetchImpl } = recorder(() => new Response("Forbidden", { status: 403 }));
    await assert.rejects(endSession("ABCD2345", "wrong", RELAY, fetchImpl), /HTTP 403/);
  });
});

describe("projects API client", () => {
  it("lists, saves, reads the host token of, and deletes saved sessions", async () => {
    const { calls, fetchImpl } = recorder((url, init) => {
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (url.endsWith("/host-token")) return Response.json({ hostToken: HOST_TOKEN });
      if (init.method === "POST") return Response.json({ session: { id: "s1" } }, { status: 201 });
      return Response.json({ sessions: [{ id: "s1", name: "Nhóm A" }] });
    });
    const base = { token: "tok", baseUrl: API, fetchImpl };
    assert.equal((await listSavedSessions(base))[0].name, "Nhóm A");
    await saveSession({
      ...base,
      code: "ABCD2345",
      name: "Nhóm A",
      mode: "co-edit",
      hostToken: HOST_TOKEN,
    });
    assert.equal(await fetchSessionHostToken({ ...base, id: "s1" }), HOST_TOKEN);
    await deleteSavedSession({ ...base, id: "s1" });

    assert.deepEqual(
      calls.map((call) => `${call.init.method} ${call.url.replace(API, "")}`),
      [
        "GET /api/collab-sessions",
        "POST /api/collab-sessions",
        "GET /api/collab-sessions/s1/host-token",
        "DELETE /api/collab-sessions/s1",
      ],
    );
    for (const call of calls) {
      assert.equal((call.init.headers as Record<string, string>).Authorization, "Bearer tok");
    }
  });
});

describe("deployment config", () => {
  it("lets the custom domain create collaboration sessions", () => {
    const config = readFileSync(
      new URL("../workers/collab/wrangler.selfhost.jsonc", import.meta.url),
      "utf8",
    );
    const allowed = /"ALLOWED_ORIGINS":\s*"([^"]*)"/.exec(config)?.[1] ?? "";
    assert.ok(allowed.split(",").includes("https://gis.jonasnguyen.uk"));
  });

  it("refuses to deploy the API before the saved-sessions table exists", () => {
    const script = readFileSync(
      new URL("../workers/projects-api/scripts/predeploy-check.mjs", import.meta.url),
      "utf8",
    );
    assert.match(script, /collab_sessions:/);
  });
});
