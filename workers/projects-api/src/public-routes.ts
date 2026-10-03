/**
 * Routes that answer with no bearer.
 *
 * Everything else is closed, including a route added later that forgets to
 * ask for an account. These stay open because closing any of them locks the
 * team out permanently: health is an uptime check, registration and invite
 * inspection are already invite-gated, sign-in is how a token is obtained at
 * all, the two reset steps are what a person with no token uses to get one
 * back, and email confirmation is opened from a mail link on a device that
 * may not be signed in (the single-use token in the body is the credential).
 *
 * `DELETE /api/auth/token` is deliberately not in this list. Sign-out already
 * requires the bearer it revokes.
 */
export function isPublicRoute(method: string, segments: readonly string[]): boolean {
  if (method === "GET" && segments.length === 1 && segments[0] === "health") return true;
  if (segments[0] !== "api") return false;
  const path = segments.slice(1);
  if (method !== "POST") return false;
  if (path.length === 1 && path[0] === "accounts") return true;
  if (path.length === 2 && path[0] === "invites" && path[1] === "inspect") return true;
  if (path.length === 2 && path[0] === "auth") {
    return (
      path[1] === "token" ||
      path[1] === "reset-request" ||
      path[1] === "reset-confirm" ||
      path[1] === "email-confirm"
    );
  }
  return false;
}

const AUTH_PREFIXES = new Set(["accounts", "account", "auth", "invites", "admin"]);

/**
 * Routes whose responses carry credentials, account details, or the audit log.
 * Every one of them is sent with `Cache-Control: no-store` (ASVS 5.0 V14.3.2),
 * whatever the handler set, so a shared cache can never hold a token.
 */
export function isAuthRoute(segments: readonly string[]): boolean {
  if (segments[0] !== "api") return false;
  if (AUTH_PREFIXES.has(segments[1] ?? "")) return true;
  return segments[1] === "users" && segments[2] === "me";
}
