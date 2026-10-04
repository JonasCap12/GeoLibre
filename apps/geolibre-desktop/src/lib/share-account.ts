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

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  type PasswordContext,
  type PasswordProblem,
} from "./password-strength";
import { getShareFetch } from "./share-fetch";
import { resolveShareBaseUrl } from "./share-geolibre";

/** Mirrors the API: 3-39 lowercase letters, digits, or hyphens. */
export const USERNAME_PATTERN = /^[a-z0-9-]{3,39}$/;

/**
 * The password rules, shared byte for byte with the projects API (see the
 * header of password-strength.ts). They apply when a password is set; sign-in
 * checks only that one was typed, so accounts made under earlier rules keep
 * signing in.
 */
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./password-strength";

/**
 * Why an auth request failed, independent of the server's English wording, so
 * the UI can show a translated message. `unknown` falls back to the message.
 */
export type AuthErrorCode =
  | "unreachable"
  | "no-server"
  | "rate-limited"
  | "bad-credentials"
  | "disabled"
  | "wrong-password"
  | "password-short"
  | "password-long"
  | "password-context"
  | "password-common"
  | "password-weak"
  | "password-breached"
  | "password-mismatch"
  | "login-invalid"
  | "username-invalid"
  | "email-invalid"
  | "email-same"
  | "invite-invalid"
  | "reset-invalid"
  | "verify-invalid"
  | "username-taken"
  | "email-taken"
  | "bot-check"
  | "bot-unavailable"
  | "email-unconfigured"
  | "session-expired"
  | "forbidden"
  | "mfa-invalid"
  | "mfa-required"
  | "mfa-expired"
  | "mfa-locked"
  | "mfa-unavailable"
  | "admin-mfa-required"
  | "unknown";

export class ShareAccountError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number | null;
  /** Seconds from `Retry-After` on a 429, when the server sent one. */
  readonly retryAfter: number | null;

  constructor(
    message: string,
    details: { code?: AuthErrorCode; status?: number | null; retryAfter?: number | null } = {},
  ) {
    super(message);
    this.name = "ShareAccountError";
    this.code = details.code ?? "unknown";
    this.status = details.status ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }
}

/**
 * Maps a failed response to a code.
 *
 * Matches on the server's own message where the status alone is ambiguous
 * (403 means a bad invite, a bad reset link, a disabled account, or a failed
 * bot check). The strings are those in workers/projects-api; an unrecognised
 * one stays `unknown` and the UI shows it verbatim, so drift degrades to
 * English rather than to a wrong message.
 */
export function authErrorCode(status: number, message: string): AuthErrorCode {
  const text = message.toLowerCase();
  if (status === 429) return "rate-limited";
  if (text.includes("invalid username or password")) return "bad-credentials";
  if (text.includes("account is disabled")) return "disabled";
  if (text.includes("current password is incorrect")) return "wrong-password";
  if (text.includes("at least") && text.includes("characters")) return "password-short";
  if (text.includes("password") && text.includes("too long")) return "password-long";
  if (text.includes("must not contain your username")) return "password-context";
  if (text.includes("too common or predictable")) return "password-common";
  if (text.includes("password is too weak")) return "password-weak";
  if (text.includes("data breach")) return "password-breached";
  if (text.includes("invite is invalid")) return "invite-invalid";
  if (text.includes("reset token is invalid")) return "reset-invalid";
  if (text.includes("verification link is invalid")) return "verify-invalid";
  if (text.includes("username already exists")) return "username-taken";
  if (text.includes("already uses this email") || text.includes("email already exists")) {
    return "email-taken";
  }
  if (text.includes("already the address")) return "email-same";
  if (text.includes("email is invalid")) return "email-invalid";
  if (text.includes("bot check is unavailable")) return "bot-unavailable";
  if (text.includes("bot check")) return "bot-check";
  if (text.includes("email is not configured")) return "email-unconfigured";
  if (text.includes("invalid or expired token") || text.includes("authentication required")) {
    return "session-expired";
  }
  if (text.includes("two-factor code is incorrect")) return "mfa-invalid";
  if (text.includes("two-factor code required")) return "mfa-required";
  if (text.includes("sign-in step expired")) return "mfa-expired";
  if (text.includes("too many wrong two-factor codes")) return "mfa-locked";
  if (text.includes("two-factor authentication is not configured")) return "mfa-unavailable";
  if (text.includes("must turn on two-factor")) return "admin-mfa-required";
  if (text.includes("admin only")) return "forbidden";
  return "unknown";
}

