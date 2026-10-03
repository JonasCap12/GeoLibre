// Decisions for invite-only registration, password changes, and resets.
//
// These live outside the Worker entry so the test runner can import them.
// index.ts cannot: it pulls in the Workers runtime. The entry calls these
// functions; it does not re-decide the same questions.

// NIST SP 800-63B-4 §3.1.1.2: 15 when the password is the only factor. Checked
// when a password is set or changed, never at sign-in, so the accounts created
// under the old 12-character rule keep working until their owners change it.
export const MIN_PASSWORD_LENGTH = 15;
export const MAX_PASSWORD_LENGTH = 1024;

export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;
export const VERIFY_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Body cap for every auth route. The largest legitimate body is a password of
 * MAX_PASSWORD_LENGTH plus a Turnstile token (~2 KB); the global ceiling in
 * index.ts is sized for 50 MiB projects and would otherwise apply here.
 */
export const AUTH_BODY_LIMIT = 16 * 1024;

/** The limiter period in wrangler.jsonc. Cloudflare's binding does not report a reset time. */
export const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

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

export type PasswordPolicyError = "too-short" | "too-long" | "context";

/** Words a password must not contain, beyond the breach corpus. */
export interface PasswordContext {
  username?: string | null;
  email?: string | null;
}

// Context words shorter than this are skipped: a three-letter username would
// otherwise reject every passphrase that happens to contain it.
const MIN_CONTEXT_WORD = 4;

/**
 * Rejects a short password, or one built from the account's own name.
 * Does not demand uppercase, digits, or symbols.
 *
 * NIST SP 800-63B recommends against composition rules: they push people to
 * `Matkhau@123`, which is weaker than a long passphrase. Do not add a
 * character-class check here. The context list is the "context-specific words"
 * check the same section asks for; the breach corpus is checked separately
 * (see hibp.ts) because it needs the network.
 *
 * Length counts UTF-16 units, as the API always has. NIST counts code points;
 * the difference only matters for astral characters and errs on the strict side.
 *
 * @returns A stable code, or null when the password may be hashed.
 */
export function passwordPolicyError(
  password: string,
  context: PasswordContext = {},
): PasswordPolicyError | null {
  if (password.length > MAX_PASSWORD_LENGTH) return "too-long";
  if (password.length < MIN_PASSWORD_LENGTH) return "too-short";
  const lowered = password.toLowerCase();
  for (const word of contextWords(context)) {
    if (lowered.includes(word)) return "context";
  }
  return null;
}

function contextWords(context: PasswordContext): string[] {
  const words = ["geolibre"];
  if (context.username) words.push(context.username.toLowerCase());
  const local = context.email?.split("@")[0]?.toLowerCase();
  if (local) words.push(local);
  return words.filter((word) => word.length >= MIN_CONTEXT_WORD);
}

/** The `error` string for each code. One place, so no route hard-codes the number. */
export function passwordPolicyMessage(code: PasswordPolicyError): string {
  if (code === "too-long") return "username or password is too long";
  if (code === "too-short") return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  return "password must not contain your username, email name, or the product name";
}

/** The `error` string for a password found in a breach corpus. */
export const BREACHED_PASSWORD_MESSAGE =
  "this password has appeared in a data breach; choose a different one";

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
 * would also leave an attacker's, valid until it expires (see sessionRefusal).
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

// ---------------------------------------------------------------------------
// Sign-in identifier
// ---------------------------------------------------------------------------

export interface LoginLookup {
  column: "username" | "email";
  value: string;
}

/**
 * What a sign-in identifier names: an address when it contains `@`, a
 * username otherwise. Usernames cannot contain `@` (USERNAME_RE), so the two
 * cannot be confused.
 *
 * The body key stays `username` so desktop and Jupyter clients from before
 * this change keep signing in unchanged.
 */
export function loginLookup(raw: unknown): LoginLookup | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  if (value.includes("@")) {
    const email = normalizeEmail(value);
    return email === null ? null : { column: "email", value: email };
  }
  if (value.length > 39) return null;
  return { column: "username", value: value.toLowerCase() };
}

/**
 * Per-account limiter key for sign-in.
 *
 * The IP limiter alone lets a botnet spread guesses for one account across
 * thousands of addresses. Keyed on what was typed, not on the resolved
 * account, so a missing account is throttled exactly like a real one and the
 * 429 says nothing about which exists.
 */
