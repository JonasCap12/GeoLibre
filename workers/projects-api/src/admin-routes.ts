// Admin-only routes: invites, accounts, and the audit log.
//
// Every handler here starts from requireAdmin. The app hides the admin screen
// from everyone else using the isAdmin flag on GET /api/account, but that flag
// only decides what is drawn; this file is where the permission is enforced.

import { mintToken, tokenDigest } from "./auth";
import {
  INVITE_TTL_MS,
  disableRefusal,
  expiresAt,
  inviteStatus,
  maskEmail,
  parseAdminUsernames,
  sessionPruneBounds,
  type AuthActionRow,
} from "./auth-policy";
import {
  accountEmail,
  accountHasEmail,
  emailFrom,
  emailFromOrNull,
  empty,
  json,
  recordAuthEvent,
  requireAdmin,
  sendEmail,
  sendEmailLater,
  type Scope,
} from "./context";
import { inviteEmail, mfaChangedEmail } from "./email";
import { clearMfaStatements } from "./mfa-routes";
import { ApiError, now, type AccountRow } from "./model";

/**
 * Stores an invite and mails its link.
 *
 * The send is awaited, unlike the reset mail: only an admin reaches this, so
 * there is no timing oracle to close, and the admin needs to know the mail
 * failed. A failed send removes the row, so a link nobody received cannot
 * linger as a valid invite.
 */
export async function createInvite(scope: Scope, admin: AccountRow, email: string): Promise<void> {
  const { db, env, config } = scope;
  const existing = await db
    .prepare(`SELECT id FROM accounts WHERE email = ?`)
    .bind(email)
    .first<{ id: string }>();
  if (existing !== null) throw new ApiError(409, "an account already uses this email");
  const from = emailFrom(env);
  const token = mintToken();
  const digest = await tokenDigest(token);
  await db
    .prepare(
      `INSERT INTO auth_actions (digest, kind, account_id, email, created_at, expires_at, used_at, created_by)
       VALUES (?, 'invite', NULL, ?, ?, ?, NULL, ?)`,
    )
    .bind(digest, email, now(), expiresAt(Date.now(), INVITE_TTL_MS), admin.id)
    .run();
  // Fragment, not query: a fragment is never sent to the web Worker, so the
  // token cannot end up in its request logs. The app still reads `?invite=`
  // for links mailed before this change.
  const registerUrl = `${config.viewerUrl}register#invite=${encodeURIComponent(token)}`;
  try {
    await sendEmail(env, inviteEmail(email, from, registerUrl));
  } catch (error) {
    await db.prepare(`DELETE FROM auth_actions WHERE digest = ?`).bind(digest).run();
    if (error instanceof ApiError) throw error;
    console.error("invite email failed", error);
    throw new ApiError(503, "email is not configured on this deployment");
  }
  recordAuthEvent(scope, "invite_created", admin.id, { to: maskEmail(email), by: admin.username });
}

interface InviteListRow extends AuthActionRow {
  created_by_username: string | null;
  used_by_username: string | null;
}

interface AccountListRow {
  id: string;
  username: string | null;
  email: string | null;
  email_verified_at: string | null;
  created_at: string;
  disabled_at: string | null;
  mfa_enabled_at: string | null;
  sessions: number;
  last_seen_at: string | null;
}

interface EventRow {
  id: string;
  account_id: string | null;
  username: string | null;
  kind: string;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  detail: string;
}

function pageParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ApiError(422, `${name} must be an integer`);
  return Math.min(Number.parseInt(raw, 10), max);
}

async function loadInvite(db: D1Database, id: string): Promise<AuthActionRow> {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new ApiError(404, "invite not found");
  const row = await db
    .prepare(`SELECT * FROM auth_actions WHERE digest = ? AND kind = 'invite'`)
    .bind(id)
    .first<AuthActionRow>();
  if (row === null) throw new ApiError(404, "invite not found");
  return row;
}

async function loadAccount(db: D1Database, id: string): Promise<AccountRow> {
  const row = await db.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first<AccountRow>();
  if (row === null) throw new ApiError(404, "account not found");
  return row;
}

