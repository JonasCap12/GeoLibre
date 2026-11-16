import assert from "node:assert/strict";
import { it } from "node:test";
import { requireTurnstile } from "../workers/projects-api/src/context";
import { ApiError } from "../workers/projects-api/src/model";
import { apiScope, worker } from "./helpers/projects-api";

it("refuses a missing or blank Turnstile secret unless local development opts out explicitly", async () => {
  for (const secret of [undefined, "", "  "]) {
    for (const disabled of [undefined, "0", "true"]) {
      const { scope } = apiScope();
      scope.env.TURNSTILE_SECRET_KEY = secret;
      scope.env.GEOLIBRE_TURNSTILE_DISABLED = disabled;
      await assert.rejects(
        requireTurnstile(scope, {}, "register"),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === 503 &&
          error.message.includes("bot check is unavailable"),
      );
    }
  }
  const { scope } = apiScope();
  scope.env.GEOLIBRE_TURNSTILE_DISABLED = "1";
  await requireTurnstile(scope, {}, "register");
});

it("returns 503 from the registration handler before any account or invite access when the secret is missing", async () => {
  const h = apiScope({
    path: "/api/accounts",
    body: { username: "new-user", password: "Replacement$Passphrase72!" },
  });
  delete h.scope.env.GEOLIBRE_TURNSTILE_DISABLED;
  const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "bot check is unavailable; retry later" });
  assert.equal(h.db.calls.length, 0);
});

it("still verifies a configured secret when the development opt-out is present", async (t) => {
  const h = apiScope();
  h.scope.env.TURNSTILE_SECRET_KEY = " siteverify-secret ";
  h.scope.request.headers.set("CF-Connecting-IP", "192.0.2.42");
  let reads = 0;
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    reads++;
    assert.equal(String(input), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    assert.equal(init?.method, "POST");
    const form = init?.body as FormData;
    assert.equal(form.get("secret"), "siteverify-secret");
    assert.equal(form.get("response"), "widget-response");
    assert.equal(form.get("remoteip"), "192.0.2.42");
    return Response.json({ success: true, action: "register", hostname: "viewer.example.com" });
  });
  await requireTurnstile(h.scope, { turnstileToken: "widget-response" }, "register");
  assert.equal(reads, 1);
  await assert.rejects(
    requireTurnstile(h.scope, {}, "register"),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  assert.equal(reads, 1);
});

it("fails closed on a rejected token or unavailable siteverify service", async (t) => {
  const { scope } = apiScope();
  scope.env.TURNSTILE_SECRET_KEY = "siteverify-secret";
  let offline = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (offline) throw new Error("offline");
    return Response.json({ success: false });
  });
  await assert.rejects(
    requireTurnstile(scope, { turnstileToken: "token" }, "register"),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  offline = true;
  await assert.rejects(
    requireTurnstile(scope, { turnstileToken: "token" }, "register"),
    (error: unknown) => error instanceof ApiError && error.status === 503,
  );
});
