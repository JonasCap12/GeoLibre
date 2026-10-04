import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import { LogOut, ShieldAlert, ShieldCheck, User, UserRound, X } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBeforeUnloadGuard } from "../../hooks/useBeforeUnloadGuard";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import { installSessionWatch } from "../../lib/session-watch";
import {
  ShareAccountError,
  USERNAME_PATTERN,
  completeMfaSignIn,
  confirmEmailChange,
  confirmPasswordReset,
  createAccount,
  fetchAccount,
  inspectInvite,
  mfaCodeProblem,
  newPasswordProblem,
  requestPasswordReset,
  signIn,
  signInProblem,
  signOut,
  type AccountInfo,
  type AuthErrorCode,
  type InviteSummary,
} from "../../lib/share-account";
import { resolveShareBaseUrl } from "../../lib/share-geolibre";
import {
  captureSelfHostRoute,
  leaveSelfHostRoute,
  type SelfHostRoute,
} from "../../lib/selfhost-routes";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile";
import { AccountCenter, type AccountView } from "./AccountCenter";
import { MfaSection } from "./AccountSecurityDialog";
import { AccountAvatar, RoleBadge } from "./account-badges";
import { authCodeText, authErrorText } from "./auth-error-text";
import { MfaCodeField } from "./MfaCodeField";
import { PasswordField } from "./PasswordField";
import { PasswordMatch, PasswordStrength } from "./PasswordStrength";
import { TurnstileWidget, turnstileRequired } from "./TurnstileWidget";

/**
 * Optional whole-app sign-in gate for a self-hosted deployment, backed by
 * this deployment's own accounts.
 *
 * Loaded only when `VITE_GEOLIBRE_SELFHOST_AUTH` is set. There is no SDK and
 * no redirect: the form posts to the projects API and stores the bearer in
 * `shareToken`, which is what the cloud workspace, the library, collaboration
 * and project sharing already read. A second token store would leave those
 * features signed out after a successful login.
 *
 * Registration is invite-only. The links in invite, reset and email-change
 * mails open `/register`, `/reset` and `/verify-email`; those are read from the
 * path before the token check, so a link works whether or not someone is
 * already signed in on this browser.
 */
export function SelfHostGate({ children }: { children: ReactNode }) {
  // Same reason as Auth0Gate: App unmounts when the session ends, and the
  // project state survives in the module store, so the tab could otherwise
  // close with unsaved changes and no prompt.
  useBeforeUnloadGuard();
  const { t } = useTranslation();
  const [route, setRoute] = useState<SelfHostRoute>(() => captureSelfHostRoute());
  const [notice, setNotice] = useState<string | null>(null);
  const token = useDesktopSettingsStore((state) => state.desktopSettings.shareToken.trim());

  useEffect(() => {
    const baseUrl = resolveShareBaseUrl();
    if (!token || !baseUrl) return;
    return installSessionWatch({
      baseUrl,
      getToken: () => useDesktopSettingsStore.getState().desktopSettings.shareToken.trim(),
      onExpired: () => {
        writeShareToken("");
        setNotice(t("auth.sessionEnded"));
      },
    });
  }, [token, t]);

  const leave = (message: string | null = null) => {
    leaveSelfHostRoute();
    setRoute({ page: "app" });
    setNotice(message);
  };

  if (route.page === "register") {
    return (
      <RegisterScreen
        invite={route.token}
        onDone={(fresh) => {
          writeShareToken(fresh);
          leave();
        }}
        onCancel={() => leave()}
      />
    );
  }
  if (route.page === "reset") {
    return (
      <ResetScreen
        token={route.token}
        onDone={() => {
          // The server ended every session, this browser's included.
          writeShareToken("");
          leave(t("auth.resetDone"));
        }}
        onCancel={() => leave()}
      />
    );
  }
  if (route.page === "verify-email") {
    return <VerifyEmailScreen token={route.token} onDone={() => leave()} />;
  }
  if (!token) return <SignInScreen notice={notice} />;
  return <SignedIn token={token}>{children}</SignedIn>;
}