export async function adminRoute(
  scope: Scope,
  path: readonly string[],
  method: string,
): Promise<Response | null> {
  if (path[0] !== "admin") return null;
  const admin = await requireAdmin(scope);
  const { db, env, url, config } = scope;
  const adminNames = parseAdminUsernames(env.GEOLIBRE_ADMIN_USERNAMES);

  // --- Invites -----------------------------------------------------------
  if (path.length === 2 && path[1] === "invites" && method === "GET") {
    const rows = await db
      .prepare(
        `SELECT i.*, c.username AS created_by_username, u.username AS used_by_username
         FROM auth_actions i
         LEFT JOIN accounts c ON c.id = i.created_by
         LEFT JOIN accounts u ON u.id = i.account_id
         WHERE i.kind = 'invite'
         ORDER BY i.created_at DESC LIMIT 200`,
      )
      .all<InviteListRow>();
    const nowIso = now();
    return json({
      invites: (rows.results ?? []).map((row) => ({
        id: row.digest,
        email: row.email,
        status: inviteStatus(row, nowIso),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        createdBy: row.created_by_username,
        usedBy: row.used_by_username,
      })),
    });
  }

  if (path.length === 3 && path[1] === "invites" && method === "DELETE") {
    const invite = await loadInvite(db, path[2]);
    if (inviteStatus(invite, now()) === "used") {
      throw new ApiError(409, "invite was already used");
    }
    await db.prepare(`DELETE FROM auth_actions WHERE digest = ?`).bind(invite.digest).run();
    recordAuthEvent(scope, "invite_revoked", admin.id, {
      to: maskEmail(invite.email),
      by: admin.username,
    });
    return empty(204);
  }

  if (path.length === 4 && path[1] === "invites" && path[3] === "resend" && method === "POST") {
    const invite = await loadInvite(db, path[2]);
    if (inviteStatus(invite, now()) === "used") {
      throw new ApiError(409, "invite was already used");
    }
    // A fresh token and a fresh 72 hours. The old link dies first, so at most
    // one invite per address is ever valid.
    await db.prepare(`DELETE FROM auth_actions WHERE digest = ?`).bind(invite.digest).run();
    await createInvite(scope, admin, invite.email);
    return json({ ok: true }, 201);
  }

  // --- Accounts ----------------------------------------------------------
  if (path.length === 2 && path[1] === "accounts" && method === "GET") {
    const bounds = sessionPruneBounds(Date.now(), config.session);
    // Live sessions only, by the same rule as the session prune in issueToken,
    // so the count does not include rows that are merely awaiting deletion.
    const live = `t.account_id = a.id
      AND NOT ((t.expires_at IS NOT NULL AND t.expires_at <= ?1)
            OR (t.expires_at IS NULL AND t.created_at <= ?2)
            OR COALESCE(t.last_used_at, t.created_at) <= ?3)`;
    const rows = await db
      .prepare(
        `SELECT a.id, a.username, a.email, a.email_verified_at, a.created_at, a.disabled_at,
                a.mfa_enabled_at,
                (SELECT COUNT(*) FROM tokens t WHERE ${live}) AS sessions,
                (SELECT MAX(COALESCE(t.last_used_at, t.created_at)) FROM tokens t WHERE ${live})
                  AS last_seen_at
         FROM accounts a ORDER BY a.created_at`,
      )
      .bind(bounds.now, bounds.createdBefore, bounds.idleBefore)
      .all<AccountListRow>();
    return json({
      accounts: (rows.results ?? []).map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        emailVerifiedAt: row.email_verified_at,
        createdAt: row.created_at,
        disabledAt: row.disabled_at,
        isAdmin: row.username !== null && adminNames.has(row.username),
        mfaEnabled: row.mfa_enabled_at !== null,
        sessions: row.sessions,
        lastSeenAt: row.last_seen_at,
      })),
    });
  }

  if (path.length === 4 && path[1] === "accounts" && method === "POST") {
    const target = await loadAccount(db, path[2]);
    if (path[3] === "disable") {
      const enabledAdmins = await db
        .prepare(`SELECT id, username FROM accounts WHERE disabled_at IS NULL`)
        .all<{ id: string; username: string | null }>();
      const refusal = disableRefusal({
        targetId: target.id,
        targetIsAdmin: target.username !== null && adminNames.has(target.username),
        enabledAdminIds: (enabledAdmins.results ?? [])
          .filter((row) => row.username !== null && adminNames.has(row.username))
          .map((row) => row.id),
      });
      if (refusal === "last-admin") {
        throw new ApiError(409, "cannot disable the last enabled admin");
      }
      await db.batch([
        db.prepare(`UPDATE accounts SET disabled_at = ? WHERE id = ?`).bind(now(), target.id),
        db.prepare(`DELETE FROM tokens WHERE account_id = ?`).bind(target.id),
      ]);
      recordAuthEvent(scope, "account_disabled", target.id, { by: admin.username });
      return empty(204);
    }
    if (path[3] === "enable") {
      await db.prepare(`UPDATE accounts SET disabled_at = NULL WHERE id = ?`).bind(target.id).run();
      recordAuthEvent(scope, "account_enabled", target.id, { by: admin.username });
      return empty(204);
    }
  }

  if (
    path.length === 4 &&
    path[1] === "accounts" &&
    path[3] === "sessions" &&
    method === "DELETE"
  ) {
    const target = await loadAccount(db, path[2]);
    await db.prepare(`DELETE FROM tokens WHERE account_id = ?`).bind(target.id).run();
    recordAuthEvent(scope, "sessions_revoked", target.id, { by: admin.username });
    return empty(204);
  }

  // For a lost phone with no recovery codes left. Signs the account out too:
  // whoever has the phone may also have a session.
  if (path.length === 4 && path[1] === "accounts" && path[3] === "mfa" && method === "DELETE") {
    const target = await loadAccount(db, path[2]);
    await db.batch([
      ...clearMfaStatements(db, target.id),
      db.prepare(`DELETE FROM tokens WHERE account_id = ?`).bind(target.id),
    ]);
    recordAuthEvent(scope, "mfa_reset", target.id, { by: admin.username });
    const from = emailFromOrNull(env);
    if (from !== null && accountHasEmail(target)) {
      sendEmailLater(scope, mfaChangedEmail(accountEmail(target), from, "reset"), "mfa reset");
    }
    return empty(204);
  }

  // --- Audit log ---------------------------------------------------------
  if (path.length === 2 && path[1] === "events" && method === "GET") {
    const limit = pageParam(url, "limit", 100, 500);
    const offset = pageParam(url, "offset", 0, Number.MAX_SAFE_INTEGER);
    const rows = await db
      .prepare(
        `SELECT e.*, a.username FROM auth_events e
         LEFT JOIN accounts a ON a.id = e.account_id
         ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
      )
      .bind(limit, offset)
      .all<EventRow>();
    return json({
      events: (rows.results ?? []).map((row) => {
        let detail: unknown = {};
        try {
          detail = JSON.parse(row.detail);
        } catch {
          // A malformed row shows as empty detail rather than failing the page.
        }
        return {
          id: row.id,
          kind: row.kind,
          accountId: row.account_id,
          username: row.username,
          ip: row.ip ?? "",
          userAgent: row.user_agent ?? "",
          createdAt: row.created_at,
          detail,
        };
      }),
    });
  }

  throw new ApiError(404, "not found");
}