interface BaseOptions {
  /** Overrides the configured API base; for tests. */
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

interface TokenOptions extends BaseOptions {
  token: string;
}

export interface ShareAccountOptions extends BaseOptions {
  /** A username, or for sign-in only, the account's email address. */
  username: string;
  password: string;
  /** Invite token from the registration email. Required to create an account. */
  invite?: string;
  /** Turnstile response, where the deployment runs the bot check. */
  turnstileToken?: string;
}

function requireBaseUrl(override?: string | null): string {
  const base = override ?? resolveShareBaseUrl();
  if (!base) {
    throw new ShareAccountError(
      "This deployment has no projects server configured, so accounts cannot be created here.",
      { code: "no-server" },
    );
  }
  return base.replace(/\/+$/, "");
}

export type NewPasswordProblem =
  | "password-short"
  | "password-long"
  | "password-context"
  | "password-common"
  | "password-weak";

const PROBLEM_CODES: Record<PasswordProblem, NewPasswordProblem> = {
  "too-short": "password-short",
  "too-long": "password-long",
  context: "password-context",
  common: "password-common",
  weak: "password-weak",
};

/**
 * Every rule the server applies except the breach corpus, which needs the
 * network. Pass the username and email when they are known so the personal
 * rule is checked here too; the server checks it regardless.
 */
export function newPasswordProblem(
  password: string,
  context: PasswordContext = {},
): NewPasswordProblem | null {
  const problem = passwordProblem(password, context);
  return problem === null ? null : PROBLEM_CODES[problem];
}

/** English text for a client-side refusal, for callers without i18n. */
function newPasswordMessage(problem: NewPasswordProblem): string {
  if (problem === "password-short") {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (problem === "password-long") return "Password is too long.";
  if (problem === "password-context") {
    return "Password must not contain your username or the name part of your email.";
  }
  if (problem === "password-common") return "Password is too common or predictable.";
  return "Password is too weak. Make it longer or less predictable.";
}

/** Whether the sign-in field holds something the API could look up. */
export function signInProblem(login: string, password: string): "login-invalid" | null {
  const value = login.trim();
  const valid = value.includes("@")
    ? value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value)
    : USERNAME_PATTERN.test(value.toLowerCase());
  if (!valid || password === "" || password.length > MAX_PASSWORD_LENGTH) return "login-invalid";
  return null;
}

/**
 * Check the two fields before spending a request on them, when creating an
 * account.
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
  const problem = newPasswordProblem(password, { username });
  return problem === null ? null : newPasswordMessage(problem);
}

/**
 * The sign-in counterpart of {@link validateCredentials}. No length floor:
 * an account whose password predates the current rules must still get in.
 */
export function validateSignIn(login: string, password: string): string | null {
  if (signInProblem(login, password) !== null) {
    return "Enter your username or email address, and your password.";
  }
  return null;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
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
  return new ShareAccountError(detail || `${fallback} (HTTP ${response.status})`, {
    code: authErrorCode(response.status, detail),
    status: response.status,
    retryAfter: retryAfterSeconds(response),
  });
}

/**
 * One request to the projects API's auth routes.
 *
 * @returns The response when it is 2xx; otherwise throws a coded error.
 */
export async function authRequest(
  path: string,
  options: BaseOptions & {
    method?: string;
    token?: string;
    body?: unknown;
    fallback: string;
  },
): Promise<Response> {
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let response: Response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: options.method ?? "POST",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ShareAccountError("Could not reach the projects server.", { code: "unreachable" });
  }
  if (!response.ok) throw await readError(response, options.fallback);
  return response;
}

