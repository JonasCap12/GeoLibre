import { Button, Input, Label } from "@geolibre/ui";
import type { TFunction } from "i18next";
import { MailPlus, Send } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  listAccounts,
  listAuthEvents,
  listInvites,
  resendInvite,
  resetAccountMfa,
  revokeAccountSessions,
  revokeInvite,
  sendInvite,
  setAccountDisabled,
  type AdminAccount,
  type AdminInvite,
  type AuthEvent,
} from "../../lib/selfhost-admin";
import type { AccountInfo } from "../../lib/share-account";
import { deviceName, formatAuthDate, Section, StatusLines } from "./AccountSecurityDialog";
import { authCodeText, authErrorText } from "./auth-error-text";

// The admin panels of the account center (AccountCenter.tsx). Only drawn for
// an admin, and every route behind them checks again on the server.

const EVENT_LABELS = {
  login_success: "auth.admin.event.login_success",
  login_failure: "auth.admin.event.login_failure",
  logout: "auth.admin.event.logout",
  logout_all: "auth.admin.event.logout_all",
  session_revoked: "auth.admin.event.session_revoked",
  password_changed: "auth.admin.event.password_changed",
  reset_requested: "auth.admin.event.reset_requested",
  reset_completed: "auth.admin.event.reset_completed",
  invite_created: "auth.admin.event.invite_created",
  invite_used: "auth.admin.event.invite_used",
  invite_revoked: "auth.admin.event.invite_revoked",
  email_change_requested: "auth.admin.event.email_change_requested",
  email_changed: "auth.admin.event.email_changed",
  mfa_enabled: "auth.admin.event.mfa_enabled",
  mfa_disabled: "auth.admin.event.mfa_disabled",
  mfa_recovery_used: "auth.admin.event.mfa_recovery_used",
  mfa_recovery_regenerated: "auth.admin.event.mfa_recovery_regenerated",
  mfa_failure: "auth.admin.event.mfa_failure",
  mfa_reset: "auth.admin.event.mfa_reset",
  account_disabled: "auth.admin.event.account_disabled",
  account_enabled: "auth.admin.event.account_enabled",
  sessions_revoked: "auth.admin.event.sessions_revoked",
} as const;

const INVITE_STATUS = {
  pending: "auth.admin.inviteStatus.pending",
  used: "auth.admin.inviteStatus.used",
  expired: "auth.admin.inviteStatus.expired",
} as const;

const EVENT_PAGE = 100;

/** Shared busy/error/note state for one tab's actions. */
function useAction() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (work: () => Promise<void>, success: string | null = null) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
      setNote(success);
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, run, setError };
}