export function accountLimitKey(lookup: LoginLookup): string {
  return `token-account:${lookup.value}`;
}

/**
 * The identifier as it may be written to the audit log.
 *
 * People type their password into the username box. Anything that could not
 * be a username or an address is replaced, so a failed-login row never holds
 * a password.
 */
export function loginForAudit(raw: unknown): string {
  const lookup = loginLookup(raw);
  if (lookup === null) return "<unrecognised>";
  if (lookup.column === "username" && !/^[a-z0-9][a-z0-9-]{1,37}[a-z0-9]$/.test(lookup.value)) {
    return "<unrecognised>";
  }
  return lookup.value.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Sessions (ASVS 5.0 V7.3)
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_TTL_DAYS = 30;
export const DEFAULT_SESSION_IDLE_DAYS = 7;
/** Writing last_used_at on every request would be one D1 write per API call. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionPolicy {
  ttlMs: number;
  idleMs: number;
}

/** Reads the two `vars`, falling back to the defaults for anything not a positive integer. */
export function sessionPolicy(ttlDays?: string, idleDays?: string): SessionPolicy {
  const days = (raw: string | undefined, fallback: number): number => {
    const value = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const ttl = days(ttlDays, DEFAULT_SESSION_TTL_DAYS);
  // An idle window longer than the lifetime can never trigger; clamp it so the
  // configuration cannot silently disable one of the two checks.
  const idle = Math.min(days(idleDays, DEFAULT_SESSION_IDLE_DAYS), ttl);
  return { ttlMs: ttl * DAY_MS, idleMs: idle * DAY_MS };
}

export interface SessionTimes {
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

/**
 * Whether a presented token is still a session.
 *
 * Rows issued before schema-sessions-mfa.sql have no expiry and no last use.
 * They are judged from created_at, so a token minted months ago is expired
 * now rather than grandfathered in forever, which was the hole.
 */
export function sessionRefusal(
  row: SessionTimes,
  nowMs: number,
  policy: SessionPolicy,
): "expired" | "idle" | null {
  const created = Date.parse(row.created_at);
  const expires = row.expires_at ? Date.parse(row.expires_at) : created + policy.ttlMs;
  if (!Number.isFinite(expires) || expires <= nowMs) return "expired";
  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : created;
  if (!Number.isFinite(lastUsed) || lastUsed + policy.idleMs <= nowMs) return "idle";
  return null;
}

/** When the session ends at the latest, legacy rows included. For the session list. */
export function sessionExpiry(row: SessionTimes, policy: SessionPolicy): string {
  if (row.expires_at) return row.expires_at;
  return new Date(Date.parse(row.created_at) + policy.ttlMs).toISOString();
}

/** True at most once per SESSION_TOUCH_INTERVAL_MS per token. */
export function sessionNeedsTouch(row: SessionTimes, nowMs: number): boolean {
  const lastUsed = Date.parse(row.last_used_at ?? row.created_at);
  return !Number.isFinite(lastUsed) || nowMs - lastUsed >= SESSION_TOUCH_INTERVAL_MS;
}

/**
 * Bounds for deleting dead sessions in one statement. A row is dead when it
 * has passed its expiry, or (legacy) was created before the lifetime cutoff,
 * or has not been used since the idle cutoff.
 */
export function sessionPruneBounds(
  nowMs: number,
  policy: SessionPolicy,
): { now: string; createdBefore: string; idleBefore: string } {
  return {
    now: new Date(nowMs).toISOString(),
    createdBefore: new Date(nowMs - policy.ttlMs).toISOString(),
    idleBefore: new Date(nowMs - policy.idleMs).toISOString(),
  };
}

/** Enough of a User-Agent to tell two devices apart in a list, and no more. */
export function shortUserAgent(raw: string | null): string {
  return (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 160);
}

/**
 * A User-Agent with its version numbers blanked, so a browser updating itself
 * every few weeks is still the same device.
 */
export function deviceFamily(agent: string): string {
  return agent.replace(/\d+([._]\d+)*/g, "#");
}

/**
 * Whether a successful sign-in deserves a "new device" notice.
 *
 * Deliberately simple: the User-Agent family has never appeared on an earlier
 * successful sign-in for this account. IP is not part of it, because a phone
 * changes address every time it changes network and the notice would become
 * noise people learn to ignore. The very first sign-in an account has on
 * record sends nothing, so deploying this does not mail the whole team.
 */
export function isNewDevice(previousAgents: readonly string[], agent: string): boolean {
  if (previousAgents.length === 0) return false;
  const family = deviceFamily(agent);
  return !previousAgents.some((previous) => deviceFamily(previous) === family);
}

// ---------------------------------------------------------------------------
// Invites and admin
// ---------------------------------------------------------------------------

export type InviteStatus = "pending" | "used" | "expired";

export function inviteStatus(row: AuthActionRow, nowIso: string): InviteStatus {
  if (row.used_at !== null && row.used_at !== "") return "used";
  if (row.expires_at <= nowIso) return "expired";
  return "pending";
}

/**
 * What the registration page may show of the invited address.
 *
 * The invite link already proves the visitor can read that mailbox, but the
 * link can be forwarded or shoulder-surfed; the masked form is enough for
 * someone to recognise their own address.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(3, local.length - shown.length))}${email.slice(at)}`;
}

/**
 * Refuses disabling the only remaining enabled admin.
 *
 * Admins are named in configuration, not the database, so the last one being
 * disabled cannot be undone from the app: nobody would be left who can call
 * the enable route.
 */
export function disableRefusal(options: {
  targetId: string;
  targetIsAdmin: boolean;
  enabledAdminIds: readonly string[];
}): "last-admin" | null {
  if (!options.targetIsAdmin) return null;
  const others = options.enabledAdminIds.filter((id) => id !== options.targetId);
  return others.length === 0 ? "last-admin" : null;
}

// ---------------------------------------------------------------------------
// Second factor
// ---------------------------------------------------------------------------

/** How long the step between a right password and the code may take. */
export const MFA_TICKET_TTL_MS = 5 * 60 * 1000;
/** Wrong codes one ticket absorbs before the password has to be typed again. */
export const MFA_TICKET_MAX_ATTEMPTS = 5;
/**
 * Consecutive wrong codes after which the account stops accepting them until
 * an admin resets its second factor.
 *
 * Only someone who already has the password reaches this check, so stopping
 * here cannot be used to lock a colleague out the way a password lockout can.
 * Without it the per-ticket and per-minute limits still allow a slow, endless
 * guess at a six-digit code (NIST SP 800-63B-4 §3.2.2 caps it at 100).
 */
export const MFA_MAX_CONSECUTIVE_FAILURES = 10;

export interface MfaTicketRow {
  digest: string;
  account_id: string;
  created_at: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
}

/** Why a sign-in ticket cannot take another code, or null when it can. */
export function mfaTicketRefusal(
  row: MfaTicketRow | null,
  nowIso: string,
): "missing" | "used" | "expired" | "exhausted" | null {
  if (row === null) return "missing";
  if (row.used_at !== null && row.used_at !== "") return "used";
  if (row.expires_at <= nowIso) return "expired";
  if (row.attempts >= MFA_TICKET_MAX_ATTEMPTS) return "exhausted";
  return null;
}

// ---------------------------------------------------------------------------
// Audit log (ASVS 5.0 V16)
// ---------------------------------------------------------------------------

export const AUTH_EVENT_KINDS = [
  "login_success",
  "login_failure",
  "logout",
  "logout_all",
  "session_revoked",
  "password_changed",
  "reset_requested",
  "reset_completed",
  "invite_created",
  "invite_used",
  "invite_revoked",
  "email_change_requested",
  "email_changed",
  "mfa_enabled",
  "mfa_disabled",
  "mfa_recovery_used",
  "mfa_recovery_regenerated",
  "mfa_failure",
  "mfa_reset",
  "account_disabled",
  "account_enabled",
  "sessions_revoked",
] as const;

export type AuthEventKind = (typeof AUTH_EVENT_KINDS)[number];

const AUDIT_DETAIL_LIMIT = 512;

/**
 * The `detail` column. Short, and never a secret: callers pass identifiers
 * and outcomes only. Oversized detail is dropped rather than cut mid-JSON.
 */
export function auditDetail(detail: Record<string, unknown> = {}): string {
  const encoded = JSON.stringify(detail);
  return encoded.length <= AUDIT_DETAIL_LIMIT ? encoded : JSON.stringify({ truncated: true });
}

/** Rows older than this are pruned, sharing the project activity log's retention. */
export function auditCutoff(nowMs: number, retentionDays: number): string {
  return new Date(nowMs - retentionDays * DAY_MS).toISOString();
}
