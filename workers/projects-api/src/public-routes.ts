/**
 * Routes that answer with no bearer.
 *
 * Everything else is closed, including a route added later that forgets to
 * ask for an account. These five stay open because closing any of them locks
 * the team out permanently: health is an uptime check, registration is already
 * invite-gated, sign-in is how a token is obtained at all, and the two reset
 * steps are what a person with no token uses to get one back.
 *
 * `DELETE /api/auth/token` is deliberately not in this list. Sign-out already
 * requires the bearer it revokes.
 */
export function isPublicRoute(method: string, segments: readonly string[]): boolean {
  if (method === "GET" && segments.length === 1 && segments[0] === "health") return true;
  if (segments[0] !== "api") return false;
  const path = segments.slice(1);
  if (method === "POST" && path.length === 1 && path[0] === "accounts") return true;
  if (method === "POST" && path.length === 2 && path[0] === "auth") {
    return path[1] === "token" || path[1] === "reset-request" || path[1] === "reset-confirm";
  }
  return false;
}
