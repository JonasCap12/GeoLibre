import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  burnRemainingCost,
  passwordHash,
  passwordMatches,
  passwordNeedsRehash,
} from "../workers/projects-api/src/auth";
import {
  AUTH_EVENT_KINDS,
  accountLimitKey,
  auditCutoff,
  auditDetail,
  deviceFamily,
  disableRefusal,
  inviteStatus,
  isNewDevice,
  loginForAudit,
  loginLookup,
  maskEmail,
  passwordPolicyError,
  sessionExpiry,
  sessionNeedsTouch,
  sessionPolicy,
  sessionPruneBounds,
  sessionRefusal,
  shortUserAgent,
  type AuthActionRow,
} from "../workers/projects-api/src/auth-policy";
import { checkPwnedPassword, rangeCount, sha1Hex } from "../workers/projects-api/src/hibp";
import { isAuthRoute, isPublicRoute } from "../workers/projects-api/src/public-routes";
import {
  SITEVERIFY_URL,
  TURNSTILE_ACTIONS,
  turnstileHostnames,
  turnstileVerdict,
  verifyTurnstile,
} from "../workers/projects-api/src/turnstile";
import { TURNSTILE_ACTIONS as CLIENT_TURNSTILE_ACTIONS } from "../apps/geolibre-desktop/src/lib/turnstile";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const policy = sessionPolicy("30", "7");

describe("password context words (NIST 800-63B-4 context-specific words)", () => {
  it("refuses the product name, the username and the email local part", () => {
    assert.equal(passwordPolicyError("my geolibre passphrase"), "context");
    assert.equal(passwordPolicyError("MY GEOLIBRE PASSPHRASE"), "context", "case-insensitive");
    assert.equal(
      passwordPolicyError("hello nguyen-minh-nhut 2026", { username: "nguyen-minh-nhut" }),
      "context",
    );
    assert.equal(
      passwordPolicyError("kythuat loves long words", { email: "kythuat@example.test" }),
      "context",
    );
  });

  it("skips words too short to mean anything", () => {
    // A three-letter username would otherwise reject half of all passphrases.
    assert.equal(passwordPolicyError("correct horse battery staple", { username: "cor" }), null);
  });

  it("has no composition rules", () => {
    assert.equal(passwordPolicyError("all lowercase words here"), null);
  });
});

describe("sessions (ASVS 5.0 V7.3)", () => {
  it("expires at the absolute lifetime even when in constant use", () => {
    const row = {
      created_at: iso(NOW - 31 * DAY),
      expires_at: iso(NOW - DAY),
      last_used_at: iso(NOW - 1000),
    };
    assert.equal(sessionRefusal(row, NOW, policy), "expired");
  });

  it("expires after the idle window", () => {
    const row = {
      created_at: iso(NOW - 10 * DAY),
      expires_at: iso(NOW + 20 * DAY),
      last_used_at: iso(NOW - 7 * DAY - 1),
    };
    assert.equal(sessionRefusal(row, NOW, policy), "idle");
  });

  it("accepts a live session", () => {
    const row = {
      created_at: iso(NOW - 10 * DAY),
      expires_at: iso(NOW + 20 * DAY),
      last_used_at: iso(NOW - DAY),
    };
    assert.equal(sessionRefusal(row, NOW, policy), null);
  });

  it("judges a legacy token (NULL columns) from created_at", () => {
    // Tokens issued before the migration have no expiry. They must not stay
    // valid forever, which is the hole the migration closes.
    const old = { created_at: iso(NOW - 31 * DAY), expires_at: null, last_used_at: null };
    assert.equal(sessionRefusal(old, NOW, policy), "expired");
    const idle = { created_at: iso(NOW - 8 * DAY), expires_at: null, last_used_at: null };
    assert.equal(sessionRefusal(idle, NOW, policy), "idle");
    const fresh = { created_at: iso(NOW - DAY), expires_at: null, last_used_at: null };
    assert.equal(sessionRefusal(fresh, NOW, policy), null);
    assert.equal(sessionExpiry(fresh, policy), iso(NOW - DAY + 30 * DAY));
  });

  it("refuses an unparseable timestamp rather than accepting it", () => {
    const row = { created_at: "garbage", expires_at: null, last_used_at: null };
    assert.equal(sessionRefusal(row, NOW, policy), "expired");
  });

  it("writes last_used_at at most once an hour", () => {
    const row = {
      created_at: iso(NOW - DAY),
      expires_at: null,
      last_used_at: iso(NOW - 59 * 60_000),
    };
    assert.equal(sessionNeedsTouch(row, NOW), false);
    assert.equal(sessionNeedsTouch({ ...row, last_used_at: iso(NOW - 61 * 60_000) }, NOW), true);
  });

  it("reads the vars, falls back on junk, and clamps idle to the lifetime", () => {
    assert.deepEqual(sessionPolicy(undefined, undefined), { ttlMs: 30 * DAY, idleMs: 7 * DAY });
    assert.deepEqual(sessionPolicy("abc", "-1"), { ttlMs: 30 * DAY, idleMs: 7 * DAY });
    assert.deepEqual(sessionPolicy("3", "10"), { ttlMs: 3 * DAY, idleMs: 3 * DAY });
  });

  it("prunes by the same rule it refuses by", () => {
    const bounds = sessionPruneBounds(NOW, policy);
    assert.equal(bounds.now, iso(NOW));
    assert.equal(bounds.createdBefore, iso(NOW - 30 * DAY));
    assert.equal(bounds.idleBefore, iso(NOW - 7 * DAY));
  });
});

