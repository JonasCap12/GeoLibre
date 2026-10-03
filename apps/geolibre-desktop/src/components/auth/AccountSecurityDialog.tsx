import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@geolibre/ui";
import { Monitor } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  MIN_PASSWORD_LENGTH,
  changePassword,
  listSessions,
  newPasswordProblem,
  requestEmailChange,
  revokeSession,
  signOutEverywhere,
  type AccountInfo,
  type SessionInfo,
} from "../../lib/share-account";
import { describeUserAgent } from "../../lib/user-agent";
import { authCodeText, authErrorText } from "./auth-error-text";
import { PasswordField } from "./PasswordField";

interface AccountSecurityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  token: string;
  account: AccountInfo | null;
  /** Stores a replacement bearer, or "" once this session has ended. */
  onToken: (token: string) => void;
}

export function formatAuthDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

/** "Chrome 148 on Windows" when the User-Agent is recognised, else the raw header. */
export function deviceName(t: TFunction, userAgent: string | null): string {
  const summary = describeUserAgent(userAgent);
  if (summary) return t("auth.sessions.deviceSummary", { ...summary });
  return userAgent || t("auth.sessions.unknownDevice");
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function StatusLines({ error, note }: { error: string | null; note?: string | null }) {
  return (
    <>
      <div aria-live="assertive" aria-atomic="true">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
    </>
  );
}

export function AccountSecurityDialog({
  open,
  onOpenChange,
  token,
  account,
  onToken,
}: AccountSecurityDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("auth.security.title")}</DialogTitle>
          <DialogDescription>
            {account?.username
              ? t("auth.security.description", { username: account.username })
              : null}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <div className="space-y-4">
            <SessionsSection token={token} onToken={onToken} />
            <EmailSection token={token} account={account} />
            <PasswordSection token={token} onToken={onToken} />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SessionsSection({ token, onToken }: { token: string; onToken: (token: string) => void }) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setSessions(await listSessions({ token }));
    } catch (err) {
      setError(authErrorText(t, err));
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("auth.sessions.title")}>
      <p className="text-xs text-muted-foreground">{t("auth.sessions.description")}</p>
      {sessions === null && error === null ? (
        <p className="text-xs text-muted-foreground">{t("auth.loading")}</p>
      ) : null}
      <ul className="space-y-2">
        {(sessions ?? []).map((session) => (
          <li key={session.id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
            <Monitor className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1 space-y-0.5 text-start">
              <p className="flex min-w-0 items-center gap-2 font-medium">
                <span className="truncate" title={session.userAgent ?? undefined}>
                  {deviceName(t, session.userAgent)}
                </span>
                {session.current ? (
                  <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                    {t("auth.sessions.current")}
                  </span>
                ) : null}
              </p>
              <p className="text-muted-foreground">
                {t("auth.sessions.detail", {
                  ip: session.ip ?? "—",
                  created: formatAuthDate(session.createdAt),
                  used: formatAuthDate(session.lastUsedAt),
                })}
              </p>
            </div>
            {session.current ? null : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await revokeSession({ token, id: session.id });
                    await load();
                  })
                }
              >
                {t("auth.sessions.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {confirmAll ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await signOutEverywhere({ token });
                  onToken("");
                })
              }
            >
              {t("auth.sessions.confirmAll")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmAll(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmAll(true)}>
            {t("auth.sessions.signOutAll")}
          </Button>
        )}
      </div>
      <StatusLines error={error} />
    </Section>
  );
}

function EmailSection({ token, account }: { token: string; account: AccountInfo | null }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!email.includes("@")) return setError(authCodeText(t, "email-invalid"));
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await requestEmailChange({ token, email, currentPassword: current });
      // The address on the account is unchanged until the link is opened.
      setNote(t("auth.emailChange.sent", { email: email.trim() }));
      setCurrent("");
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("auth.emailChange.title")}>
      <p className="text-xs text-muted-foreground">
        {account?.email
          ? t("auth.emailChange.currentAddress", { email: account.email })
          : t("auth.emailChange.noAddress")}
      </p>
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-2" noValidate>
        <div className="space-y-1.5">
          <Label htmlFor="security-new-email">{t("auth.emailChange.newAddress")}</Label>
          <Input
            id="security-new-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <PasswordField
          id="security-email-password"
          label={t("auth.currentPassword")}
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t("auth.emailChange.submit")}
        </Button>
      </form>
      <StatusLines error={error} note={note} />
    </Section>
  );
}

function PasswordSection({ token, onToken }: { token: string; onToken: (token: string) => void }) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = newPasswordProblem(next);
    if (problem) return setError(authCodeText(t, problem));
    if (next !== confirm) return setError(authCodeText(t, "password-mismatch"));
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const fresh = await changePassword({ token, currentPassword: current, password: next });
      setCurrent("");
      setNext("");
      setConfirm("");
      setNote(t("auth.passwordChange.changed"));
      onToken(fresh);
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("auth.passwordChange.title")}>
      <p className="text-xs text-muted-foreground">{t("auth.passwordChange.description")}</p>
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-2" noValidate>
        <PasswordField
          id="security-current-password"
          label={t("auth.currentPassword")}
          autoComplete="current-password"
          value={current}
          onChange={setCurrent}
        />
        <PasswordField
          id="security-new-password"
          label={t("auth.newPassword")}
          autoComplete="new-password"
          value={next}
          onChange={setNext}
          hint={t("auth.passwordHint", { count: MIN_PASSWORD_LENGTH })}
        />
        <PasswordField
          id="security-confirm-password"
          label={t("auth.confirmPassword")}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
        />
        <Button type="submit" size="sm" disabled={busy}>
          {t("auth.passwordChange.submit")}
        </Button>
      </form>
      <StatusLines error={error} note={note} />
    </Section>
  );
}
