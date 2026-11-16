import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { passwordHash, tokenDigest } from "../workers/projects-api/src/auth";
import { accountRoute, requireReauthentication } from "../workers/projects-api/src/account-routes";
import { adminRoute, createInvite } from "../workers/projects-api/src/admin-routes";
import { collabSessionRoute } from "../workers/projects-api/src/collab-sessions";
import {
  issueMfaTicket,
  redeemMfaTicket,
  recoveryCodesLeft,
  requireSecondFactor,
  verifySecondFactor,
  mfaRoute,
  sealKey,
} from "../workers/projects-api/src/mfa-routes";
import {
  hotp,
  totpStep,
  sealSecret,
  openSecret,
  recoveryCodeDigest,
  normalizeRecoveryCode,
} from "../workers/projects-api/src/totp";
import { ApiError } from "../workers/projects-api/src/model";
import { account, apiScope } from "./helpers/projects-api";
import type { D1Call } from "./helpers/fake-d1";

const mfaAccount = { ...account, mfa_enabled_at: new Date().toISOString(), mfa_secret: "sealed" };
const admin = { ...mfaAccount, id: "admin-id", username: "admin" };
const refusal = (status: number, message: RegExp) => (error: unknown) =>
  error instanceof ApiError && error.status === status && message.test(error.message);
const changed = (n: number) => ({ success: true, meta: { changes: n } });
const code = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX";

