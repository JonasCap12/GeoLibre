/**
 * Routes that answer with no bearer.
 *
 * Everything else is closed, including a route added later that forgets to
 * ask for an account. These stay open because closing any of them locks the
 * team out permanently: health is an uptime check, registration and invite
 * inspection are already invite-gated, sign-in (and its second-factor step,
 * which needs the single-use ticket the password earned) is how a token is
 * obtained at all, the two reset steps are what a person with no token uses to get one
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
      path[1] === "mfa" ||
      path[1] === "reset-request" ||
      path[1] === "reset-confirm" ||
      path[1] === "email-confirm"
    );
  }
  return false;
}

// collab-sessions returns a collaboration host token, a credential like the rest.
const AUTH_PREFIXES = new Set([
  "accounts",
  "account",
  "auth",
  "invites",
  "admin",
  "collab-sessions",
  "collab",
]);

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

/**
 * Sent with every response this API makes. Nothing it serves is meant to be
 * rendered as a page: JSON, project files, thumbnails and dataset downloads.
 * So the strictest policy costs nothing, and if a stored file ever slipped
 * past the content-type checks it still could not run script, load anything,
 * or be framed on the API origin.
 */
export const API_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "cross-origin",
};
