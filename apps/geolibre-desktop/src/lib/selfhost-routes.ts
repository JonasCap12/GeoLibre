/**
 * The pages a self-hosted deployment's emails link to, read from the URL.
 *
 * Links put the token in the fragment (`/register#invite=…`): a fragment is
 * never sent to a server, so it stays out of access logs, proxies, and the
 * Referer of anything the page loads. Older mails used the query string, so
 * that is still read. Either way the token is removed from the address bar as
 * soon as it has been read, and nothing is spent until the visitor submits the
 * form — a mail scanner that opens the link consumes nothing.
 */

export type SelfHostRoute =
  | { page: "register"; token: string | null }
  | { page: "reset"; token: string | null }
  | { page: "verify-email"; token: string | null }
  | { page: "app" };

interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}

const PAGES = {
  register: "invite",
  reset: "token",
  "verify-email": "token",
} as const;

type LinkPage = keyof typeof PAGES;

/** The server mints 43-character base64url tokens; anything else is not one. */
const TOKEN_RE = /^[A-Za-z0-9_-]{20,200}$/;

function lastSegment(pathname: string): string {
  const parts = pathname.split("/").filter((part) => part !== "");
  return parts.length === 0 ? "" : parts[parts.length - 1];
}

function isLinkPage(segment: string): segment is LinkPage {
  return Object.prototype.hasOwnProperty.call(PAGES, segment);
}

function fragmentParams(hash: string): URLSearchParams {
  return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
}

/**
 * Which page the URL names, and its token.
 *
 * Matches the last path segment, so a build served under a base path
 * (`/geolibre/register`) works too. A malformed token reads as null and the
 * page explains that the link is invalid.
 */
export function readSelfHostRoute(location: LocationLike): SelfHostRoute {
  const segment = lastSegment(location.pathname);
  if (!isLinkPage(segment)) return { page: "app" };
  const name = PAGES[segment];
  const raw =
    fragmentParams(location.hash).get(name) ?? new URLSearchParams(location.search).get(name);
  const token = raw !== null && TOKEN_RE.test(raw) ? raw : null;
  return { page: segment, token };
}

/**
 * The same address with the token removed from both the query and the
 * fragment, for `history.replaceState`. Other parameters (`?locale=`) stay.
 */
export function urlWithoutToken(location: LocationLike): string {
  const search = new URLSearchParams(location.search);
  const fragment = fragmentParams(location.hash);
  for (const name of new Set(Object.values(PAGES))) {
    search.delete(name);
    fragment.delete(name);
  }
  const query = search.toString();
  const hash = fragment.toString();
  return `${location.pathname}${query ? `?${query}` : ""}${hash ? `#${hash}` : ""}`;
}

/** The app's own root: the path with a trailing link-page segment removed. */
export function appRootPath(pathname: string): string {
  const parts = pathname.split("/").filter((part) => part !== "");
  if (parts.length > 0 && isLinkPage(parts[parts.length - 1])) parts.pop();
  return `/${parts.join("/")}${parts.length > 0 ? "/" : ""}`;
}

let captured: SelfHostRoute | null = null;

/**
 * Reads the route once per page load and strips the token from the address
 * bar. Module state rather than component state: React StrictMode runs
 * initialisers twice, and the second run would find the token already gone.
 */
export function captureSelfHostRoute(win: Window = window): SelfHostRoute {
  if (captured !== null) return captured;
  captured = readSelfHostRoute(win.location);
  if (captured.page !== "app") {
    win.history.replaceState(win.history.state, "", urlWithoutToken(win.location));
  }
  return captured;
}

/** Leaves a link page for the app itself, without a reload. */
export function leaveSelfHostRoute(win: Window = window): void {
  captured = { page: "app" };
  const search = new URLSearchParams(win.location.search);
  for (const name of new Set(Object.values(PAGES))) search.delete(name);
  const query = search.toString();
  win.history.replaceState(
    win.history.state,
    "",
    `${appRootPath(win.location.pathname)}${query ? `?${query}` : ""}`,
  );
}

/** For tests. */
export function resetCapturedSelfHostRoute(): void {
  captured = null;
}
