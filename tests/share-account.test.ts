import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_PASSWORD_LENGTH,
  ShareAccountError,
  authErrorCode,
  changePassword,
  completeMfaSignIn,
  confirmEmailChange,
  confirmPasswordReset,
  createAccount,
  disableMfa,
  enableMfa,
  fetchAccount,
  inspectInvite,
  mfaCodeProblem,
  regenerateRecoveryCodes,
  requestEmailChange,
  requestPasswordReset,
  signIn,
  startMfaSetup,
  validateCredentials,
  validateSignIn,
} from "../apps/geolibre-desktop/src/lib/share-account";

const NEW_PASSWORD = "long enough passphrase";

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
  handler: (
    url: string,
    init: RequestInit,
  ) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  },
): {
  fetch: typeof globalThis.fetch;
  calls: { url: string; body: unknown; headers: Headers; method: string }[];
} {
  const calls: { url: string; body: unknown; headers: Headers; method: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      body: init.body ? JSON.parse(String(init.body)) : null,
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
    });
    const { status, body, headers } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: impl, calls };
}

describe("validateCredentials", () => {
  it("mirrors the rules the API enforces", () => {
    assert.equal(validateCredentials("ky-thuat-1", NEW_PASSWORD), null);
    assert.match(validateCredentials("ab", NEW_PASSWORD)!, /3-39/);
    assert.match(validateCredentials("Has-Upper", NEW_PASSWORD)!, /lowercase/);
    assert.match(validateCredentials("has space", NEW_PASSWORD)!, /lowercase/);
    assert.match(validateCredentials("ok-name", "longenough12")!, /15 characters/);
  });

  it("sets the new-password floor at 15 (NIST SP 800-63B-4, single factor)", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 15);
    assert.notEqual(validateCredentials("abc", "x".repeat(14)), null);
  });
});

describe("validateSignIn", () => {
  it("has no length floor, so accounts made under the 12-character rule still sign in", () => {
    // The six existing accounts may have 12-14 character passwords. Raising
    // the minimum must not lock them out; it applies when a password is set.
    assert.equal(validateSignIn("ky-thuat-1", "longenough12"), null);
    assert.equal(validateSignIn("ky-thuat-1", "x"), null);
  });

  it("accepts an email address or a username in any case", () => {
    assert.equal(validateSignIn("KyThuat@Example.test", "pw"), null);
    assert.equal(validateSignIn("Ky-Thuat-1", "pw"), null);
  });

  it("refuses an empty password or an identifier the API cannot look up", () => {
    assert.notEqual(validateSignIn("ky-thuat-1", ""), null);
    assert.notEqual(validateSignIn("ab", "pw"), null);
    assert.notEqual(validateSignIn("not an email@", "pw"), null);
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
      return {
        status: 201,
        body: { account: { username: "ky-thuat-1" }, token: "tok-from-create" },
      };
    });
    const token = await createAccount({
      username: "ky-thuat-1",
      password: NEW_PASSWORD,
      invite: "invite-token",
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
      password: NEW_PASSWORD,
      invite: "invite-token",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(token, "tok-from-signin");
    assert.equal(calls.length, 2);
    assert.ok(calls[1].url.endsWith("/api/auth/token"));
  });

  it("says the username is taken rather than showing a status code", async () => {
    const { fetch } = stubFetch(() => ({
      status: 409,
      body: { error: "username already exists" },
    }));
    await assert.rejects(
      () =>
        createAccount({
          username: "ky-thuat-1",
          password: NEW_PASSWORD,
          invite: "invite-token",
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
          invite: "invite-token",
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
    const result = await signIn({
      username: "ky-thuat-1",
      password: "longenough12",
      invite: "invite-token",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(result, { kind: "token", token: "tok" });
    assert.deepEqual(calls[0].body, { username: "ky-thuat-1", password: "longenough12" });
  });

  it("returns the ticket when the account has two-factor on", async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      body: { mfaRequired: true, mfaTicket: "ticket-1" },
    }));
    const result = await signIn({
      username: "ky-thuat-1",
      password: "longenough12",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(result, { kind: "mfa", ticket: "ticket-1" });
  });

  it("surfaces the server's own message", async () => {
    const { fetch } = stubFetch(() => ({
      status: 401,
      body: { error: "invalid username or password" },
    }));
    await assert.rejects(
      () =>
        signIn({
          username: "ky-thuat-1",
          password: "longenough12",
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      /invalid username or password/,
    );
  });

  it("reports an unreachable server as such", async () => {
    const failing = (() => Promise.reject(new TypeError("network"))) as unknown as typeof fetch;
    await assert.rejects(
      () =>
        signIn({
          username: "ky-thuat-1",
          password: "longenough12",
          baseUrl: BASE,
          fetchImpl: failing,
        }),
      /Could not reach/,
    );
  });

  it("asks for a reset without saying whether the address exists", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { ok: true } }));
    await requestPasswordReset({
      email: "kythuat@example.test",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(calls[0].url, `${BASE}/api/auth/reset-request`);
    assert.deepEqual(calls[0].body, { email: "kythuat@example.test", turnstileToken: "" });
  });

  it("rejects a response with no token instead of storing an empty one", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: { account: {} } }));
    await assert.rejects(
      () =>
        signIn({
          username: "ky-thuat-1",
          password: "longenough12",
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      /did not return a token/,
    );
  });

  it("signs in by email with the same request shape", async () => {
    // The key stays `username`, so a server that predates sign-in-by-email
    // still parses the body.
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "tok" } }));
    await signIn({
      username: " kythuat@example.test ",
      password: "pw",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(calls[0].body, { username: "kythuat@example.test", password: "pw" });
  });

  it("reads Retry-After from a 429", async () => {
    const { fetch } = stubFetch(() => ({
      status: 429,
      body: { error: "too many sign-in attempts for this account; retry later" },
      headers: { "Retry-After": "60" },
    }));
    await assert.rejects(
      () => signIn({ username: "ky-thuat-1", password: "pw", baseUrl: BASE, fetchImpl: fetch }),
      (error: ShareAccountError) => {
        assert.equal(error.code, "rate-limited");
        assert.equal(error.retryAfter, 60);
        return true;
      },
    );
  });
});

