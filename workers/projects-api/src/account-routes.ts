// Signed-in self-service: the session list and changing the account's email.
//
// None of these existed before. Old routes stay in index.ts so their contract
// in docs/server-api.md is visibly untouched; the ones here are additive.

import { mintToken, passwordMatches, tokenDigest } from "./auth";
import {
  AUTH_BODY_LIMIT,
  MAX_PASSWORD_LENGTH,
  VERIFY_EMAIL_TTL_MS,
  actionRefusal,
  expiresAt,
  maskEmail,
  normalizeEmail,
  sessionExpiry,
  sessionRefusal,
} from "./auth-policy";
import {
  accountEmail,
  accountHasEmail,
  emailFrom,
  empty,
  json,
  loadAuthAction,
  rateLimit,
  rateLimitKey,
  readJsonBody,
  recordAuthEvent,
  requireSession,
  sendEmailLater,
  stringField,
  type Scope,
} from "./context";
import { emailChangeNoticeEmail, verifyEmailChangeEmail } from "./email";
import { ApiError, now } from "./model";

interface TokenRow {
  digest: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  user_agent: string | null;
  created_ip: string | null;
}

/**
 * Re-authentication for a sensitive change: the current password.
 *
 * 403, not 401. A 401 means the bearer is bad (docs/server-api.md), and the
 * app signs out on a 401; a mistyped password must not do that. The older
 * POST /api/auth/password keeps its 401 for existing clients.
 */
export async function requireReauthentication(
  scope: Scope,
  body: Record<string, unknown>,
): Promise<void> {
  const { account } = await requireSession(scope);
  await rateLimitKey(scope.env, `reauth:${account.id}`);
  const current = stringField(body, "currentPassword");
  if (current.length > MAX_PASSWORD_LENGTH) throw new ApiError(422, "password is too long");
  if (!(await passwordMatches(current, account.password_hash))) {
    throw new ApiError(403, "current password is incorrect");
  }
}

export async function accountRoute(
  scope: Scope,
  path: readonly string[],
  method: string,
): Promise<Response | null> {
  const { db, env, request, config } = scope;
  if (path[0] !== "auth") return null;

  // --- Sessions ----------------------------------------------------------
  if (path.length === 2 && path[1] === "sessions") {
    const session = await requireSession(scope);
    if (method === "GET") {
      const rows = await db
        .prepare(
          `SELECT digest, created_at, expires_at, last_used_at, user_agent, created_ip
           FROM tokens WHERE account_id = ?
           ORDER BY COALESCE(last_used_at, created_at) DESC`,
        )
        .bind(session.account.id)
        .all<TokenRow>();
      const nowMs = Date.now();
      const live = (rows.results ?? []).filter(
        (row) => sessionRefusal(row, nowMs, config.session) === null,
      );
      return json({
        sessions: live.map((row) => ({
          // The digest, not the token: it identifies the row for revocation
          // and cannot be presented as a bearer.
          id: row.digest,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at ?? row.created_at,
          expiresAt: sessionExpiry(row, config.session),
          userAgent: row.user_agent ?? "",
          ip: row.created_ip ?? "",
          current: row.digest === session.digest,
        })),
      });
    }
    if (method === "DELETE") {
      await db.prepare(`DELETE FROM tokens WHERE account_id = ?`).bind(session.account.id).run();
      recordAuthEvent(scope, "logout_all", session.account.id);
      return empty(204);
    }
  }

  if (path.length === 3 && path[1] === "sessions" && method === "DELETE") {
    const session = await requireSession(scope);
    const id = path[2];
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ApiError(404, "session not found");
    // Scoped by account_id so one account cannot revoke another's session by id.
    const removed = await db
      .prepare(`DELETE FROM tokens WHERE digest = ? AND account_id = ?`)
      .bind(id, session.account.id)
      .run();
    if ((removed.meta.changes ?? 0) < 1) throw new ApiError(404, "session not found");
    recordAuthEvent(scope, "session_revoked", session.account.id, {
      current: id === session.digest,
    });
    return empty(204);
  }

  // --- Email change ------------------------------------------------------
  if (path.length === 2 && path[1] === "email" && method === "POST") {
    const { account } = await requireSession(scope);
    const body = await readJsonBody(request, AUTH_BODY_LIMIT);
    const email = normalizeEmail(body.email);
    if (email === null) throw new ApiError(422, "email is invalid");
    if (email === account.email) {
      throw new ApiError(422, "that is already the address on this account");
    }
    await requireReauthentication(scope, body);
    const from = emailFrom(env);
    // Said outright rather than hidden behind the same 202: the caller is a
    // signed-in member of a small team whose admin already sees every address,
    // and a silent no-op would leave them waiting for a mail that never comes.
    const taken = await db
      .prepare(`SELECT id FROM accounts WHERE email = ?`)
      .bind(email)
      .first<{ id: string }>();
    if (taken !== null) throw new ApiError(409, "an account already uses this email");

    const token = mintToken();
    await db
      .prepare(
        `INSERT INTO auth_actions (digest, kind, account_id, email, created_at, expires_at, used_at, created_by)
         VALUES (?, 'verify', ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        await tokenDigest(token),
        account.id,
        email,
        now(),
        expiresAt(Date.now(), VERIFY_EMAIL_TTL_MS),
        account.id,
      )
      .run();
    // Fragment, not query: it never reaches a server, so it cannot land in the
    // web Worker's request logs.
    const verifyUrl = `${config.viewerUrl}verify-email#token=${encodeURIComponent(token)}`;
    sendEmailLater(scope, verifyEmailChangeEmail(email, from, verifyUrl), "verify email");
    if (accountHasEmail(account)) {
      sendEmailLater(
        scope,
        emailChangeNoticeEmail(accountEmail(account), from, maskEmail(email)),
        "email change notice",
      );
    }
    recordAuthEvent(scope, "email_change_requested", account.id, { to: maskEmail(email) });
    return json({ ok: true }, 202);
  }

  if (path.length === 2 && path[1] === "email-confirm" && method === "POST") {
    await rateLimit(env, request, "email-confirm");
    const body = await readJsonBody(request, AUTH_BODY_LIMIT);
    const action = await loadAuthAction(db, stringField(body, "token"));
    const refusal = actionRefusal(action, "verify", now());
    if (refusal !== null || action === null || action.account_id === null) {
      throw new ApiError(403, "verification link is invalid or expired");
    }
    const confirmedAt = now();
    const claimed = await db
      .prepare(`UPDATE auth_actions SET used_at = ? WHERE digest = ? AND used_at IS NULL`)
      .bind(confirmedAt, action.digest)
      .run();
    if ((claimed.meta.changes ?? 0) < 1) {
      throw new ApiError(403, "verification link is invalid or expired");
    }
    let changed: D1Result;
    try {
      changed = await db
        .prepare(
          `UPDATE accounts SET email = ?, email_verified_at = ? WHERE id = ? AND disabled_at IS NULL`,
        )
        .bind(action.email, confirmedAt, action.account_id)
        .run();
    } catch (error) {
      // Another account took the address between request and confirmation.
      if (String(error).includes("UNIQUE")) {
        throw new ApiError(409, "an account already uses this email");
      }
      throw error;
    }
    if ((changed.meta.changes ?? 0) < 1) {
      throw new ApiError(403, "verification link is invalid or expired");
    }
    recordAuthEvent(scope, "email_changed", action.account_id, { to: maskEmail(action.email) });
    return json({ ok: true });
  }

  return null;
}
