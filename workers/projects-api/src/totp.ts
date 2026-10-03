// Second factor: TOTP (RFC 6238), recovery codes, and sealing the TOTP secret.
//
// WebCrypto only, so it runs unchanged in workerd and under `node --test` and
// adds no dependency. Pure: no D1, no env. The routes that use it are in
// mfa-routes.ts.
//
// Parameters are the ones every authenticator app defaults to (SHA-1, six
// digits, 30-second steps). SHA-1 is fine here: HMAC-SHA-1 is not affected by
// SHA-1 collisions, and RFC 6238 apps that ignore `algorithm=` assume it.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of now, for clock drift (RFC 6238 §5.2). */
export const TOTP_WINDOW = 1;
/** 160 bits, the HMAC-SHA-1 block-friendly size RFC 4226 §4 recommends. */
export const TOTP_SECRET_BYTES = 20;

export const RECOVERY_CODE_COUNT = 10;
/**
 * 120 bits each. ASVS 5.0 V6.5.2 allows a plain hash only for lookup secrets
 * of at least 112 bits; below that each check would need a slow hash per code.
 */
const RECOVERY_CODE_BYTES = 15;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Accepts lower case, spaces and `=` padding, as people copy secrets in all three. */
export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=]/g, "");
  if (!/^[A-Z2-7]*$/.test(clean)) throw new Error("invalid base32");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function newTotpSecret(): Uint8Array {
  return randomBytes(TOTP_SECRET_BYTES);
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** HOTP (RFC 4226 §5.3) for one counter value. */
export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const message = new Uint8Array(8);
  // Counters stay far below 2^53, so splitting into two 32-bit halves is exact.
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Six digits once spaces are removed, or null. Authenticator apps show "123 456". */
export function normalizeTotpCode(raw: string): string | null {
  const code = raw.replace(/\s/g, "");
  return /^\d{6}$/.test(code) ? code : null;
}

function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * The time step a code matches, or null.
 *
 * Steps at or below `lastUsedStep` never match: a code that already signed
 * someone in must not sign in a second time (RFC 6238 §5.2, ASVS 5.0 V6.5.1),
 * even inside its 30 seconds. The caller stores the returned step.
 */
export async function verifyTotp(
  secret: Uint8Array,
  rawCode: string,
  nowMs: number,
  lastUsedStep: number | null,
): Promise<number | null> {
  const code = normalizeTotpCode(rawCode);
  if (code === null) return null;
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Every candidate is computed and compared, so the time taken does not say
  // which step (if any) matched.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step += 1) {
    const expected = await hotp(secret, step);
    const fresh = lastUsedStep === null || step > lastUsedStep;
    if (constantTimeEquals(expected, code) && fresh && matched === null) matched = step;
  }
  return matched;
}

/** The provisioning URI authenticator apps read from the QR code. */
export function otpauthUri(options: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(options.issuer);
  const label = `${issuer}:${encodeURIComponent(options.account)}`;
  const query = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** `ABCD-EFGH-JKLM-NPQR-STUV-WXYZ`: 24 base32 characters in groups of four. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () =>
    base32Encode(randomBytes(RECOVERY_CODE_BYTES)).match(/.{4}/g)!.join("-"),
  );
}

/** Upper case, no separators, 24 base32 characters; or null. */
export function normalizeRecoveryCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z2-7]{24}$/.test(code) ? code : null;
}

/**
 * SHA-256 of the normalized code. No salt or slow hash: each code carries 120
 * random bits, so there is no dictionary to precompute against.
 */
export async function recoveryCodeDigest(normalized: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Sealing the TOTP secret at rest
// ---------------------------------------------------------------------------

const SEAL_VERSION = "v1";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Decode(text: string): Uint8Array {
  const standard = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * The AES-256-GCM key from MFA_ENCRYPTION_KEY (base64 or base64url of 32
 * bytes), or null when unset. A value of the wrong length throws: silently
 * running without encryption, or with a truncated key, is worse than a 500.
 */
export async function importSealKey(raw: string | undefined): Promise<CryptoKey | null> {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  let bytes: Uint8Array;
  try {
    bytes = base64Decode(text);
  } catch {
    throw new Error("MFA_ENCRYPTION_KEY is not valid base64");
  }
  if (bytes.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

// The account id is authenticated data, so a sealed secret copied onto another
// account's row fails to open instead of becoming that account's factor.
const sealContext = (accountId: string): Uint8Array =>
  new TextEncoder().encode(`geolibre-mfa:${accountId}`);

export async function sealSecret(
  key: CryptoKey,
  secret: Uint8Array,
  accountId: string,
): Promise<string> {
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: sealContext(accountId) },
    key,
    secret,
  );
  return `${SEAL_VERSION}.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(sealed))}`;
}

/** Throws on a tampered value, a wrong key, or another account's secret. */
export async function openSecret(
  key: CryptoKey,
  sealed: string,
  accountId: string,
): Promise<Uint8Array> {
  const [version, iv, body] = sealed.split(".");
  if (version !== SEAL_VERSION || !iv || !body) throw new Error("unrecognised sealed secret");
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(iv), additionalData: sealContext(accountId) },
    key,
    base64Decode(body),
  );
  return new Uint8Array(opened);
}