describe("authErrorCode", () => {
  it("maps the server's messages to stable codes the UI translates", () => {
    assert.equal(authErrorCode(401, "invalid username or password"), "bad-credentials");
    assert.equal(authErrorCode(403, "account is disabled"), "disabled");
    assert.equal(authErrorCode(403, "invite is invalid or expired"), "invite-invalid");
    assert.equal(authErrorCode(403, "reset token is invalid or expired"), "reset-invalid");
    assert.equal(
      authErrorCode(403, "bot check failed; reload the page and try again"),
      "bot-check",
    );
    assert.equal(authErrorCode(503, "bot check is unavailable; retry later"), "bot-unavailable");
    assert.equal(
      authErrorCode(422, "this password has appeared in a data breach; choose a different one"),
      "password-breached",
    );
    assert.equal(authErrorCode(422, "password must be at least 15 characters"), "password-short");
    assert.equal(
      authErrorCode(
        422,
        "password must not contain your username, email name, or the product name",
      ),
      "password-context",
    );
    assert.equal(authErrorCode(401, "invalid or expired token"), "session-expired");
    assert.equal(authErrorCode(429, "anything"), "rate-limited");
    assert.equal(authErrorCode(401, "two-factor code is incorrect"), "mfa-invalid");
    assert.equal(authErrorCode(403, "two-factor code is incorrect"), "mfa-invalid");
    assert.equal(authErrorCode(403, "two-factor code required"), "mfa-required");
    assert.equal(authErrorCode(401, "sign-in step expired; sign in again"), "mfa-expired");
    assert.equal(
      authErrorCode(
        403,
        "too many wrong two-factor codes; wait 15 minutes or use a recovery code",
      ),
      "mfa-locked",
    );
    assert.equal(
      authErrorCode(503, "two-factor authentication is not configured on this deployment"),
      "mfa-unavailable",
    );
    assert.equal(
      authErrorCode(403, "admin accounts must turn on two-factor authentication first"),
      "admin-mfa-required",
    );
    assert.equal(authErrorCode(403, "admin only"), "forbidden");
  });

  it("leaves an unrecognised message as unknown, so the UI shows it verbatim", () => {
    assert.equal(authErrorCode(500, "boom"), "unknown");
  });
});

describe("link pages", () => {
  it("inspects an invite in the body, never the URL", async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: { email: "ky****@example.test", expiresAt: "2026-10-06T00:00:00.000Z" },
    }));
    const summary = await inspectInvite({
      invite: "invite-token",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(summary.email, "ky****@example.test");
    assert.equal(calls[0].url, `${BASE}/api/invites/inspect`);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { invite: "invite-token" });
  });

  it("does not send a reset or verification token as a bearer", async () => {
    // Both routes are public. A link token in Authorization would also be
    // treated as a session lookup and answered 401.
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { ok: true } }));
    await confirmPasswordReset({
      token: "reset-token",
      password: NEW_PASSWORD,
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    await confirmEmailChange({ token: "verify-token", baseUrl: BASE, fetchImpl: fetch });
    for (const call of calls) assert.equal(call.headers.get("Authorization"), null, call.url);
    assert.deepEqual(calls[0].body, {
      token: "reset-token",
      password: NEW_PASSWORD,
      turnstileToken: "",
    });
  });

  it("checks the new password length before the request", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { ok: true } }));
    await assert.rejects(
      () =>
        confirmPasswordReset({ token: "t", password: "short", baseUrl: BASE, fetchImpl: fetch }),
      ShareAccountError,
    );
    assert.equal(calls.length, 0);
  });
});

