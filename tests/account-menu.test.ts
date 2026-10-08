import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accountAttentionKind,
  accountAttentionView,
  accountNeedsAttention,
  accountTriggerLabel,
  type AccountAttentionInput,
} from "../apps/geolibre-desktop/src/lib/account-menu";

const quiet: AccountAttentionInput = {
  username: "nhut",
  email: "nhut@example.com",
  emailVerifiedAt: "2026-01-01T00:00:00Z",
  mfaEnabled: true,
  mfaRequiredBy: null,
};

describe("account attention", () => {
  it("is quiet when nothing is outstanding", () => {
    assert.equal(accountNeedsAttention(null), false);
    assert.equal(accountNeedsAttention(quiet), false);
    assert.equal(accountAttentionKind(quiet), null);
  });

  it("flags two-factor when a deadline is set and it is off", () => {
    const account = { ...quiet, mfaEnabled: false, mfaRequiredBy: "2026-10-11T00:00:00Z" };
    assert.equal(accountNeedsAttention(account), true);
    assert.equal(accountAttentionKind(account), "mfa");
    assert.equal(accountAttentionView("mfa"), "security");
  });

  it("does not flag two-factor that is off but not required", () => {
    assert.equal(accountNeedsAttention({ ...quiet, mfaEnabled: false }), false);
  });

  it("flags an unverified email, and ignores a missing email", () => {
    const unverified = { ...quiet, emailVerifiedAt: null };
    assert.equal(accountAttentionKind(unverified), "email");
    assert.equal(accountAttentionView("email"), "email");
    assert.equal(accountNeedsAttention({ ...quiet, email: null, emailVerifiedAt: null }), false);
  });

  it("prefers the two-factor deadline over an unverified email", () => {
    const both = {
      ...quiet,
      emailVerifiedAt: null,
      mfaEnabled: false,
      mfaRequiredBy: "2026-10-11T00:00:00Z",
    };
    assert.equal(accountAttentionKind(both), "mfa");
  });
});

describe("account trigger label", () => {
  it("names the account and whose it is", () => {
    assert.equal(
      accountTriggerLabel(quiet, { account: "Account", attention: null }),
      "Account: nhut",
    );
  });

  it("adds the attention sentence", () => {
    assert.equal(
      accountTriggerLabel(quiet, {
        account: "Account",
        attention: "Two-factor authentication is not on",
      }),
      "Account: nhut. Two-factor authentication is not on",
    );
  });

  it("omits a blank username", () => {
    assert.equal(
      accountTriggerLabel({ username: "  " }, { account: "Account", attention: null }),
      "Account",
    );
  });
});