/**
 * The app for a signed-in account, gated on two-factor.
 *
 * Every account must turn two-factor on by a deadline the API reports. Before
 * it, a banner says so; after it, the API refuses everything but setup, so the
 * app is replaced by the setup screen rather than left to fail call by call.
 */
function SignedIn({ token, children }: { token: string; children: ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A 401 here is handled by the session watch, which signs the tab out.
    fetchAccount({ token })
      .then((info) => {
        if (!cancelled) setAccount(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  const reload = async () => {
    const info = await fetchAccount({ token });
    setAccount(info);
    if (info.mfaEnabled) setEnrolling(false);
  };

  if (account !== null && (account.mfaEnrollmentRequired || enrolling)) {
    return (
      <MfaEnrollmentScreen
        token={token}
        account={account}
        required={account.mfaEnrollmentRequired}
        onAccountChange={reload}
        onLater={() => setEnrolling(false)}
      />
    );
  }

  const deadline =
    account !== null && !account.mfaEnabled && account.mfaRequiredBy !== null && !bannerHidden
      ? account.mfaRequiredBy
      : null;

  return (
    <>
      {children}
      {deadline ? (
        <MfaDeadlineBanner
          deadline={deadline}
          onSetUp={() => setEnrolling(true)}
          onDismiss={() => setBannerHidden(true)}
        />
      ) : null}
      <UserMenu token={token} />
    </>
  );
}

/** In the app's language, not the browser's: the sentence around it is translated. */
function formatDeadline(iso: string, locale: string | undefined): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short" }).format(date);
  } catch {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(
      date,
    );
  }
}

/** The reminder before the two-factor deadline. Hidden for the tab once dismissed. */
function MfaDeadlineBanner({
  deadline,
  onSetUp,
  onDismiss,
}: {
  deadline: string;
  onSetUp: () => void;
  onDismiss: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[95] flex w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-500/40 bg-background/95 p-3 text-sm shadow-lg backdrop-blur"
    >
      <ShieldAlert className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <p className="min-w-0 flex-1 text-start">
        {t("auth.enforce.banner", { date: formatDeadline(deadline, i18n.resolvedLanguage) })}
      </p>
      <Button type="button" size="sm" onClick={onSetUp}>
        {t("auth.enforce.setUp")}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="h-7 w-7 shrink-0"
        aria-label={t("auth.enforce.dismiss")}
        onClick={onDismiss}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Turning two-factor on, full screen. `required` means the deadline has passed
 * and there is no way back to the app until it is on; otherwise "Later" closes.
 */
function MfaEnrollmentScreen({
  token,
  account,
  required,
  onAccountChange,
  onLater,
}: {
  token: string;
  account: AccountInfo;
  required: boolean;
  onAccountChange: () => Promise<void>;
  onLater: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const leave = async () => {
    setBusy(true);
    try {
      await signOut({ token });
    } catch (err) {
      console.warn("sign-out could not reach the server; clearing the local session", err);
    } finally {
      writeShareToken("");
      setBusy(false);
    }
  };
  return (
    <AuthScreen>
      <AuthHeading
        title={t("auth.enforce.title")}
        description={
          required
            ? t("auth.enforce.overdue")
            : t("auth.enforce.description", {
                date: account.mfaRequiredBy
                  ? formatDeadline(account.mfaRequiredBy, i18n.resolvedLanguage)
                  : "",
              })
        }
      />
      <div className="w-full max-w-md text-start">
        <MfaSection token={token} account={account} onAccountChange={onAccountChange} />
      </div>
      <div className="flex gap-2">
        {required ? null : (
          <Button type="button" variant="ghost" onClick={onLater}>
            {t("auth.enforce.later")}
          </Button>
        )}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void leave()}>
          <LogOut className="me-2 h-4 w-4" />
          {t("auth.signOut")}
        </Button>
      </div>
    </AuthScreen>
  );
}

/** Full-screen centered layout, matching Auth0Gate's signed-out screens. */
function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      {children}
    </main>
  );
}

function AuthHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1">
      <h1 className="text-lg font-semibold">{title}</h1>
      {description ? <p className="max-w-md text-sm text-muted-foreground">{description}</p> : null}
    </div>
  );
}

