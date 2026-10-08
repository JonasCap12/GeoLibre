/**
 * What the signed-in account button should say, and when it should nag.
 * Pure so the toolbar and the floating fallback share one rule.
 */

export interface AccountAttentionInput {
  username: string | null;
  email: string | null;
  emailVerifiedAt: string | null;
  mfaEnabled: boolean;
  /** Set while two-factor is required and not yet on. */
  mfaRequiredBy: string | null;
}

export type AccountAttentionKind = "mfa" | "email";

/**
 * MFA first: a deadline is the thing that locks the account out. An unverified
 * email is the fallback when two-factor is not the open task.
 */
export function accountAttentionKind(
  account: AccountAttentionInput | null,
): AccountAttentionKind | null {
  if (!account) return null;
  if (account.mfaRequiredBy !== null && !account.mfaEnabled) return "mfa";
  if (account.email && account.emailVerifiedAt === null) return "email";
  return null;
}

export function accountNeedsAttention(account: AccountAttentionInput | null): boolean {
  return accountAttentionKind(account) !== null;
}

/** Account Center view that can clear the open attention item. */
export function accountAttentionView(kind: AccountAttentionKind): "security" | "email" {
  return kind === "mfa" ? "security" : "email";
}

/**
 * Screen-reader name for the trigger: the account label, whose account it is,
 * and the attention sentence when there is one.
 */
export function accountTriggerLabel(
  account: { username: string | null } | null,
  labels: { account: string; attention: string | null },
): string {
  const name = account?.username?.trim();
  const who = name ? `${labels.account}: ${name}` : labels.account;
  return labels.attention ? `${who}. ${labels.attention}` : who;
}
