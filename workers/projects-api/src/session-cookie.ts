import { mintToken, tokenDigest } from "./auth";
import { ACCESS_TOKEN_TTL_MS } from "./auth-policy";
import {
  background,
  issueToken,
  json,
  loadSessionSecret,
  rateLimit,
  recordAuthEvent,
  type Scope,
  type Session,
} from "./context";
import { ApiError } from "./model";

export const SESSION_HEADER = "X-GeoLibre-Session";
export const SESSION_COOKIE = "__Host-geolibre_session";

export function sessionCookie(secret: string, ttlMs: number): string {
  return `${SESSION_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(ttlMs / 1000))}`;
}

/** Explicit origins only: a wildcard must never authorize cookie operations. */
export function requireCookieOrigin(scope: Scope): void {
  const origin = scope.request.headers.get("Origin");
  if (
    scope.request.headers.get(SESSION_HEADER) !== "cookie" ||
    !origin ||
    origin === "null" ||
    !scope.config.corsOrigins.includes(origin)
  ) {
    throw new ApiError(403, "session origin or header refused");
  }
}

export function cookieRequested(scope: Scope): boolean {
  return scope.request.headers.get(SESSION_HEADER) === "cookie";
}

async function issueAccess(scope: Scope, session: Session) {
  const accessToken = mintToken();
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  await scope.db
    .prepare(
      `INSERT INTO access_tokens (digest, session_digest, account_id, expires_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(await tokenDigest(accessToken), session.digest, session.account.id, expiresAt)
    .run();
  background(scope, "access token prune", () =>
    scope.db
      .prepare(`DELETE FROM access_tokens WHERE expires_at <= ?`)
      .bind(new Date().toISOString())
      .run(),
  );
  return { accessToken, expiresAt };
}

/** The only response helper for all four mint sites; never exposes a cookie secret. */
export async function tokenResponse(
  scope: Scope,
  accountId: string,
  body: Record<string, unknown> = {},
  status = 200,
): Promise<Response> {
  // A password change authenticated by an access token cannot downgrade to bearer mode.
  const cookie = cookieRequested(scope) || (await scope.session)?.accessToken === true;
  if (cookie) requireCookieOrigin(scope);
  const secret = await issueToken(scope, accountId);
  if (!cookie) return json({ ...body, token: secret }, status);
  const access = await issueAccess(scope, {
    digest: await tokenDigest(secret),
    account: { id: accountId } as Session["account"],
  });
  return json({ ...body, ...access }, status, {
    "Set-Cookie": sessionCookie(secret, scope.config.session.ttlMs),
  });
}

async function cookieSession(scope: Scope): Promise<Session> {
  const cookie = scope.request.headers.get("Cookie") ?? "";
  const secret = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!secret) throw new ApiError(401, "session required");
  return loadSessionSecret(scope, secret);
}

export async function cookieRoute(scope: Scope): Promise<Response | null> {
  const { pathname } = scope.url;
  const method = scope.request.method;
  const refresh = method === "POST" && pathname === "/api/auth/refresh";
  const adopt = method === "POST" && pathname === "/api/auth/session/adopt";
  const logout = method === "DELETE" && pathname === "/api/auth/token" && cookieRequested(scope);
  if (!refresh && !adopt && !logout) return null;
  requireCookieOrigin(scope);
  await rateLimit(
    scope.env,
    scope.request,
    adopt ? "session-adopt" : refresh ? "refresh" : "logout",
  );
  try {
    if (adopt) {
      const header = scope.request.headers.get("Authorization") ?? "";
      if (!header.startsWith("Bearer ")) throw new ApiError(401, "session bearer required");
      const old = await loadSessionSecret(scope, header.slice(7));
      const response = await tokenResponse(scope, old.account.id);
      await scope.db.prepare(`DELETE FROM tokens WHERE digest = ?`).bind(old.digest).run();
      return response;
    }
    const session = await cookieSession(scope);
    if (refresh) return json(await issueAccess(scope, session));
    await scope.db.prepare(`DELETE FROM tokens WHERE digest = ?`).bind(session.digest).run();
    recordAuthEvent(scope, "logout", session.account.id);
    return new Response(null, { status: 204, headers: { "Set-Cookie": sessionCookie("", 0) } });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(401, error.message, { "Set-Cookie": sessionCookie("", 0) });
    }
    throw error;
  }
}