describe("fetchAccount", () => {
  it("reads isAdmin, and treats anything but true as false", async () => {
    const { fetch, calls } = stubFetch(() => ({
      status: 200,
      body: { account: { id: "1", username: "a", email: null, isAdmin: "yes" } },
    }));
    const account = await fetchAccount({ token: "tok", baseUrl: BASE, fetchImpl: fetch });
    assert.equal(account.isAdmin, false);
    assert.equal(account.mfaEnabled, false);
    assert.equal(account.recoveryCodesLeft, 0);
    assert.equal(calls[0].headers.get("Authorization"), "Bearer tok");
  });

  it("reads the two-factor state", async () => {
    const { fetch } = stubFetch(() => ({
      status: 200,
      body: { account: { id: "1", mfaEnabled: true, recoveryCodesLeft: 7 } },
    }));
    const account = await fetchAccount({ token: "tok", baseUrl: BASE, fetchImpl: fetch });
    assert.equal(account.mfaEnabled, true);
    assert.equal(account.recoveryCodesLeft, 7);
  });
});

describe("two-factor", () => {
  it("trades the ticket and a code for a token, with no bearer", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "tok" } }));
    const token = await completeMfaSignIn({
      ticket: "ticket-1",
      code: " 123 456 ",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.equal(token, "tok");
    assert.equal(calls[0].url, `${BASE}/api/auth/mfa`);
    assert.deepEqual(calls[0].body, { ticket: "ticket-1", code: "123 456" });
    assert.equal(calls[0].headers.get("Authorization"), null);
  });

  it("checks the code's shape before spending one of the ticket's attempts", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "tok" } }));
    for (const code of ["", "12345", "1234567", "not-a-code"]) {
      await assert.rejects(
        () => completeMfaSignIn({ ticket: "t", code, baseUrl: BASE, fetchImpl: fetch }),
        (error: ShareAccountError) => error.code === "mfa-invalid",
      );
    }
    assert.equal(calls.length, 0);
    assert.equal(mfaCodeProblem("123456"), null);
    assert.equal(mfaCodeProblem("ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"), null);
    assert.equal(mfaCodeProblem("abcd efgh ijkl mnop qrst uvwx"), null);
    assert.equal(mfaCodeProblem("ABCD-EFGH-JKLM-NPQR"), "mfa-invalid");
  });

  it("sends a code with a sensitive change only when one was typed", async () => {
    const { fetch, calls } = stubFetch(() => ({ status: 200, body: { token: "fresh" } }));
    await changePassword({
      token: "tok",
      currentPassword: "old",
      password: NEW_PASSWORD,
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    await changePassword({
      token: "tok",
      currentPassword: "old",
      password: NEW_PASSWORD,
      code: "123456",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    await requestEmailChange({
      token: "tok",
      email: "new@example.test",
      currentPassword: "old",
      code: " ",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    // The body a server without two-factor receives is the one it always did.
    assert.deepEqual(calls[0].body, { currentPassword: "old", password: NEW_PASSWORD });
    assert.deepEqual(calls[1].body, {
      currentPassword: "old",
      password: NEW_PASSWORD,
      code: "123456",
    });
    assert.deepEqual(calls[2].body, { email: "new@example.test", currentPassword: "old" });
  });

  it("reads setup and recovery codes", async () => {
    const { fetch, calls } = stubFetch((url) =>
      url.endsWith("/setup")
        ? { status: 200, body: { secret: "JBSWY3DP", otpauthUri: "otpauth://totp/x" } }
        : { status: 200, body: { recoveryCodes: ["AAAA-BBBB-CCCC-DDDD", 3] } },
    );
    const setup = await startMfaSetup({
      token: "tok",
      currentPassword: "pw",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(setup, { secret: "JBSWY3DP", otpauthUri: "otpauth://totp/x" });
    const codes = await enableMfa({
      token: "tok",
      code: "123456",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(codes, ["AAAA-BBBB-CCCC-DDDD"]);
    const fresh = await regenerateRecoveryCodes({
      token: "tok",
      currentPassword: "pw",
      code: "123456",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(fresh, ["AAAA-BBBB-CCCC-DDDD"]);
    await disableMfa({
      token: "tok",
      currentPassword: "pw",
      code: "123456",
      baseUrl: BASE,
      fetchImpl: fetch,
    });
    assert.deepEqual(
      calls.map((call) => call.url.slice(BASE.length)),
      [
        "/api/auth/mfa/setup",
        "/api/auth/mfa/enable",
        "/api/auth/mfa/recovery-codes",
        "/api/auth/mfa/disable",
      ],
    );
    for (const call of calls) assert.equal(call.headers.get("Authorization"), "Bearer tok");
  });

  it("refuses an enable reply without codes rather than showing an empty list", async () => {
    const { fetch } = stubFetch(() => ({ status: 200, body: { recoveryCodes: [] } }));
    await assert.rejects(
      () => enableMfa({ token: "tok", code: "123456", baseUrl: BASE, fetchImpl: fetch }),
      /recovery codes/,
    );
  });

  it("refuses a create-account fallback that asks for a second factor", async () => {
    const { fetch } = stubFetch((url) =>
      url.endsWith("/api/accounts")
        ? { status: 201, body: { account: {} } }
        : { status: 200, body: { mfaRequired: true, mfaTicket: "t" } },
    );
    await assert.rejects(
      () =>
        createAccount({
          username: "ky-thuat-1",
          password: NEW_PASSWORD,
          invite: "invite-token",
          baseUrl: BASE,
          fetchImpl: fetch,
        }),
      /did not return a token/,
    );
  });
});
