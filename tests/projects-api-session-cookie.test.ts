import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, it, mock } from "node:test";
import { passwordHash, passwordMatches, tokenDigest } from "../workers/projects-api/src/auth";
import { ACCESS_TOKEN_TTL_MS } from "../workers/projects-api/src/auth-policy";
import { recoveryCodeDigest } from "../workers/projects-api/src/totp";
import { SESSION_COOKIE, SESSION_HEADER } from "../workers/projects-api/src/session-cookie";
import { apiScope, worker } from "./helpers/projects-api";
import type { D1Call } from "./helpers/fake-d1";

const origin = "https://app.example.com";
const password = "orchards mountains rivers lanterns";
let hash: Promise<string> | undefined;

async function fixture() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("workers/projects-api/schema.sql", "utf8"));
  sql.exec(readFileSync("workers/projects-api/schema-access-tokens.sql", "utf8"));
  const h = apiScope();
  // Keep the existing D1 call recorder, but execute real SQL to verify joins,
  // revocations and the additive migration rather than scripting their results.
  for (const method of ["first", "all", "run"] as const) {
    h.db.on(method, /./, (call: D1Call) => {
      const statement = sql.prepare(call.sql);
      const bindings = call.bindings as SQLInputValue[];
      const numbered = /\?\d/.test(call.sql);
      const named = Object.fromEntries(bindings.map((value, i) => [`?${i + 1}`, value]));
      if (method === "first")
        return (numbered ? statement.get(named) : statement.get(...bindings)) ?? null;
      if (method === "all") return numbered ? statement.all(named) : statement.all(...bindings);
      const result = numbered ? statement.run(named) : statement.run(...bindings);
      return { success: true, meta: { changes: Number(result.changes) } };
    });
  }
  h.scope.env.GEOLIBRE_CORS_ORIGINS = origin;
  h.scope.env.COLLAB_IDENTITY_SECRET = "a sufficiently long test collaboration secret";
  sql
    .prepare(
      "INSERT INTO accounts (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "owner",
      "surveyor",
      "old@example.com",
      await (hash ??= passwordHash(password)),
      new Date().toISOString(),
    );
  async function call(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      cookie?: string;
      token?: string;
      cookieMode?: boolean;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      ...(options.cookieMode === false ? {} : { [SESSION_HEADER]: "cookie", Origin: origin }),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...options.headers,
    };
    const response = await worker.fetch(
      new Request(`${origin}${path}`, {
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      }),
      h.scope.env,
      h.scope.ctx,
    );
    await h.drain();
    return response;
  }
  const login = (cookieMode = true) =>
    call("/api/auth/token", { body: { username: "surveyor", password }, cookieMode });
  return { ...h, sql, call, login };
}

async function credentials(response: Response) {
  assert.equal(response.status < 300, true, await response.clone().text());
  const body = (await response.json()) as {
    accessToken: string;
    expiresAt: string;
    token?: string;
  };
  assert.equal(body.token, undefined);
  assert.match(body.accessToken, /^[A-Za-z0-9_-]{40,}$/);
  const cookie = response.headers.get("Set-Cookie")!;
  for (const attribute of ["Path=/", "Secure", "HttpOnly", "SameSite=Strict", "Max-Age=2592000"])
    assert.ok(cookie.includes(attribute), attribute);
  const secret = cookie.split(";")[0].slice(SESSION_COOKIE.length + 1);
  assert.notEqual(body.accessToken, secret);
  const ttl = Date.parse(body.expiresAt) - Date.now();
  assert.ok(ttl > ACCESS_TOKEN_TTL_MS - 15000 && ttl <= ACCESS_TOKEN_TTL_MS);
  return { ...body, cookie: cookie.split(";")[0], secret };
}

