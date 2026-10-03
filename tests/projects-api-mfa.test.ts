import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MFA_TICKET_MAX_ATTEMPTS,
  MFA_TICKET_TTL_MS,
  expiresAt,
  mfaTicketRefusal,
  type MfaTicketRow,
} from "../workers/projects-api/src/auth-policy";
import {
  RECOVERY_CODE_COUNT,
  TOTP_STEP_SECONDS,
  base32Decode,
  base32Encode,
  hotp,
  importSealKey,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  openSecret,
  otpauthUri,
  recoveryCodeDigest,
  sealSecret,
  totpStep,
  verifyTotp,
} from "../workers/projects-api/src/totp";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA-1.
// Its table lists eight digits; the six-digit code is the last six of those,
// because both are the same truncated integer modulo a power of ten.
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_VECTORS: Array<[seconds: number, eightDigits: string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

const atSeconds = (seconds: number) => seconds * 1000;

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 6238 SHA-1 test vectors", async () => {
    for (const [seconds, eight] of RFC_VECTORS) {
      const code = await hotp(RFC_SECRET, totpStep(atSeconds(seconds)));
      assert.equal(code, eight.slice(-6), `T=${seconds}`);
    }
  });

  it("matches the RFC 4226 HOTP vectors", async () => {
    // Appendix D, same seed, counters 0-9.
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (const [counter, code] of expected.entries()) {
      assert.equal(await hotp(RFC_SECRET, counter), code, `counter ${counter}`);
    }
  });

  it("accepts one step of drift either way and no more", async () => {
    const nowMs = atSeconds(1111111111);
    const step = totpStep(nowMs);
    for (const offset of [-1, 0, 1]) {
      const code = await hotp(RFC_SECRET, step + offset);
      assert.equal(await verifyTotp(RFC_SECRET, code, nowMs, null), step + offset);
    }
    for (const offset of [-2, 2]) {
      const code = await hotp(RFC_SECRET, step + offset);
      assert.equal(await verifyTotp(RFC_SECRET, code, nowMs, null), null, `offset ${offset}`);
    }
  });

  it("refuses a code from a step that was already used", async () => {
    const nowMs = atSeconds(1234567890);
    const step = totpStep(nowMs);
    const code = await hotp(RFC_SECRET, step);
    assert.equal(await verifyTotp(RFC_SECRET, code, nowMs, null), step);
    assert.equal(await verifyTotp(RFC_SECRET, code, nowMs, step), null);
    // An earlier code inside the window is refused once a later one was used.
    const earlier = await hotp(RFC_SECRET, step - 1);
    assert.equal(await verifyTotp(RFC_SECRET, earlier, nowMs, step), null);
    // The next step's code still works.
    const later = await hotp(RFC_SECRET, step + 1);
    assert.equal(await verifyTotp(RFC_SECRET, later, nowMs, step), step + 1);
  });

  it("takes codes the way authenticator apps show them", async () => {
    const nowMs = atSeconds(59);
    assert.equal(await verifyTotp(RFC_SECRET, " 287 082 ", nowMs, null), totpStep(nowMs));
    assert.equal(normalizeTotpCode("287 082"), "287082");
    assert.equal(normalizeTotpCode("28708"), null);
    assert.equal(normalizeTotpCode("2870820"), null);
    assert.equal(normalizeTotpCode("abcdef"), null);
    assert.equal(await verifyTotp(RFC_SECRET, "", nowMs, null), null);
  });

  it("uses 30-second steps", () => {
    assert.equal(TOTP_STEP_SECONDS, 30);
    assert.equal(totpStep(atSeconds(29)), 0);
    assert.equal(totpStep(atSeconds(30)), 1);
  });
});

describe("base32 and provisioning", () => {
  it("round-trips and matches RFC 4648 vectors", () => {
    const encoder = new TextEncoder();
    assert.equal(base32Encode(encoder.encode("foobar")), "MZXW6YTBOI");
    assert.equal(base32Encode(encoder.encode("f")), "MY");
    assert.deepEqual(base32Decode("mzxw6ytboi======"), encoder.encode("foobar"));
    assert.deepEqual(base32Decode("MZXW 6YTB OI"), encoder.encode("foobar"));
    assert.throws(() => base32Decode("MZXW1"));
    const secret = newTotpSecret();
    assert.equal(secret.length, 20);
    assert.deepEqual(base32Decode(base32Encode(secret)), secret);
  });

  it("builds an otpauth URI authenticator apps read", () => {
    const uri = new URL(
      otpauthUri({ issuer: "GeoLibre", account: "an@example.com", secret: "JBSWY3DPEHPK3PXP" }),
    );
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.host, "totp");
    assert.equal(decodeURIComponent(uri.pathname), "/GeoLibre:an@example.com");
    assert.equal(uri.searchParams.get("secret"), "JBSWY3DPEHPK3PXP");
    assert.equal(uri.searchParams.get("issuer"), "GeoLibre");
    assert.equal(uri.searchParams.get("digits"), "6");
    assert.equal(uri.searchParams.get("period"), "30");
    assert.equal(uri.searchParams.get("algorithm"), "SHA1");
  });
});

