import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { authErrorCode, newPasswordProblem } from "../apps/geolibre-desktop/src/lib/share-account";
import {
  passwordPolicyMessage,
  type PasswordPolicyError,
} from "../workers/projects-api/src/auth-policy";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPassword,
  passwordProblem,
  scoreFromBits,
} from "../workers/projects-api/src/password-strength";

const CONTEXT = { username: "nhut", email: "nhut.nm@cc1.vn" };

describe("password rules: one implementation, two copies", () => {
  it("keeps the API and app copies byte-identical", () => {
    // The server enforces these rules and the app shows them while someone
    // types. If the copies drift, the checklist approves a password the
    // server then refuses, or the reverse.
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
    assert.equal(
      read("../apps/geolibre-desktop/src/lib/password-strength.ts"),
      read("../workers/projects-api/src/password-strength.ts"),
    );
  });
});

describe("password rules", () => {
  it("sets the floor at 8 and allows long passphrases", () => {
    assert.equal(MIN_PASSWORD_LENGTH, 8);
    assert.ok(MAX_PASSWORD_LENGTH >= 64, "NIST SP 800-63B-4 asks for at least 64");
    assert.equal(passwordProblem("dung2k3"), "too-short");
    assert.equal(passwordProblem("x".repeat(MAX_PASSWORD_LENGTH + 1)), "too-long");
  });

  for (const [password, why] of [
    ["12345678", "a sequence"],
    ["abcdefgh", "a sequence"],
    ["87654321", "a sequence"],
    ["qwertyui", "a keyboard run"],
    ["1qaz2wsx", "a keyboard run"],
    ["aaaaaaaa", "one repeated character"],
    ["abababab", "two characters"],
    ["Password123!", "a common word decorated"],
    ["matkhau@2026", "a common Vietnamese word decorated"],
    ["hello2026", "a common word and a year"],
    ["Abcd1234", "common bases"],
    ["iloveyou99", "a common phrase"],
  ] as const) {
    it(`refuses ${why}: ${password}`, () => {
      assert.equal(passwordProblem(password), "common");
      assert.equal(checkPassword(password).score, 0);
    });
  }

  it("refuses a password built on the account's own name, but not on a short one", () => {
    assert.equal(passwordProblem("nhut1234567!", CONTEXT), "context");
    assert.equal(passwordProblem("my nhut.nm garden", CONTEXT), "context");
    assert.equal(passwordProblem("geolibre rocks hard"), "context");
    // Under four letters a name is too short to be a meaningful match.
    assert.equal(passwordProblem("abc garden party", { username: "abc" }), null);
  });

  it("refuses an eight-character password with too little variety", () => {
    assert.equal(passwordProblem("kpqzmrtv"), "weak");
    assert.equal(passwordProblem("20261004"), "weak");
  });

  for (const password of [
    "dung2k3!",
    "MayBay#79",
    "hoaanhdao",
    "sunflower",
    "correct horse battery staple",
    "cá vàng bơi lội",
    "Bình Minh Đẹp",
  ]) {
    it(`accepts ${password}`, () => {
      assert.equal(passwordProblem(password, CONTEXT), null);
      assert.ok(checkPassword(password, CONTEXT).ok);
    });
  }

  it("needs no symbols once a passphrase is long enough", () => {
    assert.ok(checkPassword("correct horse battery staple").score >= 3);
  });

  it("scores from the estimated search space", () => {
    assert.deepEqual(
      [0, 27.9, 28, 35.9, 36, 49.9, 50, 69.9, 70].map(scoreFromBits),
      [0, 0, 1, 1, 2, 2, 3, 3, 4],
    );
  });
});

describe("server messages reach the app as the right code", () => {
  const expected: Record<PasswordPolicyError, string> = {
    "too-short": "password-short",
    "too-long": "password-long",
    context: "password-context",
    common: "password-common",
    weak: "password-weak",
  };
  for (const [code, client] of Object.entries(expected)) {
    it(`${code} → ${client}`, () => {
      const message = passwordPolicyMessage(code as PasswordPolicyError);
      assert.equal(authErrorCode(422, message), client);
    });
  }

  it("refuses the same passwords in the app as on the server", () => {
    for (const password of ["dung2k3", "Password123!", "kpqzmrtv", "nhut1234567!", "dung2k3!"]) {
      const server = passwordProblem(password, CONTEXT);
      const app = newPasswordProblem(password, CONTEXT);
      assert.equal(app, server === null ? null : expected[server], password);
    }
  });
});
