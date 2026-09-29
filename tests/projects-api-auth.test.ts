import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/**
 * POST /api/accounts used to mint an account for anyone who knew the hostname.
 * The six staff passwords were also permanent, and a forgotten one could not be
 * recovered because an account had no email. These rules are what close that.
 *
 * The Worker entry imports the Workers runtime, so Node cannot load it. The
 * decisions live in auth-policy.ts and the entry calls them. A source check at
 * the bottom is the wiring the runner cannot execute.
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
  it("rejects 11 characters and accepts 12", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 12);
    assert.equal(passwordPolicyError("x".repeat(11)), "too-short");
    assert.equal(passwordPolicyError("x".repeat(12)), null);
  });

  it("requires the current password to be checked by the caller", () => {
    // The policy module does not know the stored hash. The entry refuses the
    // change unless passwordMatches says the current one is right; this pins
    // that the route still says so.
    const source = readFileSync(
      new URL("../workers/projects-api/src/index.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /current password is incorrect/);
    assert.match(source, /passwordMatches\(current, account\.password_hash\)/);
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
  it("does not register an account without asking the invite rule, and it deletes sessions", () => {
    // index.ts cannot be imported under Node. This is the check that the
    // route still calls the rule and still revokes tokens for the account,
    // not only the one digest presented on sign-out.
    const source = readFileSync(
      new URL("../workers/projects-api/src/index.ts", import.meta.url),
      "utf8",
    );
    assert.match(source, /registrationRefusal/);
    assert.match(source, /DELETE FROM tokens WHERE account_id = \?/);
    assert.match(source, /isAdminUsername/);
  });
});