/**
 * Error and status lines. Always mounted, so a screen reader announces a
 * message that appears after submit rather than only one present on load.
 */
export function FormMessages({ error, note }: { error: string | null; note?: string | null }) {
  return (
    <>
      <div aria-live="assertive" aria-atomic="true">
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
      </div>
    </>
  );
}

function writeShareToken(shareToken: string): void {
  const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({ ...desktopSettings, shareToken });
}

/** Shared form state: a busy flag, an error, a note, and a Turnstile response. */
function useAuthForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [turnstile, setTurnstile] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  return {
    busy,
    error,
    note,
    turnstile,
    turnstileReset,
    setTurnstile,
    setNote,
    fail: (message: string) => {
      setError(message);
      setNote(null);
    },
    /** Runs a submit, and asks for a fresh Turnstile response afterwards. */
    run: async (work: () => Promise<void>, onError: (error: unknown) => void) => {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await work();
      } catch (err) {
        onError(err);
      } finally {
        setBusy(false);
        setTurnstileReset((count) => count + 1);
      }
    },
  };
}

function SignInScreen({ notice }: { notice: string | null }) {
  const { t } = useTranslation();
  const form = useAuthForm();
  const [mode, setMode] = useState<"sign-in" | "forgot" | "mfa">("sign-in");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const codeText = (code: AuthErrorCode) => authCodeText(t, code);

  const backToSignIn = () => {
    setMode("sign-in");
    setTicket(null);
    setCode("");
  };

  const onSignIn = async (event: FormEvent) => {
    event.preventDefault();
    // Checked before the request so a typo does not spend one of the
    // attempts a minute the auth limiter allows.
    const problem = signInProblem(login, password);
    if (problem) return form.fail(codeText(problem));
    await form.run(
      async () => {
        const result = await signIn({ username: login, password });
        if (result.kind === "token") return writeShareToken(result.token);
        // The password is not needed again; do not keep it in memory.
        setPassword("");
        setTicket(result.ticket);
        setMode("mfa");
      },
      (err) => form.fail(authErrorText(t, err)),
    );
  };

  const onMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (ticket === null) return backToSignIn();
    const problem = mfaCodeProblem(code);
    if (problem) return form.fail(codeText(problem));
    await form.run(
      async () => writeShareToken(await completeMfaSignIn({ ticket, code })),
      (err) => {
        // A spent or expired ticket cannot take another code; the password
        // has to be typed again.
        if (err instanceof ShareAccountError && err.code === "mfa-expired") backToSignIn();
        setCode("");
        form.fail(authErrorText(t, err));
      },
    );
  };

  if (mode === "mfa") {
    return (
      <AuthScreen>
        <AuthHeading
          title={t("auth.mfa.signInTitle")}
          description={t("auth.mfa.signInDescription")}
        />
        <form
          onSubmit={(event) => void onMfa(event)}
          className="w-full max-w-sm space-y-3 text-start"
          noValidate
        >
          <MfaCodeField id="selfhost-mfa-code" value={code} onChange={setCode} autoFocus />
          <FormMessages error={form.error} />
          <Button type="submit" className="w-full" disabled={form.busy}>
            {form.busy ? t("auth.signingIn") : t("auth.mfa.verify")}
          </Button>
        </form>
        <Button variant="ghost" type="button" onClick={backToSignIn}>
          {t("auth.backToSignIn")}
        </Button>
      </AuthScreen>
    );
  }

  const onForgot = async (event: FormEvent) => {
    event.preventDefault();
    if (email.trim() === "" || !email.includes("@")) return form.fail(codeText("email-invalid"));
    if (turnstileRequired() && !form.turnstile) return form.fail(t("auth.botCheckPending"));
    await form.run(
      async () => {
        await requestPasswordReset({ email, turnstileToken: form.turnstile ?? "" });
        form.setNote(t("auth.resetRequested"));
      },
      (err) => form.fail(authErrorText(t, err)),
    );
  };

  if (mode === "forgot") {
    return (
      <AuthScreen>
        <AuthHeading
          title={t("auth.forgotPasswordTitle")}
          description={t("auth.forgotPasswordDescription")}
        />
        <form
          onSubmit={(event) => void onForgot(event)}
          className="w-full max-w-sm space-y-3 text-start"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="selfhost-email">{t("auth.email")}</Label>
            <Input
              id="selfhost-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <TurnstileWidget
            action={TURNSTILE_ACTIONS.resetRequest}
            onToken={form.setTurnstile}
            resetKey={form.turnstileReset}
          />
          <FormMessages error={form.error} note={form.note} />
          <Button type="submit" className="w-full" disabled={form.busy}>
            {t("auth.sendResetLink")}
          </Button>
        </form>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setMode("sign-in");
            form.setNote(null);
          }}
        >
          {t("auth.backToSignIn")}
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <AuthHeading title={t("auth.signInTitle")} description={t("auth.selfHostDescription")} />
      <form
        onSubmit={(event) => void onSignIn(event)}
        className="w-full max-w-sm space-y-3 text-start"
        noValidate
      >
        <div className="space-y-1.5">
          <Label htmlFor="selfhost-login">{t("auth.usernameOrEmail")}</Label>
          <Input
            id="selfhost-login"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={login}
            onChange={(event) => setLogin(event.target.value)}
          />
        </div>
        <PasswordField
          id="selfhost-password"
          label={t("auth.password")}
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
        />
        <FormMessages error={form.error} note={form.error ? null : notice} />
        <Button type="submit" className="w-full" disabled={form.busy}>
          {form.busy ? t("auth.signingIn") : t("auth.signIn")}
        </Button>
      </form>
      <Button variant="ghost" type="button" onClick={() => setMode("forgot")}>
        {t("auth.forgotPassword")}
      </Button>
      <p className="max-w-sm text-xs text-muted-foreground">{t("auth.inviteOnly")}</p>
    </AuthScreen>
  );
}

