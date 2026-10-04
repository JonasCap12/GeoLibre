import { Button, Input, Label } from "@geolibre/ui";
import {
  KeyRound,
  Mail,
  Monitor,
  MonitorSmartphone,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  MIN_PASSWORD_LENGTH,
  changePassword,
  disableMfa,
  enableMfa,
  listSessions,
  newPasswordProblem,
  regenerateRecoveryCodes,
  requestEmailChange,
  revokeSession,
  signOutEverywhere,
  startMfaSetup,
  type AccountInfo,
  type MfaSetup,
  type SessionInfo,
} from "../../lib/share-account";
import { describeUserAgent } from "../../lib/user-agent";
import { authCodeText, authErrorText } from "./auth-error-text";
import { MfaCodeField } from "./MfaCodeField";
import { PasswordField } from "./PasswordField";

// The panels of the account center (AccountCenter.tsx). Each is a self-contained
// card with its own busy and error state, so one failing form never blanks
// another.

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

/** A titled card. Every panel in the account center and the admin area uses it. */
export function Section({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground shadow-sm">
      <header className="flex items-start gap-3">
        {Icon ? (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="h-4 w-4" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0 space-y-0.5 text-start">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </header>
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

export function SessionsSection({
  token,
  onToken,
}: {
  token: string;
  onToken: (token: string) => void;
}) {
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
    <Section
      title={t("auth.sessions.title")}
      description={t("auth.sessions.description")}
      icon={MonitorSmartphone}
    >
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

/** `ABCD EFGH …` so a secret typed by hand is easy to check against the screen. */
export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})(?=.)/g, "$1 ");
}

type MfaStage =
  | { kind: "idle" }
  | { kind: "scan"; setup: MfaSetup }
  | { kind: "codes"; codes: string[] };

export function MfaSection({
  token,
  account,
  onAccountChange,
}: {
  token: string;
  account: AccountInfo | null;
  onAccountChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [stage, setStage] = useState<MfaStage>({ kind: "idle" });
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await work();
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const showCodes = (codes: string[]) => {
    // Neither factor is needed again on this screen; do not keep them typed in.
    setCurrent("");
    setCode("");
    setSaved(false);
    setStage({ kind: "codes", codes });
  };

  if (account === null) return null;

  if (stage.kind === "codes") {
    const text = stage.codes.join("\n");
    return (
      <Section
        title={t("auth.mfa.title")}
        description={t("auth.mfa.codesDescription")}
        icon={ShieldCheck}
      >
        <ul
          className="grid grid-cols-2 gap-1 rounded-md border bg-muted/40 p-2 font-mono text-xs"
          aria-label={t("auth.mfa.codesLabel")}
        >
          {stage.codes.map((recovery) => (
            <li key={recovery} dir="ltr" className="text-start">
              {recovery}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void (async () => {
                try {
                  await navigator.clipboard.writeText(text);
                  setNote(t("auth.mfa.copied"));
                } catch {
                  setError(t("auth.mfa.copyFailed"));
                }
              })()
            }
          >
            {t("auth.mfa.copy")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => downloadText("geolibre-recovery-codes.txt", `${text}\n`)}
          >
            {t("auth.mfa.download")}
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={saved}
            onChange={(event) => setSaved(event.target.checked)}
          />
          {t("auth.mfa.savedConfirm")}
        </label>
        <Button
          type="button"
          size="sm"
          disabled={!saved || busy}
          onClick={() =>
            // Reload first: going idle on the stale account would flash "Off".
            void act(async () => {
              await onAccountChange();
              setStage({ kind: "idle" });
            })
          }
        >
          {t("auth.mfa.done")}
        </Button>
        <StatusLines error={error} note={note} />
      </Section>
    );
  }

  if (stage.kind === "scan") {
    return (
      <Section
        title={t("auth.mfa.title")}
        description={t("auth.mfa.scanDescription")}
        icon={ShieldCheck}
      >
        <div className="flex flex-wrap items-start gap-3">
          {/* Drawn here from the URI: the secret never goes to a QR service. */}
          <div className="rounded-md bg-white p-2">
            <QRCodeSVG value={stage.setup.otpauthUri} size={152} marginSize={0} />
          </div>
          <div className="min-w-0 flex-1 space-y-1 text-xs">
            <p className="text-muted-foreground">{t("auth.mfa.manualEntry")}</p>
            <code dir="ltr" className="block break-all rounded bg-muted px-2 py-1 font-mono">
              {groupSecret(stage.setup.secret)}
            </code>
          </div>
        </div>
        <form
          className="space-y-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => showCodes(await enableMfa({ token, code })));
          }}
        >
          <MfaCodeField
            id="security-mfa-enable-code"
            label={t("auth.mfa.firstCode")}
            value={code}
            onChange={setCode}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy || code.trim() === ""}>
              {t("auth.mfa.enable")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setStage({ kind: "idle" });
                setCode("");
              }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </form>
        <StatusLines error={error} note={note} />
      </Section>
    );
  }

  if (!account.mfaEnabled) {
    return (
      <Section
        title={t("auth.mfa.title")}
        description={t("auth.mfa.offDescription")}
        icon={ShieldCheck}
      >
        {account.isAdmin ? (
          <p className="text-xs font-medium text-destructive">{t("auth.mfa.adminRequired")}</p>
        ) : null}
        <form
          className="space-y-2"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const setup = await startMfaSetup({ token, currentPassword: current });
              setCurrent("");
              setCode("");
              setStage({ kind: "scan", setup });
            });
          }}
        >
          <PasswordField
            id="security-mfa-setup-password"
            label={t("auth.currentPassword")}
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
          />
          <Button type="submit" size="sm" disabled={busy || current === ""}>
            {t("auth.mfa.setUp")}
          </Button>
        </form>
        <StatusLines error={error} note={note} />
      </Section>
    );
  }

  const reauth = { token, currentPassword: current, code };
  return (
    <Section
      title={t("auth.mfa.title")}
      description={t("auth.mfa.onDescription", { count: account.recoveryCodesLeft })}
      icon={ShieldCheck}
    >
      <PasswordField
        id="security-mfa-password"
        label={t("auth.currentPassword")}
        autoComplete="current-password"
        value={current}
        onChange={setCurrent}
      />
      <MfaCodeField id="security-mfa-code" value={code} onChange={setCode} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void act(async () => showCodes(await regenerateRecoveryCodes(reauth)))}
        >
          {t("auth.mfa.regenerate")}
        </Button>
        {confirmOff ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await disableMfa(reauth);
                  setCurrent("");
                  setCode("");
                  setConfirmOff(false);
                  await onAccountChange();
                })
              }
            >
              {t("auth.mfa.confirmDisable")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>
              {t("common.cancel")}
            </Button>
          </>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={() => setConfirmOff(true)}>
            {t("auth.mfa.disable")}
          </Button>
        )}
      </div>
      <StatusLines error={error} note={note} />
    </Section>
  );
}

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function EmailSection({ token, account }: { token: string; account: AccountInfo | null }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [current, setCurrent] = useState("");
  const [code, setCode] = useState("");
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
      await requestEmailChange({ token, email, currentPassword: current, code });
      // The address on the account is unchanged until the link is opened.
      setNote(t("auth.emailChange.sent", { email: email.trim() }));
      setCurrent("");
      setCode("");
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t("auth.emailChange.title")}
      description={
        account?.email
          ? t("auth.emailChange.currentAddress", { email: account.email })
          : t("auth.emailChange.noAddress")
      }
      icon={Mail}
    >
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
        {account?.mfaEnabled ? (
          <MfaCodeField id="security-email-code" value={code} onChange={setCode} />
        ) : null}
        <Button type="submit" size="sm" disabled={busy}>
          {t("auth.emailChange.submit")}
        </Button>
      </form>
      <StatusLines error={error} note={note} />
    </Section>
  );
}

export function PasswordSection({
  token,
  account,
  onToken,
}: {
  token: string;
  account: AccountInfo | null;
  onToken: (token: string) => void;
}) {
  const { t } = useTranslation();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
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
      const fresh = await changePassword({
        token,
        currentPassword: current,
        password: next,
        code,
      });
      setCurrent("");
      setNext("");
      setConfirm("");
      setCode("");
      setNote(t("auth.passwordChange.changed"));
      onToken(fresh);
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t("auth.passwordChange.title")}
      description={t("auth.passwordChange.description")}
      icon={KeyRound}
    >
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
        {account?.mfaEnabled ? (
          <MfaCodeField id="security-password-code" value={code} onChange={setCode} />
        ) : null}
        <Button type="submit" size="sm" disabled={busy}>
          {t("auth.passwordChange.submit")}
        </Button>
      </form>
      <StatusLines error={error} note={note} />
    </Section>
  );
}
