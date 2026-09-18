// Password hashing, bearer tokens, and account resolution.
//
// The hash encoding is byte-for-byte what backend/geolibre_server_api produces:
// scrypt with n=2^14, r=8, p=1 and a 64-byte derived key (Python's
// hashlib.scrypt default dklen), stored as `scrypt$<salt hex>$<digest hex>`.
// Keeping the parameters identical is the whole reason an imported accounts
// table keeps working -- change any of them and every stored password becomes
// unverifiable, which is a forced reset for every user.
//
// scrypt-js rather than node:crypto: the Workers Node compatibility layer does
// not reliably expose scrypt, and WebCrypto has no scrypt at all (PBKDF2 and
// HKDF only). A wrong guess here is a login outage, so this takes the
// implementation that runs anywhere.

import { scrypt } from "scrypt-js";

const SCRYPT_N = 16384; // 2**14
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("invalid hex");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** Compares two strings in time that does not depend on where they differ. */
function constantTimeEquals(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const key = await scrypt(
    encoder.encode(password),
    salt,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_DKLEN,
  );
  return toHex(new Uint8Array(key));
}

/** Hashes a password for storage. Throws on an empty password, as the reference does. */
export async function passwordHash(password: string): Promise<string> {
  if (!password) throw new Error("password is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `scrypt$${toHex(salt)}$${await derive(password, salt)}`;
}

/**
 * Verifies a password against a stored hash, returning false for anything
 * malformed rather than throwing — the reference swallows ValueError/TypeError
 * the same way, so a corrupt row is a failed login and not a 500.
 */
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  if (!password) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  let salt: Uint8Array;
  try {
    salt = fromHex(parts[1]);
  } catch {
    return false;
  }
  return constantTimeEquals(await derive(password, salt), parts[2]);
}

/**
 * Burns the same scrypt cost as a real verification, for the login path when the
 * username does not exist. Short-circuiting there would make a missing account
 * measurably faster to reject and enumerate accounts one request at a time,
 * which a request-count rate limiter does not address.
 */
export async function burnPasswordHash(password: string): Promise<void> {
  await derive(password || "unused", new Uint8Array(16));
}

/** A new opaque bearer token: 32 random bytes, base64url, unpadded. */
export function mintToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The SHA-256 hex digest stored in `tokens.digest`; the token itself is never stored. */
export async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toHex(new Uint8Array(digest));
}