type InviteState =
  | { kind: "loading" }
  | { kind: "ready"; invite: InviteSummary }
  | { kind: "invalid" }
  | { kind: "error"; message: string };

function RegisterScreen({
  invite,
  onDone,
  onCancel,
}: {
  invite: string | null;
  onDone: (token: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useAuthForm();
  const [state, setState] = useState<InviteState>(
    invite === null ? { kind: "invalid" } : { kind: "loading" },
  );
  const [attempt, setAttempt] = useState(0);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  useEffect(() => {
    if (invite === null) return;
    let cancelled = false;
    inspectInvite({ invite })
      .then((summary) => {
        if (!cancelled) setState({ kind: "ready", invite: summary });
      })
      .catch((err) => {
        if (cancelled) return;
        const unusable = err instanceof ShareAccountError && err.code === "invite-invalid";
        setState(
          unusable ? { kind: "invalid" } : { kind: "error", message: authErrorText(t, err) },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [invite, attempt, t]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (invite === null) return;
    if (!USERNAME_PATTERN.test(username)) return form.fail(authCodeText(t, "username-invalid"));
    const problem = newPasswordProblem(password, { username });
    if (problem) return form.fail(authCodeText(t, problem));
    if (password !== confirm) return form.fail(authCodeText(t, "password-mismatch"));
    if (turnstileRequired() && !form.turnstile) return form.fail(t("auth.botCheckPending"));
    await form.run(
      async () =>
        onDone(
          await createAccount({
            username,
            password,
            invite,
            turnstileToken: form.turnstile ?? "",
          }),
        ),
      (err) => form.fail(authErrorText(t, err)),
    );
  };

  if (state.kind === "invalid") {
    return (
      <LinkProblem
        title={t("auth.register.invalidTitle")}
        description={t("auth.register.invalidDescription")}
        onContinue={onCancel}
      />
    );
  }
  if (state.kind === "loading") {
    return (
      <AuthScreen>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {t("auth.register.checking")}
        </p>
      </AuthScreen>
    );
  }
  if (state.kind === "error") {
    return (
      <AuthScreen>
        <AuthHeading title={t("auth.register.title")} />
        <FormMessages error={state.message} />
        <Button type="button" onClick={() => setAttempt((count) => count + 1)}>
          {t("auth.retry")}
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <AuthHeading title={t("auth.register.title")} description={t("auth.register.description")} />
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-sm space-y-3 text-start"
        noValidate
      >
        <div className="space-y-1.5">
          <Label htmlFor="register-email">{t("auth.email")}</Label>
          <Input id="register-email" value={state.invite.email} readOnly disabled />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="register-username">{t("auth.username")}</Label>
          <Input
            id="register-username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby="register-username-hint"
            value={username}
            onChange={(event) => setUsername(event.target.value.trim().toLowerCase())}
          />
          <p id="register-username-hint" className="text-xs text-muted-foreground">
            {t("auth.register.usernameHint")}
          </p>
        </div>
        <PasswordField
          id="register-password"
          label={t("auth.password")}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          describedBy="register-password-strength"
        />
        <PasswordStrength
          id="register-password-strength"
          password={password}
          context={{ username }}
        />
        <PasswordField
          id="register-confirm"
          label={t("auth.confirmPassword")}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
        />
        <PasswordMatch password={password} confirm={confirm} />
        <TurnstileWidget
          action={TURNSTILE_ACTIONS.register}
          onToken={form.setTurnstile}
          resetKey={form.turnstileReset}
        />
        <FormMessages error={form.error} />
        <Button type="submit" className="w-full" disabled={form.busy}>
          {form.busy ? t("auth.register.creating") : t("auth.register.submit")}
        </Button>
      </form>
    </AuthScreen>
  );
}

function ResetScreen({
  token,
  onDone,
  onCancel,
}: {
  token: string | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const form = useAuthForm();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  if (token === null) {
    return (
      <LinkProblem
        title={t("auth.reset.invalidTitle")}
        description={t("auth.reset.invalidDescription")}
        onContinue={onCancel}
      />
    );
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = newPasswordProblem(password);
    if (problem) return form.fail(authCodeText(t, problem));
    if (password !== confirm) return form.fail(authCodeText(t, "password-mismatch"));
    if (turnstileRequired() && !form.turnstile) return form.fail(t("auth.botCheckPending"));
    await form.run(
      async () => {
        await confirmPasswordReset({ token, password, turnstileToken: form.turnstile ?? "" });
        onDone();
      },
      (err) => form.fail(authErrorText(t, err)),
    );
  };

  return (
    <AuthScreen>
      <AuthHeading title={t("auth.reset.title")} description={t("auth.reset.description")} />
      <form
        onSubmit={(event) => void onSubmit(event)}
        className="w-full max-w-sm space-y-3 text-start"
        noValidate
      >
        {/* Lets a password manager file the new password under the right
            account. The reset link does not say which username that is. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          defaultValue=""
        />
        <PasswordField
          id="reset-password"
          label={t("auth.newPassword")}
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          describedBy="reset-password-strength"
        />
        <PasswordStrength id="reset-password-strength" password={password} />
        <PasswordField
          id="reset-confirm"
          label={t("auth.confirmPassword")}
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
        />
        <PasswordMatch password={password} confirm={confirm} />
        <TurnstileWidget
          action={TURNSTILE_ACTIONS.resetConfirm}
          onToken={form.setTurnstile}
          resetKey={form.turnstileReset}
        />
        <FormMessages error={form.error} />
        <Button type="submit" className="w-full" disabled={form.busy}>
          {t("auth.reset.submit")}
        </Button>
      </form>
      <Button variant="ghost" type="button" onClick={onCancel}>
        {t("auth.backToSignIn")}
      </Button>
    </AuthScreen>
  );
}

/**
 * Confirming takes a click, not just opening the link: mail scanners open
 * links, and one that did would otherwise change the address on its own.
 */
function VerifyEmailScreen({ token, onDone }: { token: string | null; onDone: () => void }) {
  const { t } = useTranslation();
  const form = useAuthForm();
  const [done, setDone] = useState(false);

  if (token === null) {
    return (
      <LinkProblem
        title={t("auth.verify.invalidTitle")}
        description={t("auth.verify.invalidDescription")}
        onContinue={onDone}
      />
    );
  }

  return (
    <AuthScreen>
      <AuthHeading
        title={t("auth.verify.title")}
        description={done ? t("auth.verify.done") : t("auth.verify.description")}
      />
      <FormMessages error={form.error} />
      {done ? (
        <Button type="button" onClick={onDone}>
          {t("auth.continue")}
        </Button>
      ) : (
        <Button
          type="button"
          disabled={form.busy}
          onClick={() =>
            void form.run(
              async () => {
                await confirmEmailChange({ token });
                setDone(true);
              },
              (err) => form.fail(authErrorText(t, err)),
            )
          }
        >
          {t("auth.verify.submit")}
        </Button>
      )}
    </AuthScreen>
  );
}

function LinkProblem({
  title,
  description,
  onContinue,
}: {
  title: string;
  description: string;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  return (
    <AuthScreen>
      <div role="alert">
        <AuthHeading title={title} description={description} />
      </div>
      <Button type="button" onClick={onContinue}>
        {t("auth.continue")}
      </Button>
    </AuthScreen>
  );
}

/** Account menu. Sign-out asks the server to revoke, then clears the saved token either way. */
function UserMenu({ token }: { token: string }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AccountView>("overview");
  const show = (next: AccountView) => {
    setView(next);
    setOpen(true);
  };

  useEffect(() => {
    let cancelled = false;
    // A 401 here is caught by the session watch, which signs the tab out.
    fetchAccount({ token })
      .then((info) => {
        if (!cancelled) setAccount(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);

  const reloadAccount = async () => setAccount(await fetchAccount({ token }));

  // The local token is cleared whether or not the revoke reached the server.
  // Someone pressing "Sign out" offline, or on a token the server already
  // dropped, must not stay signed in on this device; an unrevoked token still
  // dies at its idle timeout.
  const revoke = async () => {
    setBusy(true);
    try {
      await signOut({ token });
    } catch (err) {
      console.warn("sign-out could not reach the server; clearing the local session", err);
    } finally {
      writeShareToken("");
      setBusy(false);
    }
  };

  return (
    <div className="fixed end-2 top-2 z-[100]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("auth.account")}
            className="h-9 w-9 rounded-full bg-background p-0 shadow-sm"
          >
            {account ? (
              <AccountAvatar name={account.username} admin={account.isAdmin} size="sm" />
            ) : (
              <User className="h-4 w-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {account ? (
            <>
              <DropdownMenuLabel className="flex items-center gap-3 py-2 text-start font-normal">
                <AccountAvatar name={account.username} admin={account.isAdmin} />
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="block truncate text-sm font-semibold">
                    {account.username ?? "—"}
                  </span>
                  <RoleBadge admin={account.isAdmin} />
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={() => show("overview")}>
            <UserRound className="me-2 h-4 w-4" />
            {t("auth.security.menu")}
          </DropdownMenuItem>
          {account?.isAdmin ? (
            <DropdownMenuItem
              onSelect={() => show("invites")}
              className="text-amber-800 focus:bg-amber-500/10 focus:text-amber-900 dark:text-amber-200 dark:focus:text-amber-100"
            >
              <ShieldCheck className="me-2 h-4 w-4" />
              {t("auth.admin.menu")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={busy}
            onSelect={(event) => {
              event.preventDefault();
              void revoke();
            }}
          >
            <LogOut className="me-2 h-4 w-4" />
            {t("auth.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AccountCenter
        open={open}
        onOpenChange={setOpen}
        view={view}
        onViewChange={setView}
        token={token}
        account={account}
        onToken={writeShareToken}
        onAccountChange={reloadAccount}
      />
    </div>
  );
}
