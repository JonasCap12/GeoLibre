// An account's saved collaboration sessions: one per team or group, each with
// a name, so the owner can reopen it from any device and still be its host.
//
// The relay (workers/collab) holds the session itself; this table only
// remembers which sessions belong to whom, and the host token that makes the
// owner the host when they rejoin. That token is a credential for the session,
// so it is stored sealed (AES-GCM, MFA_ENCRYPTION_KEY, bound to the account and
// to this purpose) and only ever returned to its owner.
//
//   GET    /api/collab-sessions                 list, newest use first
//   POST   /api/collab-sessions                 save {code, name, mode, hostToken}
//   PATCH  /api/collab-sessions/:id             rename {name}, or {opened: true}
//   GET    /api/collab-sessions/:id/host-token  the owner's host token
//   DELETE /api/collab-sessions/:id             forget it (the app ends it on the relay first)

import {
  MAX_COLLAB_SESSIONS,
  isCollabHostToken,
  normalizeCollabCode,
  normalizeCollabMode,
  normalizeCollabName,
} from "./collab-session-policy";
import { AUTH_BODY_LIMIT } from "./auth-policy";
import { empty, json, readJsonBody, requireSession, type Scope } from "./context";
import { sealKey } from "./mfa-routes";
import { ApiError, now } from "./model";
import { openSecret, sealSecret } from "./totp";

interface CollabSessionRow {
  id: string;
  account_id: string;
  code: string;
  name: string;
  mode: string;
  host_token: string;
  created_at: string;
  last_opened_at: string | null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sessionJson(row: CollabSessionRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    mode: row.mode,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

async function ownedSession(
  scope: Scope,
  accountId: string,
  id: string,
): Promise<CollabSessionRow> {
  // Scoped by account in the query, so another account's id reads as missing.
  const row = await scope.db
    .prepare(`SELECT * FROM collab_sessions WHERE id = ? AND account_id = ?`)
    .bind(id, accountId)
    .first<CollabSessionRow>();
  if (row === null) throw new ApiError(404, "collaboration session not found");
  return row;
}

export async function collabSessionRoute(
  scope: Scope,
  path: readonly string[],
  method: string,
): Promise<Response | null> {
  if (path[0] !== "collab-sessions") return null;
  const { account } = await requireSession(scope);
  const { db, request } = scope;

  if (path.length === 1 && method === "GET") {
    const rows = await db
      .prepare(
        `SELECT * FROM collab_sessions WHERE account_id = ?
         ORDER BY COALESCE(last_opened_at, created_at) DESC`,
      )
      .bind(account.id)
      .all<CollabSessionRow>();
    return json({ sessions: (rows.results ?? []).map(sessionJson) });
  }

  if (path.length === 1 && method === "POST") {
    const body = await readJsonBody(request, AUTH_BODY_LIMIT);
    const code = normalizeCollabCode(body.code);
    const name = normalizeCollabName(body.name);
    const mode = normalizeCollabMode(body.mode);
    if (code === null) throw new ApiError(422, "session code is invalid");
    if (name === null) throw new ApiError(422, "session name must be 1-60 characters");
    if (mode === null) throw new ApiError(422, "mode must be co-edit or view-only");
    if (!isCollabHostToken(body.hostToken)) throw new ApiError(422, "host token is invalid");
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM collab_sessions WHERE account_id = ?`)
      .bind(account.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_COLLAB_SESSIONS) {
      throw new ApiError(409, "too many saved sessions; delete one first");
    }
    const sealed = await sealSecret(
      await sealKey(scope),
      encoder.encode(body.hostToken),
      account.id,
      "collab-host",
    );
    const created = now();
    const row: CollabSessionRow = {
      id: crypto.randomUUID(),
      account_id: account.id,
      code,
      name,
      mode,
      host_token: sealed,
      created_at: created,
      last_opened_at: created,
    };
    try {
      await db
        .prepare(
          `INSERT INTO collab_sessions (id, account_id, code, name, mode, host_token, created_at, last_opened_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.account_id,
          row.code,
          row.name,
          row.mode,
          row.host_token,
          created,
          created,
        )
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        throw new ApiError(409, "this session is already saved");
      }
      throw error;
    }
    return json({ session: sessionJson(row) }, 201);
  }

  if (path.length === 2 && method === "PATCH") {
    const row = await ownedSession(scope, account.id, path[1]);
    const body = await readJsonBody(request, AUTH_BODY_LIMIT);
    if (body.name !== undefined) {
      const name = normalizeCollabName(body.name);
      if (name === null) throw new ApiError(422, "session name must be 1-60 characters");
      row.name = name;
    }
    if (body.opened === true) row.last_opened_at = now();
    await db
      .prepare(`UPDATE collab_sessions SET name = ?, last_opened_at = ? WHERE id = ?`)
      .bind(row.name, row.last_opened_at, row.id)
      .run();
    return json({ session: sessionJson(row) });
  }

  if (path.length === 3 && path[2] === "host-token" && method === "GET") {
    const row = await ownedSession(scope, account.id, path[1]);
    let token: string;
    try {
      token = decoder.decode(
        await openSecret(await sealKey(scope), row.host_token, account.id, "collab-host"),
      );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // The sealing key was rotated, or the row was tampered with. The session
      // can still be joined, only not as host.
      throw new ApiError(409, "host token can no longer be read; start a new session");
    }
    return json({ hostToken: token });
  }

  if (path.length === 2 && method === "DELETE") {
    await db
      .prepare(`DELETE FROM collab_sessions WHERE id = ? AND account_id = ?`)
      .bind(path[1], account.id)
      .run();
    return empty(204);
  }

  throw new ApiError(404, "not found");
}