export function InvitesTab({ token }: { token: string }) {
  const { t } = useTranslation();
  const action = useAction();
  const [invites, setInvites] = useState<AdminInvite[] | null>(null);
  const [email, setEmail] = useState("");
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      setInvites(await listInvites({ token }));
    } catch (err) {
      setError(authErrorText(t, err));
    }
  }, [token, t, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSend = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.includes("@")) return action.setError(authCodeText(t, "email-invalid"));
    const address = email.trim();
    await action.run(
      async () => {
        await sendInvite({ token, email: address });
        setEmail("");
        await load();
      },
      t("auth.admin.inviteSent", { email: address }),
    );
  };

  return (
    <div className="space-y-4">
      <Section
        title={t("auth.admin.sendInvite")}
        description={t("auth.admin.inviteHelp")}
        icon={MailPlus}
      >
        <form onSubmit={(event) => void onSend(event)} className="flex items-end gap-2" noValidate>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="admin-invite-email">{t("auth.email")}</Label>
            <Input
              id="admin-invite-email"
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Button type="submit" size="sm" disabled={action.busy}>
            {t("auth.admin.send")}
          </Button>
        </form>
      </Section>
      <StatusLines error={action.error} note={action.note} />
      <Section title={t("auth.admin.invites")} icon={Send}>
        {invites === null ? (
          <p className="text-xs text-muted-foreground">{t("auth.loading")}</p>
        ) : null}
        {invites?.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("auth.admin.noInvites")}</p>
        ) : null}
        <ul className="space-y-2">
          {(invites ?? []).map((invite) => (
            <li key={invite.id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
              <div className="min-w-0 flex-1 space-y-0.5 text-start">
                <p className="truncate font-medium">
                  {invite.email}
                  <span className="ms-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                    {t(INVITE_STATUS[invite.status])}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  {invite.status === "used"
                    ? t("auth.admin.inviteUsed", {
                        username: invite.usedBy ?? "—",
                        date: formatAuthDate(invite.usedAt),
                      })
                    : t("auth.admin.inviteExpires", { date: formatAuthDate(invite.expiresAt) })}
                </p>
              </div>
              {invite.status === "used" ? null : (
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await resendInvite({ token, id: invite.id });
                          await load();
                        },
                        t("auth.admin.inviteSent", { email: invite.email }),
                      )
                    }
                  >
                    {t("auth.admin.resend")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await revokeInvite({ token, id: invite.id });
                        await load();
                      })
                    }
                  >
                    {t("auth.admin.revoke")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export function AccountsTab({ token, self }: { token: string; self: AccountInfo }) {
  const { t } = useTranslation();
  const action = useAction();
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const { setError } = action;

  const load = useCallback(async () => {
    try {
      setAccounts(await listAccounts({ token }));
    } catch (err) {
      setError(authErrorText(t, err));
    }
  }, [token, t, setError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-2">
      <StatusLines error={action.error} note={action.note} />
      {accounts === null ? (
        <p className="text-xs text-muted-foreground">{t("auth.loading")}</p>
      ) : null}
      <ul className="space-y-2">
        {(accounts ?? []).map((account) => (
          <li key={account.id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
            <div className="min-w-0 flex-1 space-y-0.5 text-start">
              <p className="truncate font-medium">
                {account.username ?? "—"}
                {account.isAdmin ? (
                  <span className="ms-2 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {t("auth.admin.adminBadge")}
                  </span>
                ) : null}
                {account.disabledAt ? (
                  <span className="ms-2 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive">
                    {t("auth.admin.disabledBadge")}
                  </span>
                ) : null}
                {account.mfaEnabled ? (
                  <span className="ms-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                    {t("auth.admin.mfaBadge")}
                  </span>
                ) : null}
              </p>
              <p className="truncate text-muted-foreground">
                {account.email ?? t("auth.emailChange.noAddress")}
              </p>
              <p className="text-muted-foreground">
                {t("auth.admin.accountDetail", {
                  count: account.sessions,
                  date: formatAuthDate(account.lastSeenAt),
                })}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-1">
              {account.mfaEnabled && confirmReset === account.id ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await resetAccountMfa({ token, id: account.id });
                          setConfirmReset(null);
                          await load();
                        },
                        t("auth.admin.mfaResetDone", { username: account.username ?? "—" }),
                      )
                    }
                  >
                    {t("auth.admin.confirmMfaReset")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmReset(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </>
              ) : account.mfaEnabled ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={action.busy}
                  onClick={() => setConfirmReset(account.id)}
                >
                  {t("auth.admin.resetMfa")}
                </Button>
              ) : null}
              {account.sessions > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await revokeAccountSessions({ token, id: account.id });
                      await load();
                    })
                  }
                >
                  {t("auth.admin.signOutAccount")}
                </Button>
              ) : null}
              {account.id === self.id ? null : (
                <Button
                  type="button"
                  size="sm"
                  variant={account.disabledAt ? "outline" : "destructive"}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () => {
                      await setAccountDisabled({
                        token,
                        id: account.id,
                        disabled: !account.disabledAt,
                      });
                      await load();
                    })
                  }
                >
                  {account.disabledAt ? t("auth.admin.enable") : t("auth.admin.disable")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function eventLabel(t: TFunction, kind: string): string {
  if (!Object.prototype.hasOwnProperty.call(EVENT_LABELS, kind)) return kind;
  return t(EVENT_LABELS[kind as keyof typeof EVENT_LABELS]);
}

function detailText(detail: Record<string, unknown>, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value ? value : null;
}

/** The masked recipient and the acting admin, when the event records them. */
function eventNote(t: TFunction, event: AuthEvent): string | null {
  const parts: string[] = [];
  const to = detailText(event.detail, "to");
  if (to) parts.push(t("auth.admin.eventTo", { email: to }));
  const by = detailText(event.detail, "by");
  if (by && by !== event.username) parts.push(t("auth.admin.eventBy", { name: by }));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function ActivityTab({ token }: { token: string }) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AuthEvent[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMore = useCallback(
    async (offset: number) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listAuthEvents({ token, limit: EVENT_PAGE, offset });
        setEvents((previous) => (offset === 0 ? page : [...previous, ...page]));
        setDone(page.length < EVENT_PAGE);
      } catch (err) {
        setError(authErrorText(t, err));
      } finally {
        setLoading(false);
      }
    },
    [token, t],
  );

  useEffect(() => {
    void loadMore(0);
  }, [loadMore]);

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("auth.admin.activityHelp")}</p>
      <StatusLines error={error} />
      <div className="max-h-[50vh] overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-popover">
            <tr className="text-start text-muted-foreground">
              <th className="p-2 text-start font-medium">{t("auth.admin.when")}</th>
              <th className="p-2 text-start font-medium">{t("auth.admin.who")}</th>
              <th className="p-2 text-start font-medium">{t("auth.admin.what")}</th>
              <th className="p-2 text-start font-medium">{t("auth.admin.where")}</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} className="border-t align-top">
                <td className="whitespace-nowrap p-2">{formatAuthDate(event.createdAt)}</td>
                <td className="p-2">
                  {event.username ?? detailText(event.detail, "login") ?? "—"}
                </td>
                <td className="p-2">
                  <span className="block">{eventLabel(t, event.kind)}</span>
                  <span className="block text-muted-foreground">{eventNote(t, event)}</span>
                </td>
                <td className="max-w-[14rem] p-2">
                  <span className="block">{event.ip ?? "—"}</span>
                  {event.userAgent ? (
                    <span className="block truncate text-muted-foreground" title={event.userAgent}>
                      {deviceName(t, event.userAgent)}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {done ? null : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => void loadMore(events.length)}
        >
          {t("auth.admin.loadMore")}
        </Button>
      )}
    </div>
  );
}