async function readToken(response: Response): Promise<string> {
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token) {
    throw new ShareAccountError("The server did not return a token.");
  }
  return body.token;
}

/**
 * What a right password earns: the bearer, or (with two-factor on) a
 * short-lived ticket to trade for one with {@link completeMfaSignIn}.
 */
export type SignInResult = { kind: "token"; token: string } | { kind: "mfa"; ticket: string };

/** Exchange a username (or email address) and password for an API token. */
export async function signIn(options: ShareAccountOptions): Promise<SignInResult> {
  const problem = validateSignIn(options.username, options.password);
  if (problem) throw new ShareAccountError(problem, { code: "login-invalid" });
  const response = await authRequest("/api/auth/token", {
    ...options,
    // The key stays `username` when it holds an email, so the request a
    // pre-email client sends is unchanged.
    body: { username: options.username.trim(), password: options.password },
    fallback: "Sign in failed",
  });
  const body = (await response.json()) as {
    token?: unknown;
    mfaRequired?: unknown;
    mfaTicket?: unknown;
  };
  if (body.mfaRequired === true && typeof body.mfaTicket === "string" && body.mfaTicket) {
    return { kind: "mfa", ticket: body.mfaTicket };
  }
  if (typeof body.token !== "string" || !body.token) {
    throw new ShareAccountError("The server did not return a token.");
  }
  return { kind: "token", token: body.token };
}

/** Whether a typed second factor is worth a request: a TOTP or a recovery code. */
export function mfaCodeProblem(code: string): "mfa-invalid" | null {
  const clean = code.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(clean) || /^[A-Za-z2-7]{24}$/.test(clean) ? null : "mfa-invalid";
}

/**
 * The second step of sign-in. `code` is the six digits from the authenticator
 * app or one recovery code.
 *
 * @returns The bearer token to store in Settings.
 */
export async function completeMfaSignIn(
  options: BaseOptions & { ticket: string; code: string },
): Promise<string> {
  if (mfaCodeProblem(options.code) !== null) {
    throw new ShareAccountError("Enter the six-digit code or a recovery code.", {
      code: "mfa-invalid",
    });
  }
  const response = await authRequest("/api/auth/mfa", {
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    body: { ticket: options.ticket, code: options.code.trim() },
    fallback: "Sign in failed",
  });
  return readToken(response);
}

/**
 * Ask the server to email a reset link.
 *
 * The response is the same whether or not the address has an account, so the
 * caller must not try to tell the visitor which one happened. A deployment
 * with no email binding answers 503; that is a real failure, not a hint.
 */
export async function requestPasswordReset(
  options: BaseOptions & { email: string; turnstileToken?: string },
): Promise<void> {
  const email = options.email.trim();
  if (email === "" || !email.includes("@")) {
    throw new ShareAccountError("Enter the email address on the account.", {
      code: "email-invalid",
    });
  }
  await authRequest("/api/auth/reset-request", {
    ...options,
    body: { email, turnstileToken: options.turnstileToken ?? "" },
    fallback: "Could not request a reset",
  });
}

/**
 * Set a new password from a reset link. The server ends every session of the
 * account, so the caller signs in afresh with the new password.
 */
export async function confirmPasswordReset(
  options: BaseOptions & { token: string; password: string; turnstileToken?: string },
): Promise<void> {
  const passwordIssue = newPasswordProblem(options.password);
  if (passwordIssue !== null) {
    throw new ShareAccountError(newPasswordMessage(passwordIssue), { code: passwordIssue });
  }
  // Not `...options`: `token` here is the reset link's, and must not become a
  // bearer header.
  await authRequest("/api/auth/reset-confirm", {
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    body: {
      token: options.token,
      password: options.password,
      turnstileToken: options.turnstileToken ?? "",
    },
    fallback: "Could not reset the password",
  });
}

/** What the registration page may show about an invite before it is used. */
export interface InviteSummary {
  /** Masked, e.g. `ng****@example.com`. */
  email: string;
  expiresAt: string;
}