describe("cookie session credentials", () => {
  it("sign-in hides the session secret, accepts access and refuses cookie-only reads/writes", async () => {
    const h = await fixture();
    const c = await credentials(await h.login());
    assert.equal(
      h.sql.prepare("SELECT digest FROM tokens").get()?.digest,
      await tokenDigest(c.secret),
    );
    assert.equal(
      h.sql.prepare("SELECT digest FROM access_tokens").get()?.digest,
      await tokenDigest(c.accessToken),
    );
    assert.equal((await h.call("/api/account", { token: c.accessToken })).status, 200);
    assert.equal((await h.call("/api/account", { cookie: c.cookie })).status, 401);
    assert.equal((await h.call("/api/projects", { cookie: c.cookie, body: {} })).status, 401);
    const sessions = (await (
      await h.call("/api/auth/sessions", { token: c.accessToken })
    ).json()) as { sessions: { current: boolean; id: string }[] };
    assert.equal(sessions.sessions[0].current, true);
    assert.equal(sessions.sessions[0].id, await tokenDigest(c.secret));
    assert.equal(
      (await h.call("/api/collab/identity", { token: c.accessToken, body: {} })).status,
      200,
    );
  });

  for (const cookieMode of [true, false]) {
    it(`register, password and MFA mint sites preserve credential mode (cookie=${cookieMode})`, async () => {
      const h = await fixture();
      const assertMint = async (response: Response) => {
        if (cookieMode) return (await credentials(response)).accessToken;
        assert.equal(response.headers.get("Set-Cookie"), null);
        const body = (await response.json()) as { token: string; accessToken?: string };
        assert.equal(body.accessToken, undefined);
        assert.equal(typeof body.token, "string");
        assert.ok(
          h.sql
            .prepare("SELECT digest FROM tokens WHERE digest = ?")
            .get(await tokenDigest(body.token)),
        );
        return body.token;
      };
      const bearer = await assertMint(await h.login(cookieMode));
      const invite = "new-invite-secret-for-registration";
      h.sql
        .prepare(
          "INSERT INTO auth_actions (digest, kind, email, created_at, expires_at) VALUES (?, 'invite', ?, ?, ?)",
        )
        .run(
          await tokenDigest(invite),
          "new@example.com",
          new Date().toISOString(),
          new Date(Date.now() + 600000).toISOString(),
        );
      mock.method(globalThis, "fetch", async () => new Response("")); // HIBP range: no matches.
      try {
        const registered = await h.call("/api/accounts", {
          cookieMode,
          body: { invite, username: "new-user", password },
        });
        assert.equal(registered.status, 201, await registered.clone().text());
        await assertMint(registered);
        const changed = await h.call("/api/auth/password", {
          cookieMode,
          token: bearer,
          body: { currentPassword: password, password: "new orchards mountains rivers lanterns" },
        });
        assert.equal(changed.status, 200, await changed.clone().text());
        await assertMint(changed);
      } finally {
        mock.restoreAll();
      }
      // MFA redemption via a recovery code exercises the fourth mint site.
      h.sql
        .prepare("UPDATE accounts SET mfa_secret = 'sealed', mfa_enabled_at = ? WHERE id = 'owner'")
        .run(new Date().toISOString());
      const recovery = "ABCDEFGHIJKLMNOPQRSTUVWX";
      h.sql
        .prepare(
          "INSERT INTO mfa_recovery_codes (digest, account_id, created_at) VALUES (?, 'owner', ?)",
        )
        .run(await recoveryCodeDigest(recovery), new Date().toISOString());
      const ticket = "mfa-ticket-secret-for-sign-in";
      h.sql
        .prepare(
          "INSERT INTO mfa_tickets (digest, account_id, created_at, expires_at) VALUES (?, 'owner', ?, ?)",
        )
        .run(
          await tokenDigest(ticket),
          new Date().toISOString(),
          new Date(Date.now() + 600000).toISOString(),
        );
      const mfa = await h.call("/api/auth/mfa", { cookieMode, body: { ticket, code: recovery } });
      assert.equal(mfa.status, 200, await mfa.clone().text());
      await assertMint(mfa);
    });
  }

  it("cannot downgrade an access token through password change or adopt", async () => {
    const h = await fixture();
    const c = await credentials(await h.login());
    assert.equal(
      (await h.call("/api/auth/session/adopt", { token: c.accessToken, body: {} })).status,
      401,
    );
    assert.equal(
      (
        await h.call("/api/auth/password", {
          token: c.accessToken,
          cookieMode: false,
          body: { currentPassword: password, password },
        })
      ).status,
      403,
    );
  });

  it("adopts only a session bearer, rotates it and invalidates the old row", async () => {
    const h = await fixture();
    const old = (await (await h.login(false)).json()) as { token: string };
    const c = await credentials(
      await h.call("/api/auth/session/adopt", { token: old.token, body: {} }),
    );
    assert.notEqual(c.secret, old.token);
    assert.equal(
      h.sql.prepare("SELECT digest FROM tokens WHERE digest = ?").get(await tokenDigest(old.token)),
      undefined,
    );
    assert.equal((await h.call("/api/account", { token: old.token })).status, 401);
  });
});

