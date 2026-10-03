// Per-request plumbing shared by every route module: the request scope, body
// reading, sessions, rate limits, outbound mail, the audit log, and the checks
// a new password has to pass.
//
// index.ts owns routing. The decisions these helpers act on live in
// auth-policy.ts, so they stay importable by the test runner.

import { mintToken, tokenDigest } from "./auth";
import {
  BREACHED_PASSWORD_MESSAGE,
  RATE_LIMIT_RETRY_AFTER_SECONDS,
  auditCutoff,
  auditDetail,
  isAdminUsername,
  passwordPolicyError,
  passwordPolicyMessage,
  sessionNeedsTouch,
  sessionPruneBounds,
  sessionRefusal,
  shortUserAgent,
  type AuthActionRow,
  type AuthEventKind,
  type PasswordContext,
} from "./auth-policy";
import type { OutboundEmail } from "./email";
import { checkPwnedPassword } from "./hibp";
import { ApiError, now, type AccountRow, type Config } from "./model";
import { turnstileHostnames, verifyTurnstile, type TurnstileAction } from "./turnstile";

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  OBJECTS: R2Bucket;
  GEOLIBRE_PUBLIC_URL?: string;
  GEOLIBRE_VIEWER_URL?: string;
  GEOLIBRE_CORS_ORIGINS?: string;
  GEOLIBRE_MAX_PROJECT_BYTES?: string;
  GEOLIBRE_MAX_THUMBNAIL_BYTES?: string;
  GEOLIBRE_MAX_DATASET_BYTES?: string;
  GEOLIBRE_ACTIVITY_RETENTION_DAYS?: string;
  GEOLIBRE_SESSION_TTL_DAYS?: string;
  GEOLIBRE_SESSION_IDLE_DAYS?: string;
  AUTH_RATE_LIMITER?: RateLimiter;
  // Keyed per sign-in identifier, not per IP. Its own binding so a burst on one
  // account cannot spend the per-IP budget, and the reverse.
  AUTH_ACCOUNT_RATE_LIMITER?: RateLimiter;
  DOWNLOAD_RATE_LIMITER?: RateLimiter;
  // Optional, like the rate limiter: a deployment without Email Service still
  // builds. Invites and resets then return a clear error instead of throwing.
  EMAIL?: {
    send(message: {
      to: string;
      from: string;
      subject: string;
      text: string;
      html: string;
    }): Promise<unknown>;
  };
  // Comma-separated. Absent means nobody is an admin — see isAdminUsername.
  GEOLIBRE_ADMIN_USERNAMES?: string;
  // Must be one of the addresses in wrangler `allowed_sender_addresses`.
  GEOLIBRE_EMAIL_FROM?: string;
  // "1" logs each message instead of sending it. For `wrangler dev` only.
  GEOLIBRE_EMAIL_LOG_ONLY?: string;
  // `wrangler secret put`. Absent skips the bot check with a warning.
  TURNSTILE_SECRET_KEY?: string;
  // `wrangler secret put`, base64 of 32 random bytes. Required to enable MFA.
  MFA_ENCRYPTION_KEY?: string;
}

/** Everything a handler needs about the request it is answering. */
export interface Scope {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  config: Config;
  db: D1Database;
  url: URL;
  /** Memoised: route() authenticates before dispatch, and the handler asks again. */
  session?: Promise<Session | null>;
}

export interface Session {
  account: AccountRow;
  digest: string;
}

// ---------------------------------------------------------------------------
// Responses and bodies
// ---------------------------------------------------------------------------

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export const empty = (status: number): Response => new Response(null, { status });

/**
 * Reads a body with a hard cap, abandoning the stream as soon as the cap is
 * exceeded. `await request.arrayBuffer()` would materialize the whole upload
 * before the size could be checked, letting an authenticated caller push a
 * multi-gigabyte body just to earn a 413.
 */