describe("sign-in lookup", () => {
  it("accepts a username or an email, normalised", () => {
    assert.deepEqual(loginLookup("Nguyen-Minh-Nhut"), {
      column: "username",
      value: "nguyen-minh-nhut",
    });
    assert.deepEqual(loginLookup("  KyThuat@Example.TEST "), {
      column: "email",
      value: "kythuat@example.test",
    });
  });

  it("keys the per-account limiter on what was typed, existing or not", () => {
    const lookup = loginLookup("someone@example.test");
    assert.ok(lookup);
    assert.equal(accountLimitKey(lookup), "token-account:someone@example.test");
  });

  it("never writes a password typed into the username box to the audit log", () => {
    assert.equal(loginForAudit("correct horse battery staple"), "<unrecognised>");
    assert.equal(loginForAudit("ky-thuat"), "ky-thuat");
    assert.equal(loginForAudit(42), "<unrecognised>");
  });
});

describe("devices", () => {
  it("strips control characters and caps the length", () => {
    assert.equal(shortUserAgent("a\u0000b\nc"), "abc");
    assert.equal(shortUserAgent("x".repeat(500)).length, 160);
    assert.equal(shortUserAgent(null), "");
  });

  it("treats a browser update as the same device", () => {
    const before = "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0.6613.84";
    const after = "Mozilla/5.0 (Windows NT 10.0) Chrome/129.0.6668.58";
    assert.equal(deviceFamily(before), deviceFamily(after));
    assert.equal(isNewDevice([before], after), false);
    assert.equal(isNewDevice([before], "Mozilla/5.0 (iPhone) Safari/604.1"), true);
  });

  it("does not mail anyone on their first recorded sign-in", () => {
    assert.equal(isNewDevice([], "anything"), false);
  });
});

