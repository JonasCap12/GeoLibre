/**
 * Client for the self-hosted projects API's `/api/admin/*` routes.
 *
 * Admin status comes from GEOLIBRE_ADMIN_USERNAMES on the server. The app only
 * uses `isAdmin` from `GET /api/account` to decide whether to draw the admin
 * dialog; every route here is checked again server-side.
 */

import { authRequest } from "./share-account";

interface AdminOptions {
  token: string;
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

/** Mirrors `inviteStatus` in workers/projects-api/src/auth-policy.ts. */
export type InviteStatus = "pending" | "used" | "expired";

export interface AdminInvite {
  /** The invite's digest. Identifies it without being able to redeem it. */
  id: string;
  email: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  createdBy: string | null;
  usedBy: string | null;
}

export interface AdminAccount {
  id: string;
  username: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  disabledAt: string | null;
  isAdmin: boolean;
  mfaEnabled: boolean;
  sessions: number;
  lastSeenAt: string | null;
}

export interface AuthEvent {
  id: string;
  accountId: string | null;
  username: string | null;
  kind: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  detail: Record<string, unknown>;
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

export async function listInvites(options: AdminOptions): Promise<AdminInvite[]> {
  const response = await authRequest("/api/admin/invites", {
    ...options,
    method: "GET",
    fallback: "Could not load invites",
  });
  return (await readJson<{ invites?: AdminInvite[] }>(response)).invites ?? [];
}

export async function sendInvite(options: AdminOptions & { email: string }): Promise<void> {
  await authRequest("/api/invites", {
    ...options,
    body: { email: options.email.trim() },
    fallback: "Could not send the invite",
  });
}

export async function revokeInvite(options: AdminOptions & { id: string }): Promise<void> {
  await authRequest(`/api/admin/invites/${encodeURIComponent(options.id)}`, {
    ...options,
    method: "DELETE",
    fallback: "Could not revoke the invite",
  });
}

/** Replaces the invite with a fresh link and expiry; the old link stops working. */
export async function resendInvite(options: AdminOptions & { id: string }): Promise<void> {
  await authRequest(`/api/admin/invites/${encodeURIComponent(options.id)}/resend`, {
    ...options,
    fallback: "Could not resend the invite",
  });
}

export async function listAccounts(options: AdminOptions): Promise<AdminAccount[]> {
  const response = await authRequest("/api/admin/accounts", {
    ...options,
    method: "GET",
    fallback: "Could not load accounts",
  });
  return (await readJson<{ accounts?: AdminAccount[] }>(response)).accounts ?? [];
}

/** Disabling also ends every session of the account. */
export async function setAccountDisabled(
  options: AdminOptions & { id: string; disabled: boolean },
): Promise<void> {
  const action = options.disabled ? "disable" : "enable";
  await authRequest(`/api/admin/accounts/${encodeURIComponent(options.id)}/${action}`, {
    ...options,
    fallback: options.disabled ? "Could not disable the account" : "Could not enable the account",
  });
}

export async function revokeAccountSessions(options: AdminOptions & { id: string }): Promise<void> {
  await authRequest(`/api/admin/accounts/${encodeURIComponent(options.id)}/sessions`, {
    ...options,
    method: "DELETE",
    fallback: "Could not sign the account out",
  });
}

/** For a lost phone: clears the account's second factor and signs it out everywhere. */
export async function resetAccountMfa(options: AdminOptions & { id: string }): Promise<void> {
  await authRequest(`/api/admin/accounts/${encodeURIComponent(options.id)}/mfa`, {
    ...options,
    method: "DELETE",
    fallback: "Could not reset two-factor authentication",
  });
}

export async function listAuthEvents(
  options: AdminOptions & { limit?: number; offset?: number },
): Promise<AuthEvent[]> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  const response = await authRequest(`/api/admin/events?${params.toString()}`, {
    ...options,
    method: "GET",
    fallback: "Could not load the activity log",
  });
  return (await readJson<{ events?: AuthEvent[] }>(response)).events ?? [];
}