/** Read-only. Spends nothing, so a mail scanner opening the link is harmless. */
export async function inspectInvite(
  options: BaseOptions & { invite: string },
): Promise<InviteSummary> {
  const response = await authRequest("/api/invites/inspect", {
    ...options,
    body: { invite: options.invite },
    fallback: "Could not read the invite",
  });
  const body = (await response.json()) as Partial<InviteSummary>;
  return { email: String(body.email ?? ""), expiresAt: String(body.expiresAt ?? "") };
}

/** Confirms a new address from the link sent to it. */
export async function confirmEmailChange(options: BaseOptions & { token: string }): Promise<void> {
  await authRequest("/api/auth/email-confirm", {
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    body: { token: options.token },
    fallback: "Could not confirm the address",
  });
}

/**
 * Revoke the bearer server-side.
 *
 * The caller must clear the saved token only after this resolves. Clearing
 * first and then failing the request leaves a row in `tokens` that stays valid
 * until it expires, with nobody left who can present it for deletion.
 */
export async function signOut(options: TokenOptions): Promise<void> {
  await authRequest("/api/auth/token", {
    ...options,
    method: "DELETE",
    fallback: "Sign out failed",
  });
}

/**
 * Replace the password. The API revokes every existing session and returns a
 * new token for this one.
 *
 * @returns The replacement bearer token.
 */
export async function changePassword(
  options: TokenOptions & { currentPassword: string; password: string; code?: string },
): Promise<string> {
  const passwordIssue = newPasswordProblem(options.password);
  if (passwordIssue !== null) {
    throw new ShareAccountError(newPasswordMessage(passwordIssue), { code: passwordIssue });
  }
  const response = await authRequest("/api/auth/password", {
    ...options,
    body: {
      currentPassword: options.currentPassword,
      password: options.password,
      ...withCode(options.code),
    },
    fallback: "Could not change the password",
  });
  return readToken(response);
}

/** Sent only when typed, so a request to a server without two-factor is unchanged. */
function withCode(code: string | undefined): { code?: string } {
  const value = code?.trim() ?? "";
  return value === "" ? {} : { code: value };
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
  if (problem) {
    throw new ShareAccountError(problem, {
      code: USERNAME_PATTERN.test(options.username)
        ? (newPasswordProblem(options.password, { username: options.username }) ?? "unknown")
        : "username-invalid",
    });
  }
  const invite = options.invite?.trim() ?? "";
  if (invite === "") {
    throw new ShareAccountError("An invite is required to create an account.", {
      code: "invite-invalid",
    });
  }
  let response: Response;
  try {
    response = await authRequest("/api/accounts", {
      ...options,
      body: {
        username: options.username,
        password: options.password,
        invite,
        turnstileToken: options.turnstileToken ?? "",
      },
      fallback: "Could not create the account",
    });
  } catch (error) {
    if (error instanceof ShareAccountError && error.code === "username-taken") {
      throw new ShareAccountError(
        "That username is taken. Sign in instead, or pick another name.",
        { code: "username-taken", status: 409 },
      );
    }
    throw error;
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token === "string" && body.token) return body.token;
  // A brand-new account has no second factor yet, so anything but a token is
  // the server misbehaving.
  const signedIn = await signIn(options);
  if (signedIn.kind !== "token") throw new ShareAccountError("The server did not return a token.");
  return signedIn.token;
}

/** `GET /api/account`, as the self-hosted server extends it. */
export interface AccountInfo {
  id: string;
  username: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  /** Decides only what the app draws; every admin route checks again. */
  isAdmin: boolean;
  mfaEnabled: boolean;
  recoveryCodesLeft: number;
}

export async function fetchAccount(options: TokenOptions): Promise<AccountInfo> {
  const response = await authRequest("/api/account", {
    ...options,
    method: "GET",
    fallback: "Could not load the account",
  });
  const body = (await response.json()) as { account?: Partial<AccountInfo> };
  const account = body.account ?? {};
  return {
    id: String(account.id ?? ""),
    username: typeof account.username === "string" ? account.username : null,
    email: typeof account.email === "string" ? account.email : null,
    emailVerifiedAt: typeof account.emailVerifiedAt === "string" ? account.emailVerifiedAt : null,
    isAdmin: account.isAdmin === true,
    mfaEnabled: account.mfaEnabled === true,
    recoveryCodesLeft:
      typeof account.recoveryCodesLeft === "number" ? account.recoveryCodesLeft : 0,
  };
}

