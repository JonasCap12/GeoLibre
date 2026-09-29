// Decisions for invite-only registration, password changes, and resets.
//
// These live outside the Worker entry so the test runner can import them.
// index.ts cannot: it pulls in the Workers runtime. The entry calls these
// functions; it does not re-decide the same questions.

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

export type AuthActionKind = "invite" | "reset" | "verify";

export interface AuthActionRow {
  digest: string;
  kind: string;
  account_id: string | null;
  email: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  created_by: string | null;
}

/**
 * Rejects a short password. Does not demand uppercase, digits, or symbols.
 *
 * NIST SP 800-63B recommends against composition rules: they push people to
 * `Matkhau@123`, which is weaker than a long passphrase. Do not add a
 * character-class check here.
 *
 * @returns A stable code, or null when the password may be hashed.
 */
export function passwordPolicyError(password: string): "too-short" | "too-long" | null {
  if (password.length > MAX_PASSWORD_LENGTH) return "too-long";
  if (password.length < MIN_PASSWORD_LENGTH) return "too-short";
  return null;
}

/**
 * Usernames allowed to mint invites.
 *
 * Absent or blank means nobody. An empty deployment must not treat every
 * account as an admin: the first person to register (or anyone who already
 * has a token) could then invite the rest of the internet. Configuring the
 * list is what opens the door, and forgetting it fails closed.
 */
export function parseAdminUsernames(raw: string | undefined): Set<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );
}

export function isAdminUsername(username: string | null, raw: string | undefined): boolean {
  if (username === null || username === "") return false;
  return parseAdminUsernames(raw).has(username);
}

/** ISO-8601 UTC. Both sides of an expiry check must use this shape so string order matches time order. */
export function expiresAt(nowMs: number, ttlMs: number): string {
  return new Date(nowMs + ttlMs).toISOString();
}

export type ActionRefusal = "missing" | "used" | "expired" | "wrong-kind";

/**
 * Whether a stored action may still be consumed.
 *
 * `used` and `expired` are different so a second registration can be told
 * apart from a late one. A missing row and a wrong kind are both `missing`
 * at the HTTP edge: the caller must not learn which tokens exist.
 */
export function actionRefusal(
  row: AuthActionRow | null,
  kind: AuthActionKind,
  nowIso: string,
): ActionRefusal | null {
  if (row === null) return "missing";
  if (row.kind !== kind) return "wrong-kind";
  if (row.used_at !== null && row.used_at !== "") return "used";
  if (row.expires_at <= nowIso) return "expired";
  return null;
}

/** Registration without a still-valid invite is the hole this change closes. */
export function registrationRefusal(
  row: AuthActionRow | null,
  nowIso: string,
): ActionRefusal | null {
  return actionRefusal(row, "invite", nowIso);
}

/**
 * The body `reset-request` always returns.
 *
 * A different status or body for an unknown address is a user-enumeration
 * oracle. Callers compare this object, not a freshly built one, so the two
 * branches cannot drift.
 */
export const RESET_REQUEST_BODY = { ok: true } as const;

export function resetRequestReply(accountExists: boolean): {
  status: 200;
  body: typeof RESET_REQUEST_BODY;
  send: boolean;
} {
  return { status: 200, body: RESET_REQUEST_BODY, send: accountExists };
}

export interface SessionToken {
  digest: string;
  accountId: string;
}

/**
 * Sessions left after a password change or a completed reset.
 *
 * Every digest for that account goes. Leaving the caller's own session alive
 * would also leave an attacker's, and the tokens table has no expiry column,
 * so a leftover row is valid forever.
 */
export function sessionsAfterCredentialChange(
  tokens: readonly SessionToken[],
  accountId: string,
): SessionToken[] {
  return tokens.filter((token) => token.accountId !== accountId);
}

/** Lowercased mailbox, or null when it cannot be an address we should store. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Per-address limiter key. The IP limiter alone still lets many networks mail one person. */
export function resetEmailLimitKey(email: string): string {
  return `reset-email:${email}`;
}