export async function readCapped(request: Request, limit: number, onTooLarge: () => ApiError) {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number.parseInt(declared, 10) > limit) {
    throw onTooLarge();
  }
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw onTooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parses a JSON object body.
 *
 * Unlimited by default because project content arrives this way and is bounded
 * by the Content-Length ceiling in route(). Auth routes pass AUTH_BODY_LIMIT:
 * a chunked request declares no length, so without a cap here the ceiling
 * would not apply to them at all.
 */
export async function readJsonBody(
  request: Request,
  limit = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>> {
  const bytes = await readCapped(request, limit, () => new ApiError(413, "request body too large"));
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(422, "request body must be valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export const stringField = (body: Record<string, unknown>, name: string): string =>
  typeof body[name] === "string" ? (body[name] as string) : "";

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

interface SessionJoinRow extends AccountRow {
  t_created_at: string;
  t_expires_at: string | null;
  t_last_used_at: string | null;
}

export function currentSession(scope: Scope): Promise<Session | null> {
  scope.session ??= loadSession(scope);
  return scope.session;
}

async function loadSession(scope: Scope): Promise<Session | null> {
  const header = scope.request.headers.get("Authorization");
  if (header === null || header === "") return null;
  if (!header.startsWith("Bearer ")) throw new ApiError(401, "invalid authorization");
  const digest = await tokenDigest(header.slice(7));
  const row = await scope.db
    .prepare(
      `SELECT a.*, t.created_at AS t_created_at, t.expires_at AS t_expires_at,
              t.last_used_at AS t_last_used_at
       FROM accounts a JOIN tokens t ON t.account_id = a.id WHERE t.digest = ?`,
    )
    .bind(digest)
    .first<SessionJoinRow>();
  if (row === null) throw new ApiError(401, "invalid or expired token");
  const times = {
    created_at: row.t_created_at,
    expires_at: row.t_expires_at,
    last_used_at: row.t_last_used_at,
  };
  const nowMs = Date.now();
  if (sessionRefusal(times, nowMs, scope.config.session) !== null) {
    // Deleted on sight; the periodic prune in issueToken catches the rest.
    background(scope, "expired token delete", () =>
      scope.db.prepare(`DELETE FROM tokens WHERE digest = ?`).bind(digest).run(),
    );
    throw new ApiError(401, "invalid or expired token");
  }
  if (row.disabled_at) throw new ApiError(401, "account is disabled");
  if (sessionNeedsTouch(times, nowMs)) {
    background(scope, "session touch", () =>
      scope.db
        .prepare(`UPDATE tokens SET last_used_at = ? WHERE digest = ?`)
        .bind(new Date(nowMs).toISOString(), digest)
        .run(),
    );
  }
  const { t_created_at: _c, t_expires_at: _e, t_last_used_at: _l, ...account } = row;
  return { account, digest };
}

export async function optionalAccount(scope: Scope): Promise<AccountRow | null> {
  return (await currentSession(scope))?.account ?? null;
}

export function requireAccount(account: AccountRow | null): AccountRow {
  if (account === null) throw new ApiError(401, "authentication required");
  return account;
}

export async function requireSession(scope: Scope): Promise<Session> {
  const session = await currentSession(scope);
  if (session === null) throw new ApiError(401, "authentication required");
  return session;
}

/** Mints a bearer, records where it was issued, and prunes dead sessions. */
export async function issueToken(scope: Scope, accountId: string): Promise<string> {
  const token = mintToken();
  const nowMs = Date.now();
  const issued = new Date(nowMs).toISOString();
  await scope.db
    .prepare(
      `INSERT INTO tokens (digest, account_id, created_at, expires_at, last_used_at, user_agent, created_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await tokenDigest(token),
      accountId,
      issued,
      new Date(nowMs + scope.config.session.ttlMs).toISOString(),
      issued,
      shortUserAgent(scope.request.headers.get("User-Agent")),
      clientIp(scope.request),
    )
    .run();
  const bounds = sessionPruneBounds(nowMs, scope.config.session);
  background(scope, "session prune", () =>
    scope.db
      .prepare(
        `DELETE FROM tokens
         WHERE (expires_at IS NOT NULL AND expires_at <= ?1)
            OR (expires_at IS NULL AND created_at <= ?2)
            OR COALESCE(last_used_at, created_at) <= ?3`,
      )
      .bind(bounds.now, bounds.createdBefore, bounds.idleBefore)
      .run(),
  );
  return token;
}

/** Work that must finish but must not delay, or be observable in, the response. */
export function background(scope: Scope, label: string, work: () => Promise<unknown>): void {
  scope.ctx.waitUntil(
    work().catch((error) => {
      console.error(`${label} failed`, error);
    }),
  );
}

// ---------------------------------------------------------------------------
// Single-use action tokens and account mail
// ---------------------------------------------------------------------------

export async function loadAuthAction(db: D1Database, token: string): Promise<AuthActionRow | null> {
  if (token.length < 20 || token.length > 200) return null;
  return db
    .prepare(`SELECT * FROM auth_actions WHERE digest = ?`)
    .bind(await tokenDigest(token))
    .first<AuthActionRow>();
}

export function accountHasEmail(account: AccountRow): boolean {
  return typeof account.email === "string" && account.email !== "";
}

export function accountEmail(account: AccountRow): string {
  return account.email ?? "";
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function isAdmin(scope: Scope, account: AccountRow): boolean {
  return isAdminUsername(account.username, scope.env.GEOLIBRE_ADMIN_USERNAMES);
}

export const ADMIN_MFA_REQUIRED = "admin accounts must turn on two-factor authentication first";

/**
 * Unset GEOLIBRE_ADMIN_USERNAMES is nobody, not everybody. See isAdminUsername.
 *
 * An admin can disable accounts and read everyone's sign-in history, so a
 * stolen admin password alone must not be enough (ASVS 5.0 V6.3.3): the
 * account needs a second factor before any admin route answers.
 */
export async function requireAdmin(scope: Scope): Promise<AccountRow> {
  const account = requireAccount(await optionalAccount(scope));
  if (!isAdmin(scope, account)) throw new ApiError(403, "admin only");
  if (!account.mfa_enabled_at || !account.mfa_secret) throw new ApiError(403, ADMIN_MFA_REQUIRED);
  return account;
}

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------

const tooMany = (message: string): ApiError =>
  new ApiError(429, message, { "Retry-After": String(RATE_LIMIT_RETRY_AFTER_SECONDS) });

/**
 * Rate-limits the unauthenticated auth routes.
 *
 * docs/server-api.md lists this as something the reference server leaves to the
 * operator, to be supplied by a reverse proxy or WAF. The platform offers it
 * directly, so it is enforced here instead of being a deployment footnote. The
 * key is the client IP plus the route, so one abusive client cannot lock out
 * everyone else.
 */
export async function rateLimit(env: Env, request: Request, scope: string): Promise<void> {
  if (env.AUTH_RATE_LIMITER === undefined) return;
  await rateLimitKey(env, `${scope}:${clientIp(request)}`);
}

/** Same limiter, but the key is chosen by the caller (an email address, not only an IP). */
export async function rateLimitKey(env: Env, key: string): Promise<void> {
  if (env.AUTH_RATE_LIMITER === undefined) return;
  const { success } = await env.AUTH_RATE_LIMITER.limit({ key });
  if (!success) throw tooMany("too many requests; retry later");
}

/**
 * Throttles sign-in per account rather than locking it.
 *
 * A lockout after N failures hands anyone who knows a username a way to keep
 * that person signed out (ASVS 5.0 V6.3.1 asks for throttling for exactly
 * that reason). This only slows guesses down; the owner is back in a minute.
 */
export async function rateLimitAccount(env: Env, key: string): Promise<void> {
  if (env.AUTH_ACCOUNT_RATE_LIMITER === undefined) return;
  const { success } = await env.AUTH_ACCOUNT_RATE_LIMITER.limit({ key });
  if (!success) throw tooMany("too many sign-in attempts for this account; retry later");
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

export function emailFromOrNull(env: Env): string | null {
  const from = env.GEOLIBRE_EMAIL_FROM?.trim() ?? "";
  if (from === "" || (env.EMAIL === undefined && env.GEOLIBRE_EMAIL_LOG_ONLY !== "1")) return null;
  return from;
}

export function emailFrom(env: Env): string {
  const from = emailFromOrNull(env);
  if (from === null) throw new ApiError(503, "email is not configured on this deployment");
  return from;
}

export async function sendEmail(env: Env, message: OutboundEmail): Promise<void> {
  if (env.GEOLIBRE_EMAIL_LOG_ONLY === "1") {
    console.log(`[mail to ${message.to}] ${message.subject}\n${message.text}`);
    return;
  }
  if (env.EMAIL === undefined)
    throw new ApiError(503, "email is not configured on this deployment");
  await env.EMAIL.send(message);
}

/**
 * Sends after the response.
 *
 * Awaiting a send makes the branch that has an account measurably slower than
 * the one that does not, which turns reset-request into an address oracle.
 * waitUntil keeps the send alive past the response, so the mail still arrives.
 */
export function sendEmailLater(scope: Scope, message: OutboundEmail, label: string): void {
  background(scope, label, () => sendEmail(scope.env, message));
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Appends to auth_events and prunes past the retention window, after the
 * response. Never pass a password, token, or one-time code in `detail`.
 */
export function recordAuthEvent(
  scope: Scope,
  kind: AuthEventKind,
  accountId: string | null,
  detail: Record<string, unknown> = {},
): void {
  const created = now();
  background(scope, `audit ${kind}`, () =>
    scope.db.batch([
      scope.db
        .prepare(`DELETE FROM auth_events WHERE created_at < ?`)
        .bind(auditCutoff(Date.now(), scope.config.activityRetentionDays)),
      scope.db
        .prepare(
          `INSERT INTO auth_events (id, account_id, kind, ip, user_agent, created_at, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          accountId,
          kind,
          clientIp(scope.request),
          shortUserAgent(scope.request.headers.get("User-Agent")),
          created,
          auditDetail(detail),
        ),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Bot check and new passwords
// ---------------------------------------------------------------------------

/**
 * Verifies the form's Turnstile token when this deployment has a secret.
 *
 * Without TURNSTILE_SECRET_KEY the check is skipped with a warning, the same
 * way an absent rate-limit binding is: a fresh or local deployment works, and
 * deploy-projects-api.yml is what insists production has one.
 */
export async function requireTurnstile(
  scope: Scope,
  body: Record<string, unknown>,
  action: TurnstileAction,
): Promise<void> {
  const secret = scope.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (secret === "") {
    console.warn(`TURNSTILE_SECRET_KEY is not set; ${action} skips the bot check`);
    return;
  }
  const refusal = await verifyTurnstile({
    secret,
    token: stringField(body, "turnstileToken"),
    remoteIp: scope.request.headers.get("CF-Connecting-IP"),
    action,
    hostnames: turnstileHostnames([...scope.config.corsOrigins, scope.config.viewerUrl]),
  });
  if (refusal === "unavailable") throw new ApiError(503, "bot check is unavailable; retry later");
  if (refusal !== null) {
    throw new ApiError(403, "bot check failed; reload the page and try again");
  }
}

/** Length, context words, then the breach corpus. Throws the 422 the client shows. */
export async function assertNewPassword(password: string, context: PasswordContext): Promise<void> {
  const code = passwordPolicyError(password, context);
  if (code !== null) throw new ApiError(422, passwordPolicyMessage(code));
  if ((await checkPwnedPassword(password)).pwned) {
    throw new ApiError(422, BREACHED_PASSWORD_MESSAGE);
  }
}
