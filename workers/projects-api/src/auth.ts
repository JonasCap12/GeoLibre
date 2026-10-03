// Password hashing, bearer tokens, and account resolution.
//
// Two encodings, told apart by their prefix:
//
//   scrypt$<salt hex>$<digest hex>   n=2^14, r=8, p=1. Byte-for-byte what
//                                    backend/geolibre_server_api produces, so an
//                                    imported accounts table keeps verifying.
//   scrypt2$<salt hex>$<digest hex>  n=2^14, r=8, p=5. What new hashes use.
//
// p=1 is below the OWASP Password Storage floor; n=2^14, r=8, p=5 is one of
// its listed equivalents. The 128 MiB variant (n=2^17, p=1) does not fit an
// isolate's memory, while p only repeats the 16 MiB mix and so costs CPU, not
// memory. Measured in workerd (wrangler dev, scrypt-js): p=1 ~67 ms, p=5
// ~333 ms per call. A sign-in that also rehashes pays both, ~400 ms, which is
// why wrangler.jsonc raises cpu_ms.
//
// The cost of moving: the Python reference only reads `scrypt$`. Exporting
// this table back to it would leave every rehashed account unable to sign in
// there. Import in the other direction is unaffected.
//
// scrypt-js rather than node:crypto: the Workers Node compatibility layer does
// not reliably expose scrypt, and WebCrypto has no scrypt at all (PBKDF2 and
// HKDF only). A wrong guess here is a login outage, so this takes the
// implementation that runs anywhere.

import { scrypt } from "scrypt-js";

const SCRYPT_N = 16384; // 2**14
const SCRYPT_R = 8;
const SCRYPT_DKLEN = 64;

/** Parallelism per encoding prefix. Never edit an existing entry; add a new prefix. */
const SCRYPT_P_BY_PREFIX: Record<string, number> = { scrypt: 1, scrypt2: 5 };
const CURRENT_PREFIX = "scrypt2";

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

async function derive(password: string, salt: Uint8Array, p: number): Promise<string> {
  const key = await scrypt(encoder.encode(password), salt, SCRYPT_N, SCRYPT_R, p, SCRYPT_DKLEN);
  return toHex(new Uint8Array(key));
}

/** Hashes a password for storage. Throws on an empty password, as the reference does. */
export async function passwordHash(password: string): Promise<string> {
  if (!password) throw new Error("password is required");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const p = SCRYPT_P_BY_PREFIX[CURRENT_PREFIX];
  return `${CURRENT_PREFIX}$${toHex(salt)}$${await derive(password, salt, p)}`;
}

/**
 * Verifies a password against a stored hash, returning false for anything
 * malformed rather than throwing — the reference swallows ValueError/TypeError
 * the same way, so a corrupt row is a failed login and not a 500.
 */
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  if (!password) return false;
  const parts = encoded.split("$");
  if (parts.length !== 3) return false;
  const p = SCRYPT_P_BY_PREFIX[parts[0]];
  if (p === undefined) return false;
  let salt: Uint8Array;
  try {
    salt = fromHex(parts[1]);
  } catch {
    return false;
  }
  return constantTimeEquals(await derive(password, salt, p), parts[2]);
}

/** True when a hash that just verified should be replaced with the current encoding. */
export function passwordNeedsRehash(encoded: string): boolean {
  return encoded.split("$")[0] !== CURRENT_PREFIX;
}

/**
 * Burns the same scrypt cost as a real verification, for the login path when the
 * username does not exist. Short-circuiting there would make a missing account
 * measurably faster to reject and enumerate accounts one request at a time,
 * which a request-count rate limiter does not address.
 */
export async function burnPasswordHash(password: string): Promise<void> {
  await derive(password || "unused", new Uint8Array(16), SCRYPT_P_BY_PREFIX[CURRENT_PREFIX]);
}

/**
 * Tops a failed legacy verification up to the current cost.
 *
 * A `scrypt$` row verifies five times faster than {@link burnPasswordHash}, so
 * without this a quick 401 would mean "this username exists" for every account
 * not yet rehashed. A successful verification needs nothing: the rehash that
 * follows costs more than the gap.
 */
export async function burnRemainingCost(password: string, encoded: string): Promise<void> {
  const paid = SCRYPT_P_BY_PREFIX[encoded.split("$")[0]] ?? 0;
  const owed = SCRYPT_P_BY_PREFIX[CURRENT_PREFIX] - paid;
  if (owed > 0) await derive(password || "unused", new Uint8Array(16), owed);
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
