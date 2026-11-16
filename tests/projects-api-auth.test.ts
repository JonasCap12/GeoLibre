import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_PASSWORD_LENGTH,
  RESET_REQUEST_BODY,
  actionRefusal,
  isAdminUsername,
  passwordPolicyError,
  registrationRefusal,
  resetRequestReply,
  sessionsAfterCredentialChange,
  type AuthActionRow,
} from "../workers/projects-api/src/auth-policy.ts";
import { apiScope, signedInRow, worker } from "./helpers/projects-api";

/**
 * POST /api/accounts used to mint an account for anyone who knew the hostname.
 * The six staff passwords were also permanent, and a forgotten one could not be
 * recovered because an account had no email. These rules are what close that.
 *
 * Exercise the policy and the fetch handler so dispatch cannot bypass it.
 */

const NOW = "2026-09-29T02:00:00.000Z";

function action(over: Partial<AuthActionRow> = {}): AuthActionRow {
  return {
    digest: "abc",
    kind: "invite",
    account_id: null,
    email: "a@example.com",
    created_at: "2026-09-29T00:00:00.000Z",
    expires_at: "2026-10-02T00:00:00.000Z",
    used_at: null,
    created_by: "admin",
    ...over,
  };
}

describe("registration requires an invite", () => {
  it("refuses registration when there is no invite", () => {
    assert.equal(registrationRefusal(null, NOW), "missing");
  });

  it("refuses the second use of an invite", () => {
    const row = action({ used_at: "2026-09-29T01:00:00.000Z" });
    assert.equal(registrationRefusal(row, NOW), "used");
    assert.equal(registrationRefusal(action({ used_at: null }), NOW), null);
  });

  it("refuses an expired invite", () => {
    assert.equal(
      registrationRefusal(action({ expires_at: "2026-09-29T01:00:00.000Z" }), NOW),
      "expired",
    );
  });
});

describe("password reset", () => {
  it("returns the same response whether or not the email exists", () => {
    const known = resetRequestReply(true);
    const unknown = resetRequestReply(false);
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
    assert.deepEqual(known.body, RESET_REQUEST_BODY);
    assert.equal(known.send, true);
    assert.equal(unknown.send, false);
  });

  it("refuses a reset token that was already used or has expired", () => {
    const reset = action({
      kind: "reset",
      account_id: "acct",
      expires_at: "2026-09-29T02:30:00.000Z",
    });
    assert.equal(actionRefusal(reset, "reset", NOW), null);
    assert.equal(actionRefusal({ ...reset, used_at: NOW }, "reset", NOW), "used");
    assert.equal(
      actionRefusal({ ...reset, expires_at: "2026-09-29T01:00:00.000Z" }, "reset", NOW),
      "expired",
    );
  });

  it("revokes every session for the account whose password just changed", () => {
    const left = sessionsAfterCredentialChange(
      [
        { digest: "ours", accountId: "acct" },
        { digest: "attacker", accountId: "acct" },
        { digest: "other", accountId: "someone-else" },
      ],
      "acct",
    );
    assert.deepEqual(left, [{ digest: "other", accountId: "someone-else" }]);
  });
});

describe("password policy", () => {
  it("sets the floor at 8 characters (OWASP ASVS 5.0 V6.2.1)", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.equal(passwordPolicyError("dung2k3"), "too-short");
    assert.equal(passwordPolicyError("dung2k3!"), null);
  });

  it("rejects a password change with the wrong current password", async () => {
    const h = apiScope({
      path: "/api/auth/password",
      body: {
        currentPassword: "wrong",
        password: "Replacement$Passphrase72!",
      },
    });
    h.db.on("first", /FROM accounts a JOIN tokens/, signedInRow());
    h.scope.request.headers.set("Authorization", "Bearer session-token");
    const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "current password is incorrect" });
    assert.equal(
      h.db.calls.some((c) => c.sql.startsWith("UPDATE accounts SET password_hash")),
      false,
    );
  });
});

describe("invites are admin-only", () => {
  it("refuses a non-admin, and everyone when the list is unset", () => {
    assert.equal(isAdminUsername("nguyen-minh-nhut", undefined), false);
    assert.equal(isAdminUsername("nguyen-minh-nhut", ""), false);
    assert.equal(isAdminUsername("nguyen-minh-nhut", "other"), false);
    assert.equal(isAdminUsername("nguyen-minh-nhut", "nguyen-minh-nhut"), true);
    assert.equal(isAdminUsername(null, "nguyen-minh-nhut"), false);
  });
});

describe("the worker entry uses these decisions", () => {
  it("refuses registration without an invite and revokes all account sessions on logout", async () => {
    const register = apiScope({
      path: "/api/accounts",
      body: {
        username: "new-user",
        password: "Replacement$Passphrase72!",
      },
    });
    const refused = await worker.fetch(
      register.scope.request,
      register.scope.env,
      register.scope.ctx,
    );
    assert.equal(refused.status, 403);
    assert.deepEqual(await refused.json(), { error: "invite is invalid or expired" });
    assert.equal(register.db.calls.length, 0);
    const h = apiScope({ path: "/api/auth/sessions", method: "DELETE" });
    h.db.on("first", /FROM accounts a JOIN tokens/, signedInRow());
    h.scope.request.headers.set("Authorization", "Bearer session-token");
    const response = await worker.fetch(h.scope.request, h.scope.env, h.scope.ctx);
    assert.equal(response.status, 204);
    assert.deepEqual(
      h.db.calls.find((c) => c.sql === "DELETE FROM tokens WHERE account_id = ?")?.bindings,
      ["owner"],
    );
    await h.drain();
  });
});
