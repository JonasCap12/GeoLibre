// Two-factor authentication: setup, the sign-in ticket, and the checks other
// routes call before a sensitive change.
//
// The arithmetic (TOTP, recovery codes, sealing) is in totp.ts and the limits
// in auth-policy.ts, both importable by the test runner. This module is the
// D1 side. Every write that decides an outcome is a conditional UPDATE whose
// change count is checked, so two concurrent requests cannot both spend the
// same code, ticket or recovery code.

import { mintToken, passwordMatches, tokenDigest } from "./auth";
import {
  AUTH_BODY_LIMIT,
  MAX_PASSWORD_LENGTH,
  MFA_MAX_CONSECUTIVE_FAILURES,
  MFA_TICKET_MAX_ATTEMPTS,
  MFA_TICKET_TTL_MS,
  expiresAt,
  mfaTicketRefusal,
  type MfaTicketRow,
} from "./auth-policy";
import {
  accountEmail,
  accountHasEmail,
  emailFromOrNull,
  json,
  rateLimitAccount,
  rateLimitKey,
  readJsonBody,
  recordAuthEvent,
  requireSession,
  sendEmailLater,
  stringField,
  type Scope,
} from "./context";
import { mfaChangedEmail } from "./email";
import { ApiError, now, type AccountRow } from "./model";
import {
  base32Encode,
  importSealKey,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  normalizeTotpCode,
  openSecret,
  otpauthUri,
  recoveryCodeDigest,
  sealSecret,
  verifyTotp,
} from "./totp";

const MFA_ISSUER = "GeoLibre";

let cachedKey: { raw: string; key: Promise<CryptoKey | null> } | null = null;

/** The sealing key, imported once per isolate. 503 when the deployment has none. */
async function sealKey(scope: Scope): Promise<CryptoKey> {
  const raw = scope.env.MFA_ENCRYPTION_KEY ?? "";
  if (cachedKey === null || cachedKey.raw !== raw) {
    cachedKey = { raw, key: importSealKey(raw) };
  }
  const key = await cachedKey.key;
  if (key === null) {
    throw new ApiError(503, "two-factor authentication is not configured on this deployment");
  }
  return key;
}

export function mfaEnabled(account: AccountRow): boolean {
  return Boolean(account.mfa_enabled_at) && Boolean(account.mfa_secret);
}

