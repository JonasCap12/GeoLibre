import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_PASSWORD_LENGTH,
  ShareAccountError,
  createAccount,
  signIn,
  validateCredentials,
} from "../apps/geolibre-desktop/src/lib/share-account";

/**
 * Without a token nothing this app does survives a reload. Layers added from a
 * file live in the store until the tab closes, projects cannot be saved to the
 * server, and uploads to the shared library are refused.
 *
 * Settings accepted a token and the API could mint one, but nothing joined the
 * two: the hosted service has a website to sign up on, and a self-hosted
 * deployment had nowhere at all. This deployment ran four Workers with zero
 * accounts, zero projects and zero datasets, and looked like it was working.
 */

const BASE = "https://api.example.test";

/** A fetch stub that records what it was called with. */
function stubFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetch: typeof globalThis.fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

describe("validateCredentials", () => {
  it("mirrors the rules the API enforces", () => {
    assert.equal(validateCredentials("ky-thuat-1", "longenough"), null);
    assert.match(validateCredentials("ab", "longenough")!, /3-39/);
    assert.match(validateCredentials("Has-Upper", "longenough")!, /lowercase/);
    assert.match(validateCredentials("has space", "longenough")!, /lowercase/);
    assert.match(validateCredentials("ok-name", "short")!, /8 characters/);
  });

  it("checks before a request is spent", async () => {
    // The API runs scrypt on every attempt including failures, and allows ten
    // a minute per IP. A typo the browser can catch must not consume one.
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "t" } }));
    await assert.rejects(
      () => signIn({ username: "AB", password: "x", baseUrl: BASE, fetchImpl: fetch }),
      ShareAccountError,
    );
    assert.equal(calls.length, 0, "a malformed username must not reach the server");
  });

  it("accepts the shortest allowed password", () => {
    assert.equal(validateCredentials("abc", "x".repeat(MIN_PASSWORD_LENGTH)), null);
  });
});

describe("createAccount", () => {
  it("uses the token the create endpoint already returns", async () => {
    // The live API returns {account, token} from POST /api/accounts. Signing in
    // again would double the scrypt cost and spend a second of the ten
    // attempts a minute that this route and sign-in share.
    const { fetch, calls } = stubFetch((url) => {
      assert.ok(url.endsWith("/api/accounts"), `unexpected request to ${url}`);
      return { status: 201, body: { account: { username: "ky-thuat-1" }, token: "tok-from-create" } };
    });
    const token = await createAccount({
      username: "ky-thuat-1",
      password: "longenough",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(token, "tok-from-create");
    assert.equal(calls.length, 1, "creating an account must be one request, not two");
  });

  it("falls back to signing in when the server returns no token", async () => {
    // The reference implementation the API is written against returns only the
    // account, so the fallback is not hypothetical.
    const { fetch, calls } = stubFetch((url) =>
      url.endsWith("/api/accounts")
        ? { status: 201, body: { account: { username: "ky-thuat-1" } } }
        : { status: 200, body: { token: "tok-from-signin" } },
    );
    const token = await createAccount({
      username: "ky-thuat-1",
      password: "longenough",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(token, "tok-from-signin");
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith("/api/auth/token"));
  });

  it("says the username is taken rather than showing a status code", async () => {
    const { fetch } = stubFetch(() => ({ status: 409, body: { error: "username already exists" } }));
    await assert.rejects(
      () =>
        createAccount({
          username: "ky-thuat-1",
          password: "longenough",
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      (error: Error) => {
        assert.match(error.message, /taken/i);
        assert.match(error.message, /Sign in instead/i, "must say what to do about it");
        return true;
      },
    );
  });

  it("never puts the password in the error", async () => {
    // Errors reach a panel the user may screenshot for support.
    const { fetch } = stubFetch(() => ({ status: 500, body: { error: "boom" } }));
    await assert.rejects(
      () =>
        createAccount({
          username: "ky-thuat-1",
          password: "correct-horse-battery",
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      (error: Error) => {
        assert.ok(!error.message.includes("correct-horse-battery"));
        return true;
      },
    );
  });
});

describe("signIn", () => {
  it("returns the token", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "tok" } }));
    const token = await signIn({
      username: "ky-thuat-1",
      password: "longenough",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(token, "tok");
    assert.deepEqual(calls[0].body, { username: "ky-thuat-1", password: "longenough" });
  });

  it("surfaces the server's own message", async () => {
    const { fetch } = stubFetch(() => ({ status: 401, body: { error: "invalid username or password" } }));
    await assert.rejects(
      () => signIn({ username: "ky-thuat-1", password: "longenough", baseUrl: BASE, fetchImpl: fetch }),
      /invalid username or password/,
    );
  });

  it("reports an unreachable server as such", async () => {
    const failing = (() => Promise.reject(new TypeError("network"))) as unknown as typeof fetch;
    await assert.rejects(
      () => signIn({ username: "ky-thuat-1", password: "longenough", baseUrl: BASE, fetchImpl: failing }),
      /Could not reach/,
    );
  });

  it("rejects a response with no token instead of storing an empty one", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: { account: {} } }));
    await assert.rejects(
      () => signIn({ username: "ky-thuat-1", password: "longenough", baseUrl: BASE, fetchImpl: fetch }),
      /did not return a token/,
    );
  });
});