describe("recovery codes", () => {
  it("issues ten distinct high-entropy codes", () => {
    const codes = newRecoveryCodes();
    assert.equal(codes.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(codes).size, codes.length);
    // 24 base32 characters = 120 bits, over ASVS V6.5.2's 112-bit floor for a plain hash.
    for (const code of codes) assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}$/);
  });

  it("normalizes what people type and hashes it", async () => {
    const [code] = newRecoveryCodes(1);
    const normalized = normalizeRecoveryCode(code);
    assert.ok(normalized);
    assert.equal(normalizeRecoveryCode(code.toLowerCase().replace(/-/g, " ")), normalized);
    assert.equal(normalizeRecoveryCode("123456"), null);
    assert.equal(normalizeRecoveryCode("ABCD-EFGH"), null);
    assert.equal(normalizeRecoveryCode("ABCD-EFGH-JKLM-NPQR"), null);
    const digest = await recoveryCodeDigest(normalized!);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest.includes(normalized!), false);
  });
});

describe("sealing the TOTP secret", () => {
  const rawKey = Buffer.alloc(32, 7).toString("base64");

  it("round-trips for the same account", async () => {
    const key = (await importSealKey(rawKey))!;
    const secret = newTotpSecret();
    const sealed = await sealSecret(key, secret, "acct-1");
    assert.match(sealed, /^v1\.[\w-]+\.[\w-]+$/);
    assert.equal(sealed.includes(base32Encode(secret)), false);
    assert.deepEqual(await openSecret(key, sealed, "acct-1"), secret);
  });

  it("refuses another account, a tampered value, and a different key", async () => {
    const key = (await importSealKey(rawKey))!;
    const sealed = await sealSecret(key, newTotpSecret(), "acct-1");
    await assert.rejects(openSecret(key, sealed, "acct-2"));
    const [version, iv, body] = sealed.split(".");
    const flipped = body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`;
    await assert.rejects(openSecret(key, `${version}.${iv}.${flipped}`, "acct-1"));
    const other = (await importSealKey(Buffer.alloc(32, 8).toString("base64url")))!;
    await assert.rejects(openSecret(other, sealed, "acct-1"));
    await assert.rejects(openSecret(key, "v0.x.y", "acct-1"));
  });

  it("treats an unset key as off and a wrong-length key as an error", async () => {
    assert.equal(await importSealKey(undefined), null);
    assert.equal(await importSealKey("  "), null);
    await assert.rejects(importSealKey(Buffer.alloc(16).toString("base64")), /32 bytes/);
  });
});

describe("sign-in ticket policy", () => {
  const nowMs = Date.UTC(2026, 0, 1);
  const nowIso = new Date(nowMs).toISOString();
  const ticket = (over: Partial<MfaTicketRow> = {}): MfaTicketRow => ({
    digest: "d",
    account_id: "a",
    created_at: nowIso,
    expires_at: expiresAt(nowMs, MFA_TICKET_TTL_MS),
    attempts: 0,
    used_at: null,
    ...over,
  });

  it("lives five minutes and takes five codes", () => {
    assert.equal(MFA_TICKET_TTL_MS, 5 * 60 * 1000);
    assert.equal(MFA_TICKET_MAX_ATTEMPTS, 5);
  });

  it("refuses missing, used, expired and exhausted tickets", () => {
    assert.equal(mfaTicketRefusal(ticket(), nowIso), null);
    assert.equal(mfaTicketRefusal(null, nowIso), "missing");
    assert.equal(mfaTicketRefusal(ticket({ used_at: nowIso }), nowIso), "used");
    const later = new Date(nowMs + MFA_TICKET_TTL_MS).toISOString();
    assert.equal(mfaTicketRefusal(ticket(), later), "expired");
    assert.equal(mfaTicketRefusal(ticket({ attempts: MFA_TICKET_MAX_ATTEMPTS - 1 }), nowIso), null);
    assert.equal(
      mfaTicketRefusal(ticket({ attempts: MFA_TICKET_MAX_ATTEMPTS }), nowIso),
      "exhausted",
    );
  });
});
