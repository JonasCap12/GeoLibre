/**
 * Create an account on this deployment's projects API, or sign in to one.
 *
 * Without a token nothing the app does survives a reload: layers added from a
 * file live in the store and go when the tab does, projects cannot be saved to
 * the server, and uploads to the shared library are refused. The token is what
 * turns a session into something a team can come back to.
 *
 * The app had no way to get one. Settings accepts a token and the API can mint
 * one, but nothing joined the two, so a self-hosted deployment reached the
 * point of "everything works and nothing persists" -- which is how this
 * deployment sat: four Workers live, and zero accounts, zero projects, zero
 * datasets in the database.
 *
 * The hosted service has a website to sign up on. A self-hosted one has this.
 */

import { getShareFetch } from "./share-fetch";
import { resolveShareBaseUrl } from "./share-geolibre";

/** Mirrors the API: 3-39 lowercase letters, digits, or hyphens. */
export const USERNAME_PATTERN = /^[a-z0-9-]{3,39}$/;

/**
 * Mirrors `passwordPolicyError` in the projects API (12, not 8).
 * Enforced here too, so the error arrives before the round trip.
 * Composition rules stay off on both sides; see that function for why.
 */
export const MIN_PASSWORD_LENGTH = 12;

export class ShareAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShareAccountError";
  }
}

export interface ShareAccountOptions {
  username: string;
  password: string;
  /** Invite token from the registration email. Required to create an account. */
  invite?: string;
  /** Overrides the configured API base; for tests. */
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

function requireBaseUrl(override?: string | null): string {
  const base = override ?? resolveShareBaseUrl();
  if (!base) {
    throw new ShareAccountError(
      "This deployment has no projects server configured, so accounts cannot be created here.",
    );
  }
  return base.replace(/\/+$/, "");
}

/**
 * Check the two fields before spending a request on them.
 *
 * The API runs scrypt on every attempt, including failed ones, and its rate
 * limiter is deliberately tight. A typo that the browser can catch should not
 * consume one of ten attempts a minute.
 *
 * @returns The problem, or null when both look usable.
 */
export function validateCredentials(username: string, password: string): string | null {
  if (!USERNAME_PATTERN.test(username)) {
    return "Username must be 3-39 characters: lowercase letters, digits, or hyphens.";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

async function readError(response: Response, fallback: string): Promise<ShareAccountError> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: unknown; detail?: unknown };
    const message = body.error ?? body.detail;
    if (typeof message === "string") detail = message;
  } catch {
    // A non-JSON body (a proxy error page, say) leaves the status to speak.
  }
  return new ShareAccountError(detail || `${fallback} (HTTP ${response.status})`);
}

/**
 * Exchange a username and password for an API token.
 *
 * @returns The bearer token to store in Settings.
 */
export async function signIn(options: ShareAccountOptions): Promise<string> {
  const problem = validateCredentials(options.username, options.password);
  if (problem) throw new ShareAccountError(problem);
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: options.username, password: options.password }),
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.");
  }
  if (!response.ok) throw await readError(response, "Sign in failed");

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new ShareAccountError("The server did not return a token.");
  }
  return body.token;
}

/**
 * Ask the server to email a reset link.
 *
 * The response is the same whether or not the address has an account, so the
 * caller must not try to tell the visitor which one happened. A deployment
 * with no email binding answers 503; that is a real failure, not a hint.
 */
export async function requestPasswordReset(options: {
  email: string;
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<void> {
  const email = options.email.trim();
  if (email === "" || !email.includes("@")) {
    throw new ShareAccountError("Enter the email address on the account.");
  }
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/auth/reset-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.");
  }
  if (!response.ok) throw await readError(response, "Could not request a reset");
}

/**
 * Revoke the bearer server-side.
 *
 * The caller must clear the saved token only after this resolves. Clearing
 * first and then failing the request leaves a row in `tokens`, and that table
 * has no expiry column, so the token would stay valid forever with nobody
 * left who can present it for deletion.
 */
export async function signOut(options: {
  token: string;
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<void> {
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/auth/token`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${options.token}` },
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.");
  }
  if (!response.ok) throw await readError(response, "Sign out failed");
}

/**
 * Replace the password. The API revokes every existing session and returns a
 * new token for this one.
 *
 * @returns The replacement bearer token.
 */
export async function changePassword(options: {
  token: string;
  currentPassword: string;
  password: string;
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}): Promise<string> {
  if (options.password.length < MIN_PASSWORD_LENGTH) {
    throw new ShareAccountError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/auth/password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token}`,
      },
      body: JSON.stringify({
        currentPassword: options.currentPassword,
        password: options.password,
      }),
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.");
  }
  if (!response.ok) throw await readError(response, "Could not change the password");
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new ShareAccountError("The server did not return a token.");
  }
  return body.token;
}

/**
 * Create an account and return its token.
 *
 * The create endpoint mints a token itself, so this is one request, not two.
 * That matters more than it looks: both this route and the sign-in route run
 * scrypt and share a limiter of ten attempts a minute per IP, so a needless
 * second call would halve how many people can register from one office in a
 * minute.
 *
 * The sign-in fallback stays for a server that returns only the account -- the
 * reference implementation the API is written against does exactly that.
 *
 * @returns The bearer token to store in Settings.
 */
export async function createAccount(options: ShareAccountOptions): Promise<string> {
  const problem = validateCredentials(options.username, options.password);
  if (problem) throw new ShareAccountError(problem);
  const invite = options.invite?.trim() ?? "";
  if (invite === "") {
    throw new ShareAccountError("An invite is required to create an account.");
  }
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: options.username,
        password: options.password,
        invite,
      }),
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.");
  }
  if (response.status === 409) {
    throw new ShareAccountError("That username is taken. Sign in instead, or pick another name.");
  }
  if (!response.ok) throw await readError(response, "Could not create the account");

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token === "string" && body.token) return body.token;
  return signIn(options);
}