/** One signed-in device. `id` is the token's digest, never the token. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

export async function listSessions(options: TokenOptions): Promise<SessionInfo[]> {
  const response = await authRequest("/api/auth/sessions", {
    ...options,
    method: "GET",
    fallback: "Could not load sessions",
  });
  const body = (await response.json()) as { sessions?: SessionInfo[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
}

export async function revokeSession(options: TokenOptions & { id: string }): Promise<void> {
  await authRequest(`/api/auth/sessions/${encodeURIComponent(options.id)}`, {
    ...options,
    method: "DELETE",
    fallback: "Could not sign that device out",
  });
}

/** Ends every session, this one included. The caller then clears its token. */
export async function signOutEverywhere(options: TokenOptions): Promise<void> {
  await authRequest("/api/auth/sessions", {
    ...options,
    method: "DELETE",
    fallback: "Could not sign out everywhere",
  });
}

/**
 * Sends a confirmation link to the new address. Nothing changes until it is
 * opened; the old address is told either way.
 */
export async function requestEmailChange(
  options: TokenOptions & { email: string; currentPassword: string; code?: string },
): Promise<void> {
  await authRequest("/api/auth/email", {
    ...options,
    body: {
      email: options.email.trim(),
      currentPassword: options.currentPassword,
      ...withCode(options.code),
    },
    fallback: "Could not change the email address",
  });
}

/** Step one of turning two-factor on. Nothing is enforced until {@link enableMfa}. */
export interface MfaSetup {
  /** Base32, for typing into an app that cannot scan. */
  secret: string;
  /** `otpauth://` URI; the app renders it as a QR code locally. */
  otpauthUri: string;
}

export async function startMfaSetup(
  options: TokenOptions & { currentPassword: string },
): Promise<MfaSetup> {
  const response = await authRequest("/api/auth/mfa/setup", {
    ...options,
    body: { currentPassword: options.currentPassword },
    fallback: "Could not start two-factor setup",
  });
  const body = (await response.json()) as Partial<MfaSetup>;
  if (typeof body.secret !== "string" || typeof body.otpauthUri !== "string") {
    throw new ShareAccountError("The server did not return a two-factor secret.");
  }
  return { secret: body.secret, otpauthUri: body.otpauthUri };
}

async function readRecoveryCodes(response: Response): Promise<string[]> {
  const body = (await response.json()) as { recoveryCodes?: unknown };
  const codes = Array.isArray(body.recoveryCodes)
    ? body.recoveryCodes.filter((code): code is string => typeof code === "string")
    : [];
  if (codes.length === 0) throw new ShareAccountError("The server did not return recovery codes.");
  return codes;
}

/**
 * Confirms setup with one code from the app.
 *
 * @returns The recovery codes. The server keeps only their hashes, so this is
 *   the one time they can be shown.
 */
export async function enableMfa(options: TokenOptions & { code: string }): Promise<string[]> {
  const response = await authRequest("/api/auth/mfa/enable", {
    ...options,
    body: { code: options.code.trim() },
    fallback: "Could not turn on two-factor authentication",
  });
  return readRecoveryCodes(response);
}

export async function disableMfa(
  options: TokenOptions & { currentPassword: string; code: string },
): Promise<void> {
  await authRequest("/api/auth/mfa/disable", {
    ...options,
    body: { currentPassword: options.currentPassword, ...withCode(options.code) },
    fallback: "Could not turn off two-factor authentication",
  });
}

/** Replaces every recovery code, used or not. */
export async function regenerateRecoveryCodes(
  options: TokenOptions & { currentPassword: string; code: string },
): Promise<string[]> {
  const response = await authRequest("/api/auth/mfa/recovery-codes", {
    ...options,
    body: { currentPassword: options.currentPassword, ...withCode(options.code) },
    fallback: "Could not create new recovery codes",
  });
  return readRecoveryCodes(response);
}
