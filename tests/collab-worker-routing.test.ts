import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, describe, it } from "node:test";
import { signIdentityToken } from "../packages/collab-core/src/index";

// Only the platform base class is unavailable in Node. The router and identity
// verifier remain real; requests into the Durable Object are captured below.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject {}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { default: worker } = await import("../workers/collab/src/index");
after(() => hook.deregister());
type Env = Parameters<typeof worker.fetch>[1];

function relayEnv(extra: Partial<Env> = {}) {
  const requests: Request[] = [];
  const names: string[] = [];
  const env = {
    COLLAB_SESSION: {
      idFromName(name: string) {
        names.push(name);
        return name;
      },
      get() {
        return {
          async fetch(input: Request | string, init?: RequestInit) {
            const request = input instanceof Request ? input : new Request(input, init);
            requests.push(request);
            return Response.json({ ok: true }, { status: 200 });
          },
        };
      },
    },
    ...extra,
  } as unknown as Env;
  return { env, requests, names };
}
let ip = 0;
function create(body: object) {
  return new Request("https://collab.example/sessions", {
    method: "POST",
    headers: { "CF-Connecting-IP": `192.0.2.${++ip}` },
    body: JSON.stringify(body),
  });
}

describe("collaboration worker routing and identity gates", () => {
  it("fails closed for members-only creation without a valid issuer token", async () => {
    for (const secret of [undefined, "test-issuer"]) {
      const h = relayEnv({ COLLAB_REQUIRE_IDENTITY: "1", COLLAB_IDENTITY_SECRET: secret });
      const response = await worker.fetch(create({ identityToken: "invalid" }), h.env);
      assert.equal(response.status, 401);
      assert.equal(h.requests.length, 0);
    }
  });
  it("forwards persistent and identity-required settings only after verifying identity", async () => {
    const secret = "test-issuer";
    const identityToken = await signIdentityToken(
      { provider: "test", userId: "owner", username: "Owner" },
      secret,
    );
    const h = relayEnv({ COLLAB_REQUIRE_IDENTITY: "1", COLLAB_IDENTITY_SECRET: secret });
    const response = await worker.fetch(
      create({ identityToken, persistent: true, requireIdentity: true, mode: "view-only" }),
      h.env,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { sessionId: string; hostToken: string };
    assert.match(body.sessionId, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    assert.match(body.hostToken, /^[a-f0-9]{48}$/);
    assert.deepEqual(await h.requests[0].json(), {
      mode: "view-only",
      hostToken: body.hostToken,
      requireIdentity: true,
      persistent: true,
    });
    assert.deepEqual(h.names, [body.sessionId]);
  });
  it("rejects an identity-required room without an issuer and an unauthorized origin", async () => {
    const h = relayEnv({ ALLOWED_ORIGINS: "https://allowed.example" });
    assert.equal((await worker.fetch(create({ requireIdentity: true }), h.env)).status, 400);
    const request = create({});
    request.headers.set("Origin", "https://evil.example");
    assert.equal((await worker.fetch(request, h.env)).status, 403);
    assert.equal(h.requests.length, 0);
  });
  it("routes sockets, logs, and session endings with method and bearer preserved", async () => {
    for (const [method, path, target] of [
      ["GET", "ws", "ws"],
      ["GET", "log", "log"],
      ["DELETE", "log", "log"],
      ["DELETE", "", "end"],
    ]) {
      const h = relayEnv();
      const request = new Request(
        `https://collab.example/sessions/ABCD2345${path ? `/${path}` : ""}`,
        { method, headers: { Authorization: "Bearer host-secret" } },
      );
      const response = await worker.fetch(request, h.env);
      assert.equal(response.status, 200);
      assert.deepEqual(h.names, ["ABCD2345"]);
      assert.equal(h.requests[0].url, `https://collab/${target}`);
      assert.equal(h.requests[0].method, method);
      assert.equal(h.requests[0].headers.get("authorization"), "Bearer host-secret");
    }
  });
});