describe("projects API admin route behavior", () => {
  it("refuses non-admins and admins without MFA before touching D1", async () => {
    for (const user of [account, { ...admin, mfa_secret: null }]) {
      const h = apiScope({ account: user });
      await assert.rejects(
        adminRoute(h.scope, ["admin", "accounts"], "GET"),
        refusal(403, /admin|two-factor/),
      );
      assert.equal(h.db.calls.length, 0);
    }
  });

  it("creates a hashed invite and mails the raw token only in a fragment", async () => {
    const h = apiScope({ account: admin });
    h.db.on("first", /SELECT id FROM accounts WHERE email/, null);
    await createInvite(h.scope, admin, "new@example.com");
    await h.drain();
    assert.equal(h.messages.length, 1);
    const token = /register#invite=([^\s]+)/.exec(h.messages[0].text)![1];
    const insert = h.db.calls.find((c) => c.sql.startsWith("INSERT INTO auth_actions"))!;
    assert.equal(insert.bindings[0], await tokenDigest(decodeURIComponent(token)));
    assert.equal(insert.bindings[1], "new@example.com");
    assert.equal(insert.bindings[4], admin.id);
    assert.equal(h.messages[0].to, "new@example.com");
  });

  for (const action of ["revoke", "resend"] as const) {
    it(`${action}s an unused invite and invalidates the old link`, async () => {
      const h = apiScope({ account: admin });
      const digest = "a".repeat(64);
      h.db.on("first", /SELECT \* FROM auth_actions/, {
        digest,
        email: "new@example.com",
        used_at: null,
        account_id: null,
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
      h.db.on("first", /SELECT id FROM accounts WHERE email/, null);
      const response = await adminRoute(
        h.scope,
        ["admin", "invites", digest, ...(action === "resend" ? ["resend"] : [])],
        action === "resend" ? "POST" : "DELETE",
      );
      assert.equal(response?.status, action === "resend" ? 201 : 204);
      assert.deepEqual(
        h.db.calls.find((c) => c.sql.startsWith("DELETE FROM auth_actions"))?.bindings,
        [digest],
      );
      assert.equal(h.messages.length, action === "resend" ? 1 : 0);
      await h.drain();
    });
  }

  for (const action of ["disable", "sessions", "mfa"] as const) {
    it(`${action} removes the target account's credentials, with account-scoped writes`, async () => {
      const h = apiScope({ account: admin });
      h.db.on("first", /SELECT \* FROM accounts WHERE id/, account);
      h.db.on("all", /SELECT id, username FROM accounts/, [admin, account]);
      const response = await adminRoute(
        h.scope,
        ["admin", "accounts", account.id, action],
        action === "disable" ? "POST" : "DELETE",
      );
      assert.equal(response?.status, 204);
      const writes = h.db.calls.filter((c) => c.method === "run" && !c.sql.includes("auth_events"));
      assert.ok(writes.some((c) => c.sql === "DELETE FROM tokens WHERE account_id = ?"));
      assert.ok(writes.every((c) => c.bindings.includes(account.id)));
      if (action === "disable")
        assert.ok(writes.some((c) => c.sql.startsWith("UPDATE accounts SET disabled_at")));
      if (action === "mfa") {
        assert.equal(h.db.batches[0].length, 4);
        assert.ok(writes.some((c) => c.sql.startsWith("UPDATE accounts SET mfa_secret = NULL")));
        for (const table of ["mfa_recovery_codes", "mfa_tickets"])
          assert.ok(writes.some((c) => c.sql.startsWith(`DELETE FROM ${table}`)));
        assert.equal(h.messages[0].to, account.email);
      }
      await h.drain();
    });
  }
});

describe("projects API MFA behavior", () => {
  it("rejects a wrong factor and requires a code only when MFA is enabled", async () => {
    const h = apiScope({ account: mfaAccount });
    await requireSecondFactor(h.scope, account, {});
    await assert.rejects(requireSecondFactor(h.scope, mfaAccount, {}), refusal(403, /required/));
    assert.equal(await verifySecondFactor(h.scope, mfaAccount, "invalid"), null);
    await assert.rejects(
      requireSecondFactor(h.scope, mfaAccount, { code: "invalid" }),
      refusal(403, /incorrect/),
    );
    assert.equal(h.db.batches.length, 2);
    assert.ok(
      h.db.calls.some(
        (c) => c.sql.includes("mfa_failed_attempts + 1") && c.bindings[0] === account.id,
      ),
    );
  });

  it("spends a recovery code atomically and reports the remaining count", async () => {
    const h = apiScope({ account: mfaAccount });
    const digest = await recoveryCodeDigest(normalizeRecoveryCode(code)!);
    let unused = true;
    h.db.on("run", /UPDATE mfa_recovery_codes/, (call: D1Call) => {
      assert.equal(call.bindings[1], digest);
      assert.equal(call.bindings[2], account.id);
      const n = unused ? 1 : 0;
      unused = false;
      return changed(n);
    });
    h.db.on("first", /COUNT\(\*\).*mfa_recovery_codes/, () => ({ n: unused ? 1 : 0 }));
    assert.equal(await recoveryCodesLeft(h.scope, account.id), 1);
    assert.equal(await verifySecondFactor(h.scope, mfaAccount, code), "recovery");
    assert.equal(await recoveryCodesLeft(h.scope, account.id), 0);
    assert.equal(await verifySecondFactor(h.scope, mfaAccount, code), null);
    assert.equal(h.messages.length, 1);
    await h.drain();
  });

  it("issues expiring tickets, redeems once, and refuses expired or concurrently claimed tickets", async () => {
    const secret = new Uint8Array(20).fill(5);
    const h = apiScope({ account: mfaAccount });
    const sealedAccount = {
      ...mfaAccount,
      mfa_secret: await sealSecret(await sealKey(h.scope), secret, account.id),
    };
    const ticket = await issueMfaTicket(h.scope, sealedAccount);
    const issued = h.db.calls.find((c) => c.sql.startsWith("INSERT INTO mfa_tickets"))!.bindings;
    assert.equal(issued[0], await tokenDigest(ticket));
    assert.ok(Date.parse(String(issued[3])) > Date.parse(String(issued[2])));
    let used: string | null = null;
    let expired = false;
    h.db.on("first", /SELECT \* FROM mfa_tickets/, () => ({
      digest: issued[0],
      account_id: account.id,
      created_at: issued[2],
      expires_at: expired ? "2000-01-01T00:00:00Z" : issued[3],
      attempts: 0,
      used_at: used,
    }));
    h.db.on("first", /SELECT \* FROM accounts/, sealedAccount);
    h.db.on("run", /UPDATE mfa_tickets SET used_at/, (call: D1Call) => {
      used = String(call.bindings[0]);
      return changed(1);
    });
    const body = { ticket, code: await hotp(secret, totpStep(Date.now())) };
    const redeem = () => redeemMfaTicket(apiScope({ db: h.db, body }).scope);
    assert.equal((await redeem()).id, account.id);
    await assert.rejects(redeem(), refusal(401, /expired/));
    used = null;
    expired = true;
    await assert.rejects(redeem(), refusal(401, /expired/));
    expired = false;
    h.db.on("run", /UPDATE mfa_tickets SET attempts/, changed(0));
    await assert.rejects(redeem(), refusal(401, /expired/));
  });

  it("refuses a wrong setup code through mfaRoute without enabling the factor", async () => {
    const h = apiScope({ body: { code: "invalid" } });
    h.scope.session = Promise.resolve({
      digest: "current-session",
      account: {
        ...account,
        mfa_pending_secret: await sealSecret(
          await sealKey(h.scope),
          new Uint8Array(20).fill(5),
          account.id,
        ),
      },
    });
    await assert.rejects(
      mfaRoute(h.scope, ["auth", "mfa", "enable"], "POST"),
      refusal(403, /incorrect/),
    );
    assert.equal(
      h.db.calls.some((c) => c.sql.includes("SET mfa_secret = mfa_pending_secret")),
      false,
    );
  });
});

describe("projects API reauthentication and email", () => {
  it("rejects an incorrect current password with 403", async () => {
    const h = apiScope();
    await assert.rejects(
      requireReauthentication(h.scope, { currentPassword: "wrong" }),
      refusal(403, /current password/),
    );
    assert.equal(h.db.calls.length, 0);
  });

  it("requires the password and MFA before sending verification and old-address notice", async () => {
    const user = {
      ...mfaAccount,
      password_hash: await passwordHash("correct horse battery staple"),
    };
    const make = (extra: object) =>
      apiScope({ account: user, body: { email: "new@example.com", ...extra } });
    const wrong = make({ currentPassword: "wrong" });
    await assert.rejects(
      accountRoute(wrong.scope, ["auth", "email"], "POST"),
      refusal(403, /current password/),
    );
    const missing = make({ currentPassword: "correct horse battery staple" });
    await assert.rejects(
      accountRoute(missing.scope, ["auth", "email"], "POST"),
      refusal(403, /code required/),
    );
    assert.equal(wrong.messages.length + missing.messages.length, 0);
    const h = make({ currentPassword: "correct horse battery staple", code });
    h.db.on("run", /UPDATE mfa_recovery_codes/, changed(1));
    h.db.on("first", /COUNT\(\*\).*mfa_recovery_codes/, { n: 2 });
    h.db.on("first", /SELECT id FROM accounts WHERE email/, null);
    const response = await accountRoute(h.scope, ["auth", "email"], "POST");
    await h.drain();
    assert.equal(response?.status, 202);
    const verify = h.messages.find((m) => m.to === "new@example.com")!;
    const token = /verify-email#token=([^\s]+)/.exec(verify.text)![1];
    const insert = h.db.calls.find((c) => c.sql.startsWith("INSERT INTO auth_actions"))!;
    assert.equal(insert.bindings[0], await tokenDigest(decodeURIComponent(token)));
    assert.deepEqual(insert.bindings.slice(1, 3), [account.id, "new@example.com"]);
    assert.ok(
      h.messages.some((m) => m.to === account.email && m.text.includes("ne***@example.com")),
    );
  });
});

describe("saved collaboration session ownership and sealing", () => {
  it("round-trips sealed credentials and binds them to the account and purpose", async () => {
    const h = apiScope();
    const key = await sealKey(h.scope);
    const secret = new TextEncoder().encode("host-token");
    const sealed = await sealSecret(key, secret, account.id, "collab-host");
    assert.deepEqual(await openSecret(key, sealed, account.id, "collab-host"), secret);
    await assert.rejects(openSecret(key, sealed, "other", "collab-host"));
    await assert.rejects(openSecret(key, sealed, account.id));
  });

  it("only returns a host token to its owner and scopes deletion to that owner", async () => {
    const h = apiScope();
    const hostToken = "a".repeat(64);
    const sealed = await sealSecret(
      await sealKey(h.scope),
      new TextEncoder().encode(hostToken),
      account.id,
      "collab-host",
    );
    h.db.on("first", /SELECT \* FROM collab_sessions/, (call: D1Call) =>
      call.bindings[1] === account.id
        ? { id: "session-id", account_id: account.id, host_token: sealed }
        : null,
    );
    const owner = await collabSessionRoute(
      h.scope,
      ["collab-sessions", "session-id", "host-token"],
      "GET",
    );
    assert.deepEqual(await owner?.json(), { hostToken });
    const other = apiScope({ db: h.db, account: { ...account, id: "other" } });
    await assert.rejects(
      collabSessionRoute(other.scope, ["collab-sessions", "session-id", "host-token"], "GET"),
      refusal(404, /not found/),
    );
    for (const scope of [other.scope, h.scope]) {
      assert.equal(
        (await collabSessionRoute(scope, ["collab-sessions", "session-id"], "DELETE"))?.status,
        204,
      );
      const last = h.db.calls.at(-1)!;
      assert.equal(last.sql, "DELETE FROM collab_sessions WHERE id = ? AND account_id = ?");
      assert.deepEqual(last.bindings, ["session-id", (await scope.session)!.account.id]);
    }
  });
});