describe("cookie refresh and revocation", () => {
  it("refresh issues access only, touches the parent and prunes expired access", async () => {
    const h = await fixture();
    const c = await credentials(await h.login());
    h.sql
      .prepare("UPDATE tokens SET last_used_at = ?")
      .run(new Date(Date.now() - 7200000).toISOString());
    h.sql.prepare("UPDATE access_tokens SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const response = await h.call("/api/auth/refresh", { method: "POST", cookie: c.cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Set-Cookie"), null);
    const body = (await response.json()) as { accessToken: string; token?: string };
    assert.equal(body.token, undefined);
    assert.notEqual(body.accessToken, c.secret);
    assert.ok(
      Date.parse(String(h.sql.prepare("SELECT last_used_at FROM tokens").get()?.last_used_at)) >
        Date.now() - 5000,
    );
    assert.equal(h.sql.prepare("SELECT COUNT(*) AS n FROM access_tokens").get()?.n, 1);
  });

  for (const headers of [
    { Origin: "" },
    { Origin: "https://evil.test" },
    { [SESSION_HEADER]: "" },
  ] as Record<string, string>[]) {
    it(`refuses refresh without an allowed Origin and custom header: ${JSON.stringify(headers)}`, async () => {
      const h = await fixture();
      const response = await h.call("/api/auth/refresh", { method: "POST", headers });
      assert.equal(response.status, 403);
    });
  }

  for (const state of ["missing", "invalid", "expired", "idle", "disabled"] as const) {
    it(`refresh refuses ${state} sessions and clears the cookie`, async () => {
      const h = await fixture();
      const c = await credentials(await h.login());
      if (state === "expired")
        h.sql.exec("UPDATE tokens SET expires_at = '2000-01-01T00:00:00.000Z'");
      if (state === "idle")
        h.sql.exec("UPDATE tokens SET last_used_at = '2000-01-01T00:00:00.000Z'");
      if (state === "disabled") h.sql.exec("UPDATE accounts SET disabled_at = '2026-01-01'");
      const response = await h.call("/api/auth/refresh", {
        method: "POST",
        cookie:
          state === "missing"
            ? undefined
            : state === "invalid"
              ? `${SESSION_COOKIE}=bad`
              : c.cookie,
      });
      assert.equal(response.status, 401);
      assert.ok(response.headers.get("Set-Cookie")?.includes("Max-Age=0"));
      if (!["missing", "invalid"].includes(state))
        assert.equal((await h.call("/api/account", { token: c.accessToken })).status, 401);
    });
  }

  it("rate limits refresh", async () => {
    const h = await fixture();
    h.scope.env.AUTH_RATE_LIMITER = {
      async limit() {
        return { success: false };
      },
    };
    assert.equal((await h.call("/api/auth/refresh", { method: "POST" })).status, 429);
  });

  for (const action of ["logout", "revoke", "all", "disable", "password", "expiry"] as const) {
    it(`access immediately dies after ${action}`, async () => {
      const h = await fixture();
      const c = await credentials(await h.login());
      if (action === "logout") {
        const response = await h.call("/api/auth/token", { method: "DELETE", cookie: c.cookie });
        assert.equal(response.status, 204);
        assert.ok(response.headers.get("Set-Cookie")?.includes("Max-Age=0"));
      } else if (action === "revoke" || action === "all") {
        assert.equal(
          (
            await h.call(
              `/api/auth/sessions${action === "revoke" ? `/${await tokenDigest(c.secret)}` : ""}`,
              { method: "DELETE", token: c.accessToken },
            )
          ).status,
          204,
        );
      } else if (action === "disable") {
        h.sql
          .prepare(
            "INSERT INTO accounts (id, username, password_hash, created_at, mfa_secret, mfa_enabled_at) VALUES ('admin', 'admin', 'invalid', ?, 'sealed', ?)",
          )
          .run(new Date().toISOString(), new Date().toISOString());
        h.sql
          .prepare("INSERT INTO tokens (digest, account_id, created_at) VALUES (?, 'admin', ?)")
          .run(await tokenDigest("admin-bearer"), new Date().toISOString());
        assert.equal(
          (
            await h.call("/api/admin/accounts/owner/disable", {
              token: "admin-bearer",
              method: "POST",
            })
          ).status,
          204,
        );
      } else if (action === "password") {
        mock.method(globalThis, "fetch", async () => new Response(""));
        try {
          await credentials(
            await h.call("/api/auth/password", {
              token: c.accessToken,
              body: {
                currentPassword: password,
                password: "new orchards mountains rivers lanterns",
              },
            }),
          );
        } finally {
          mock.restoreAll();
        }
      } else
        h.sql
          .prepare("UPDATE access_tokens SET expires_at = ?")
          .run(new Date(Date.now() - 1).toISOString());
      assert.equal((await h.call("/api/account", { token: c.accessToken })).status, 401);
    });
  }

  it("reset-request logs mail; reset-confirm changes hash, spends link and deletes all credentials", async () => {
    const h = await fixture();
    const c = await credentials(await h.login());
    h.scope.env.GEOLIBRE_EMAIL_LOG_ONLY = "1";
    const mail: string[] = [];
    mock.method(console, "log", (value: string) => mail.push(value));
    mock.method(globalThis, "fetch", async () => new Response(""));
    try {
      assert.equal(
        (await h.call("/api/auth/reset-request", { body: { email: "old@example.com" } })).status,
        200,
      );
      const link = h.sql.prepare("SELECT * FROM auth_actions WHERE kind = 'reset'").get()!;
      assert.ok(link);
      assert.equal(mail.length, 1);
      const token = decodeURIComponent(/reset#token=([^\s]+)/.exec(mail[0])![1]);
      assert.equal(link.digest, await tokenDigest(token));
      const next = "a new orchard mountain river lantern";
      const reset = () => h.call("/api/auth/reset-confirm", { body: { token, password: next } });
      assert.equal((await reset()).status, 200);
      assert.ok(
        await passwordMatches(
          next,
          String(h.sql.prepare("SELECT password_hash FROM accounts").get()?.password_hash),
        ),
      );
      for (const table of ["tokens", "access_tokens"])
        assert.equal(h.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n, 0);
      assert.equal((await h.call("/api/account", { token: c.accessToken })).status, 401);
      assert.equal((await reset()).status, 403);
      h.sql.exec("UPDATE auth_actions SET used_at = NULL, expires_at = '2000-01-01T00:00:00.000Z'");
      assert.equal((await reset()).status, 403);
    } finally {
      mock.restoreAll();
    }
  });
});