describe("invites and admin", () => {
  const row = (over: Partial<AuthActionRow>): AuthActionRow => ({
    digest: "d",
    kind: "invite",
    account_id: null,
    email: "a@b.c",
    created_at: iso(NOW - DAY),
    expires_at: iso(NOW + DAY),
    used_at: null,
    created_by: null,
    ...over,
  });

  it("reports pending, used and expired", () => {
    assert.equal(inviteStatus(row({}), iso(NOW)), "pending");
    assert.equal(inviteStatus(row({ used_at: iso(NOW) }), iso(NOW)), "used");
    assert.equal(inviteStatus(row({ expires_at: iso(NOW - 1) }), iso(NOW)), "expired");
  });

  it("masks the invited address", () => {
    assert.equal(maskEmail("nguyen@example.test"), "ng****@example.test");
    assert.equal(maskEmail("ab@example.test"), "a***@example.test");
    assert.equal(maskEmail("broken"), "***");
  });

  it("refuses to disable the last enabled admin", () => {
    assert.equal(
      disableRefusal({ targetId: "a", targetIsAdmin: true, enabledAdminIds: ["a"] }),
      "last-admin",
    );
    assert.equal(
      disableRefusal({ targetId: "a", targetIsAdmin: true, enabledAdminIds: ["a", "b"] }),
      null,
    );
    assert.equal(
      disableRefusal({ targetId: "m", targetIsAdmin: false, enabledAdminIds: [] }),
      null,
    );
  });
});

describe("audit log", () => {
  it("drops oversized detail instead of cutting JSON in half", () => {
    assert.equal(auditDetail({ a: 1 }), '{"a":1}');
    assert.equal(auditDetail({ big: "x".repeat(600) }), '{"truncated":true}');
  });

  it("prunes by the activity retention", () => {
    assert.equal(auditCutoff(NOW, 90), iso(NOW - 90 * DAY));
  });

  it("has an event kind for each thing the spec asks to log", () => {
    for (const kind of [
      "login_success",
      "login_failure",
      "logout",
      "password_changed",
      "reset_requested",
      "reset_completed",
      "invite_created",
      "invite_used",
      "email_changed",
      "account_disabled",
    ]) {
      assert.ok((AUTH_EVENT_KINDS as readonly string[]).includes(kind), kind);
    }
  });
});

describe("password hashes", () => {
  it("writes the versioned p=5 encoding and still verifies the old one", async () => {
    const encoded = await passwordHash("correct horse battery staple");
    assert.match(encoded, /^scrypt2\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.equal(await passwordMatches("correct horse battery staple", encoded), true);
    assert.equal(await passwordMatches("wrong horse battery staple", encoded), false);
    assert.equal(passwordNeedsRehash(encoded), false);
    // A hash from before this change, as the Python reference writes it.
    assert.equal(passwordNeedsRehash("scrypt$00$00"), true);
  });

  it("refuses an unknown prefix instead of guessing parameters", async () => {
    assert.equal(await passwordMatches("x", "bcrypt$abc$def"), false);
  });

  it("tops up the cost of a legacy verify so timing does not reveal the hash version", async () => {
    // burnRemainingCost must not throw for either encoding; its timing is
    // what it is for and is not asserted here.
    await burnRemainingCost("x", "scrypt$00$00");
    await burnRemainingCost("x", "scrypt2$00$00");
  });
});

describe("breached passwords (HIBP range API)", () => {
  it("ignores padding rows, which carry a count of 0", () => {
    const body = "AAAAA:0\r\nBBBBB:12\r\n";
    assert.equal(rangeCount(body, "aaaaa"), 0);
    assert.equal(rangeCount(body, "BBBBB"), 12);
    assert.equal(rangeCount(body, "CCCCC"), 0);
  });

  it("sends only the five-character prefix, with padding requested", async () => {
    const hash = await sha1Hex("password1234567890");
    let seenUrl = "";
    let seenHeaders = new Headers();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenHeaders = new Headers(init.headers);
      return new Response(`${hash.slice(5)}:4200\r\nFFFFF:0`);
    }) as unknown as typeof fetch;
    const result = await checkPwnedPassword("password1234567890", fetchImpl);
    assert.deepEqual(result, { pwned: true, checked: true });
    assert.ok(seenUrl.endsWith(`/range/${hash.slice(0, 5)}`));
    assert.ok(!seenUrl.includes(hash.slice(5)), "the suffix must never leave the Worker");
    assert.equal(seenHeaders.get("Add-Padding"), "true");
  });

  it("fails open on an error status, a network error, and a timeout", async () => {
    const status = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    assert.deepEqual(await checkPwnedPassword("x", status), { pwned: false, checked: false });
    const offline = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    assert.deepEqual(await checkPwnedPassword("x", offline), { pwned: false, checked: false });
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    assert.deepEqual(await checkPwnedPassword("x", hang, 20), { pwned: false, checked: false });
  });
});