export async function recoveryCodesLeft(scope: Scope, accountId: string): Promise<number> {
  const row = await scope.db
    .prepare(
      `SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE account_id = ? AND used_at IS NULL`,
    )
    .bind(accountId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function notify(scope: Scope, account: AccountRow, change: Parameters<typeof mfaChangedEmail>[2]) {
  const from = emailFromOrNull(scope.env);
  if (from === null || !accountHasEmail(account)) return;
  sendEmailLater(scope, mfaChangedEmail(accountEmail(account), from, change), `mfa ${change}`);
}

/**
 * Checks a TOTP or recovery code for an account that has two-factor on.
 *
 * Six digits is tried as TOTP, anything else as a recovery code, so one input
 * field serves both. A wrong code counts toward MFA_MAX_CONSECUTIVE_FAILURES;
 * past it the account takes no more codes until an admin resets the factor.
 *
 * @returns Which factor matched, or null for a wrong code.
 */
export async function verifySecondFactor(
  scope: Scope,
  account: AccountRow,
  rawCode: string,
): Promise<"totp" | "recovery" | null> {
  const { db } = scope;
  if ((account.mfa_failed_attempts ?? 0) >= MFA_MAX_CONSECUTIVE_FAILURES) {
    throw new ApiError(
      403,
      "too many wrong two-factor codes; ask an admin to reset two-factor authentication",
    );
  }
  // Per account, not per IP or per ticket: a password holder minting fresh
  // tickets from many addresses still gets this many guesses a minute.
  await rateLimitAccount(scope.env, `mfa:${account.id}`);

  const totp = normalizeTotpCode(rawCode);
  if (totp !== null && account.mfa_secret) {
    const secret = await openSecret(await sealKey(scope), account.mfa_secret, account.id);
    const step = await verifyTotp(secret, totp, Date.now(), account.mfa_last_used_step ?? null);
    if (step !== null) {
      // The step only moves forward; a concurrent request with the same code
      // finds it already taken and fails like a replay.
      const taken = await db
        .prepare(
          `UPDATE accounts SET mfa_last_used_step = ?, mfa_failed_attempts = 0
           WHERE id = ? AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ?)`,
        )
        .bind(step, account.id, step)
        .run();
      if ((taken.meta.changes ?? 0) === 1) return "totp";
    }
  }

  const recovery = totp === null ? normalizeRecoveryCode(rawCode) : null;
  if (recovery !== null) {
    const spent = await db
      .prepare(
        `UPDATE mfa_recovery_codes SET used_at = ?
         WHERE digest = ? AND account_id = ? AND used_at IS NULL`,
      )
      .bind(now(), await recoveryCodeDigest(recovery), account.id)
      .run();
    if ((spent.meta.changes ?? 0) === 1) {
      await db
        .prepare(`UPDATE accounts SET mfa_failed_attempts = 0 WHERE id = ?`)
        .bind(account.id)
        .run();
      recordAuthEvent(scope, "mfa_recovery_used", account.id, {
        left: await recoveryCodesLeft(scope, account.id),
      });
      notify(scope, account, "recovery-used");
      return "recovery";
    }
  }

  await db
    .prepare(`UPDATE accounts SET mfa_failed_attempts = mfa_failed_attempts + 1 WHERE id = ?`)
    .bind(account.id)
    .run();
  recordAuthEvent(scope, "mfa_failure", account.id);
  return null;
}

/**
 * The second half of re-authentication: when two-factor is on, a sensitive
 * change also needs a current code (ASVS 5.0 V7.5.1). 403 like the
 * password check, so the app does not mistake it for a dead session.
 */
export async function requireSecondFactor(
  scope: Scope,
  account: AccountRow,
  body: Record<string, unknown>,
): Promise<void> {
  if (!mfaEnabled(account)) return;
  const code = stringField(body, "code");
  if (code.trim() === "") throw new ApiError(403, "two-factor code required");
  if ((await verifySecondFactor(scope, account, code)) === null) {
    throw new ApiError(403, "two-factor code is incorrect");
  }
}

async function requirePassword(
  scope: Scope,
  account: AccountRow,
  body: Record<string, unknown>,
): Promise<void> {
  await rateLimitKey(scope.env, `reauth:${account.id}`);
  const current = stringField(body, "currentPassword");
  if (current.length > MAX_PASSWORD_LENGTH) throw new ApiError(422, "password is too long");
  if (!(await passwordMatches(current, account.password_hash))) {
    throw new ApiError(403, "current password is incorrect");
  }
}

// ---------------------------------------------------------------------------
// Sign-in ticket
// ---------------------------------------------------------------------------

/** Issued in place of a token when the password was right and a code is still owed. */
export async function issueMfaTicket(scope: Scope, account: AccountRow): Promise<string> {
  const ticket = mintToken();
  const nowMs = Date.now();
  await scope.db.batch([
    // Expired and spent tickets go with each new one; there is no other prune.
    scope.db
      .prepare(`DELETE FROM mfa_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`)
      .bind(new Date(nowMs).toISOString()),
    scope.db
      .prepare(
        `INSERT INTO mfa_tickets (digest, account_id, created_at, expires_at, attempts, used_at)
         VALUES (?, ?, ?, ?, 0, NULL)`,
      )
      .bind(
        await tokenDigest(ticket),
        account.id,
        new Date(nowMs).toISOString(),
        expiresAt(nowMs, MFA_TICKET_TTL_MS),
      ),
  ]);
  return ticket;
}

const TICKET_REFUSED = "sign-in step expired; sign in again";

/**
 * Spends one attempt of a ticket on a code and returns the account once the
 * code is right. The ticket is single-use: it is marked used on success, and
 * after MFA_TICKET_MAX_ATTEMPTS wrong codes the password has to be typed again.
 */
export async function redeemMfaTicket(scope: Scope): Promise<AccountRow> {
  const { db, request } = scope;
  const body = await readJsonBody(request, AUTH_BODY_LIMIT);
  const raw = stringField(body, "ticket");
  if (raw.length < 20 || raw.length > 200) throw new ApiError(401, TICKET_REFUSED);
  const digest = await tokenDigest(raw);
  const ticket = await db
    .prepare(`SELECT * FROM mfa_tickets WHERE digest = ?`)
    .bind(digest)
    .first<MfaTicketRow>();
  const nowIso = now();
  if (mfaTicketRefusal(ticket, nowIso) !== null || ticket === null) {
    throw new ApiError(401, TICKET_REFUSED);
  }
  const counted = await db
    .prepare(
      `UPDATE mfa_tickets SET attempts = attempts + 1
       WHERE digest = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`,
    )
    .bind(digest, nowIso, MFA_TICKET_MAX_ATTEMPTS)
    .run();
  if ((counted.meta.changes ?? 0) < 1) throw new ApiError(401, TICKET_REFUSED);

  const account = await db
    .prepare(`SELECT * FROM accounts WHERE id = ?`)
    .bind(ticket.account_id)
    .first<AccountRow>();
  if (account === null || !mfaEnabled(account)) throw new ApiError(401, TICKET_REFUSED);
  if (account.disabled_at) throw new ApiError(403, "account is disabled");

  const factor = await verifySecondFactor(scope, account, stringField(body, "code"));
  if (factor === null) {
    recordAuthEvent(scope, "login_failure", account.id, { reason: "mfa" });
    throw new ApiError(401, "two-factor code is incorrect");
  }
  const claimed = await db
    .prepare(`UPDATE mfa_tickets SET used_at = ? WHERE digest = ? AND used_at IS NULL`)
    .bind(nowIso, digest)
    .run();
  if ((claimed.meta.changes ?? 0) < 1) throw new ApiError(401, TICKET_REFUSED);
  return account;
}

// ---------------------------------------------------------------------------
// Managing the factor
// ---------------------------------------------------------------------------

async function storeRecoveryCodes(scope: Scope, accountId: string): Promise<string[]> {
  const codes = newRecoveryCodes();
  const created = now();
  const digests = await Promise.all(
    codes.map((code) => recoveryCodeDigest(normalizeRecoveryCode(code)!)),
  );
  await scope.db.batch([
    scope.db.prepare(`DELETE FROM mfa_recovery_codes WHERE account_id = ?`).bind(accountId),
    ...digests.map((digest) =>
      scope.db
        .prepare(
          `INSERT INTO mfa_recovery_codes (digest, account_id, created_at, used_at)
           VALUES (?, ?, ?, NULL)`,
        )
        .bind(digest, accountId, created),
    ),
  ]);
  return codes;
}

/** Clears every trace of the factor. Used by disable and by the admin reset. */
export function clearMfaStatements(db: D1Database, accountId: string): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE accounts SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enabled_at = NULL,
           mfa_last_used_step = NULL, mfa_failed_attempts = 0
         WHERE id = ?`,
      )
      .bind(accountId),
    db.prepare(`DELETE FROM mfa_recovery_codes WHERE account_id = ?`).bind(accountId),
    db.prepare(`DELETE FROM mfa_tickets WHERE account_id = ?`).bind(accountId),
  ];
}

export async function mfaRoute(
  scope: Scope,
  path: readonly string[],
  method: string,
): Promise<Response | null> {
  if (path.length !== 3 || path[0] !== "auth" || path[1] !== "mfa" || method !== "POST") {
    return null;
  }
  const { db, request } = scope;
  const { account } = await requireSession(scope);
  const body = await readJsonBody(request, AUTH_BODY_LIMIT);

  // Step one of setup. The password proves it is the owner at the keyboard;
  // the secret is kept pending until a code from the app proves it was saved.
  if (path[2] === "setup") {
    if (mfaEnabled(account)) throw new ApiError(409, "two-factor authentication is already on");
    await requirePassword(scope, account, body);
    const key = await sealKey(scope);
    const secret = newTotpSecret();
    await db
      .prepare(`UPDATE accounts SET mfa_pending_secret = ? WHERE id = ?`)
      .bind(await sealSecret(key, secret, account.id), account.id)
      .run();
    const encoded = base32Encode(secret);
    return json({
      secret: encoded,
      otpauthUri: otpauthUri({
        issuer: MFA_ISSUER,
        account: account.username ?? accountEmail(account),
        secret: encoded,
      }),
    });
  }

  if (path[2] === "enable") {
    if (mfaEnabled(account)) throw new ApiError(409, "two-factor authentication is already on");
    if (!account.mfa_pending_secret) {
      throw new ApiError(409, "start two-factor setup first");
    }
    await rateLimitKey(scope.env, `mfa-enable:${account.id}`);
    const secret = await openSecret(await sealKey(scope), account.mfa_pending_secret, account.id);
    const step = await verifyTotp(secret, stringField(body, "code"), Date.now(), null);
    if (step === null) throw new ApiError(403, "two-factor code is incorrect");
    const enabled = await db
      .prepare(
        `UPDATE accounts SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL,
           mfa_enabled_at = ?, mfa_last_used_step = ?, mfa_failed_attempts = 0
         WHERE id = ? AND mfa_pending_secret = ? AND mfa_enabled_at IS NULL`,
      )
      .bind(now(), step, account.id, account.mfa_pending_secret)
      .run();
    if ((enabled.meta.changes ?? 0) < 1) throw new ApiError(409, "start two-factor setup first");
    const recoveryCodes = await storeRecoveryCodes(scope, account.id);
    recordAuthEvent(scope, "mfa_enabled", account.id);
    notify(scope, account, "enabled");
    return json({ recoveryCodes });
  }

  if (path[2] === "disable") {
    if (!mfaEnabled(account)) throw new ApiError(409, "two-factor authentication is not on");
    await requirePassword(scope, account, body);
    await requireSecondFactor(scope, account, body);
    await db.batch(clearMfaStatements(db, account.id));
    recordAuthEvent(scope, "mfa_disabled", account.id);
    notify(scope, account, "disabled");
    return json({ ok: true });
  }

  if (path[2] === "recovery-codes") {
    if (!mfaEnabled(account)) throw new ApiError(409, "two-factor authentication is not on");
    await requirePassword(scope, account, body);
    await requireSecondFactor(scope, account, body);
    const recoveryCodes = await storeRecoveryCodes(scope, account.id);
    recordAuthEvent(scope, "mfa_recovery_regenerated", account.id);
    return json({ recoveryCodes });
  }

  return null;
}