describe("Turnstile siteverify", () => {
  const expected = { action: TURNSTILE_ACTIONS.register, hostnames: ["app.example.test"] };

  it("checks success, hostname and action, not only success", () => {
    const ok = { success: true, hostname: "app.example.test", action: "register" };
    assert.equal(turnstileVerdict(ok, expected), null);
    assert.equal(turnstileVerdict({ ...ok, success: false }, expected), "rejected");
    assert.equal(turnstileVerdict({ ...ok, hostname: "evil.test" }, expected), "hostname");
    assert.equal(turnstileVerdict({ ...ok, action: "reset-request" }, expected), "action");
  });

  it("derives hostnames from the CORS origins", () => {
    assert.deepEqual(
      turnstileHostnames(["https://app.example.test", "*", "not a url", "http://localhost:5173"]),
      ["app.example.test", "localhost"],
    );
  });

  it("posts secret, response, remoteip and an idempotency key", async () => {
    let seen: FormData | null = null;
    let seenUrl = "";
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seen = init.body as FormData;
      return Response.json({ success: true, hostname: "app.example.test", action: "register" });
    }) as unknown as typeof fetch;
    const verdict = await verifyTurnstile({
      secret: "s3cret",
      token: "tok",
      remoteIp: "203.0.113.9",
      action: TURNSTILE_ACTIONS.register,
      hostnames: ["app.example.test"],
      fetchImpl,
    });
    assert.equal(verdict, null);
    assert.equal(seenUrl, SITEVERIFY_URL);
    const form = seen as unknown as FormData;
    assert.equal(form.get("secret"), "s3cret");
    assert.equal(form.get("response"), "tok");
    assert.equal(form.get("remoteip"), "203.0.113.9");
    assert.match(String(form.get("idempotency_key")), /^[0-9a-f-]{36}$/);
  });

  it("refuses a missing token without a round trip, and fails closed when unreachable", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const base = {
      secret: "s",
      remoteIp: null,
      action: TURNSTILE_ACTIONS.resetRequest,
      hostnames: [],
      fetchImpl,
    };
    assert.equal(await verifyTurnstile({ ...base, token: "" }), "missing");
    assert.equal(called, false);
    assert.equal(await verifyTurnstile({ ...base, token: "tok" }), "unavailable");
  });

  it("uses the same action strings on client and server", () => {
    assert.deepEqual(CLIENT_TURNSTILE_ACTIONS, TURNSTILE_ACTIONS);
  });
});

describe("new auth routes", () => {
  it("opens exactly the unauthenticated ones", () => {
    for (const [method, path] of [
      ["POST", "/api/invites/inspect"],
      ["POST", "/api/auth/email-confirm"],
      ["POST", "/api/auth/reset-confirm"],
    ] as const) {
      assert.equal(isPublicRoute(method, path.split("/").filter(Boolean)), true, path);
    }
    for (const [method, path] of [
      ["GET", "/api/auth/sessions"],
      ["DELETE", "/api/auth/sessions"],
      ["POST", "/api/auth/email"],
      ["GET", "/api/admin/invites"],
      ["GET", "/api/admin/events"],
      ["POST", "/api/admin/accounts/x/disable"],
    ] as const) {
      assert.equal(isPublicRoute(method, path.split("/").filter(Boolean)), false, path);
    }
  });

  it("marks auth responses no-store and leaves the rest alone", () => {
    assert.equal(isAuthRoute(["api", "auth", "token"]), true);
    assert.equal(isAuthRoute(["api", "admin", "events"]), true);
    assert.equal(isAuthRoute(["api", "account"]), true);
    assert.equal(isAuthRoute(["api", "users", "me"]), true);
    assert.equal(isAuthRoute(["api", "projects"]), false);
    assert.equal(isAuthRoute(["health"]), false);
  });
});
