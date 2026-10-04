import { Button, Input, Label } from "@geolibre/ui";
import { LogIn, LogOut, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "../../lib/is-tauri";
import {
  ShareAccountError,
  USERNAME_PATTERN,
  changePassword,
  completeMfaSignIn,
  createAccount,
  mfaCodeProblem,
  newPasswordProblem,
  signIn,
  signInProblem,
  signOut,
} from "../../lib/share-account";
import { TURNSTILE_ACTIONS } from "../../lib/turnstile";
import { authCodeText, authErrorText } from "../auth/auth-error-text";
import { MfaCodeField } from "../auth/MfaCodeField";
import { TurnstileWidget, turnstileRequired } from "../auth/TurnstileWidget";

interface ShareAccountFormProps {
  /** Called with a fresh token, to store in Settings. */
  onToken: (token: string) => void;
  /** Called only after the server has revoked the bearer. */
  onSignedOut: () => void;
  /** The current bearer, needed to revoke it and to change the password. */
  token: string;
  /** Whether a token is already present, so the form can say so. */
  hasToken: boolean;
}

/**
 * Create an account on this deployment's projects server, or sign in to one.
 *
 * Settings has always accepted a token and the API has always been able to
 * mint one, but nothing joined the two: the hosted service has a website to
 * sign up on, and a self-hosted deployment had nowhere at all. The result is a
 * deployment that appears to work and quietly persists nothing — layers added
 * from a file live in the store until the tab closes, projects cannot be saved
 * to the server, and uploads to the shared library are refused.
 *
 * It sits next to the token field rather than in a dialog of its own because
 * that is where someone looking for "how do I get a token" already is.
 *
 * The desktop app signs in here but does not register: registration carries a
 * Turnstile check, which cannot run from the app's origin, so the invite link
 * is opened in a browser instead.
 */
export function ShareAccountForm({ onToken, onSignedOut, token, hasToken }: ShareAccountFormProps) {
  const { t } = useTranslation();
  const desktop = isTauri();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [turnstile, setTurnstile] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);
  // Set once the password was right on an account with two-factor on.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [changeCode, setChangeCode] = useState("");

  const signedIn = (fresh: string) => {
    onToken(fresh);
    setPassword("");
    setTicket(null);
    setCode("");
    setNote(t("settings.env.accountSignedIn", { username: username.trim() }));
  };

  const verify = async () => {
    if (ticket === null) return;
    const problem = mfaCodeProblem(code);
    if (problem) return setError(authCodeText(t, problem));
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      signedIn(await completeMfaSignIn({ ticket, code }));
    } catch (err) {
      // A spent or expired ticket takes no more codes: back to the password.
      if (err instanceof ShareAccountError && err.code === "mfa-expired") setTicket(null);
      setCode("");
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const run = async (mode: "signIn" | "create") => {
    // Checked here as well as in the client so a typo does not spend one of the
    // attempts a minute the API's rate limiter allows. Sign-in has no length
    // floor: older accounts have passwords shorter than today's minimum.
    if (mode === "signIn") {
      const problem = signInProblem(username, password);
      if (problem) return setError(authCodeText(t, problem));
    } else {
      if (!USERNAME_PATTERN.test(username)) return setError(authCodeText(t, "username-invalid"));
      const problem = newPasswordProblem(password, { username });
      if (problem) return setError(authCodeText(t, problem));
      if (turnstileRequired() && !turnstile) return setError(t("auth.botCheckPending"));
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (mode === "create") {
        signedIn(
          await createAccount({ username, password, invite, turnstileToken: turnstile ?? "" }),
        );
      } else {
        const result = await signIn({ username, password });
        if (result.kind === "token") {
          signedIn(result.token);
        } else {
          setPassword("");
          setTicket(result.ticket);
          setNote(t("settings.env.accountMfaPrompt"));
        }
      }
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
      if (mode === "create") setTurnstileReset((count) => count + 1);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      // Server first. onSignedOut clears the saved token, and it must not run
      // if the revoke failed — see signOut.
      await signOut({ token });
      onSignedOut();
      setNote(t("settings.env.accountSignedOut"));
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const change = async () => {
    const problem = newPasswordProblem(nextPassword, { username });
    if (problem !== null) {
      setError(authCodeText(t, problem));
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const fresh = await changePassword({
        token,
        currentPassword,
        password: nextPassword,
        code: changeCode,
      });
      onToken(fresh);
      setCurrentPassword("");
      setNextPassword("");
      setChangeCode("");
      setNote(t("settings.env.accountPasswordChanged"));
    } catch (err) {
      setError(authErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const messages = (
    <>
      <div aria-live="assertive" aria-atomic="true">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <div aria-live="polite" aria-atomic="true">
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      </div>
    </>
  );

  if (!open) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
            <LogIn className="me-2 h-3.5 w-3.5" />
            {hasToken ? t("settings.env.accountSwitch") : t("settings.env.accountOpen")}
          </Button>
          {hasToken ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void revoke()}
            >
              <LogOut className="me-2 h-3.5 w-3.5" />
              {t("settings.env.accountSignOut")}
            </Button>
          ) : null}
        </div>
        {messages}
      </div>
    );
  }

  if (ticket !== null) {
    return (
      <form
        className="space-y-2 rounded-md border p-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void verify();
        }}
      >
        <MfaCodeField id="share-account-mfa-code" value={code} onChange={setCode} autoFocus />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {t("auth.mfa.verify")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setTicket(null);
              setCode("");
              setNote(null);
            }}
          >
            {t("auth.backToSignIn")}
          </Button>
        </div>
        {messages}
      </form>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{t("settings.env.accountHelp")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="share-account-username">{t("settings.env.accountUsernameOrEmail")}</Label>
        <Input
          id="share-account-username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value.trim().toLowerCase())}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="share-account-password">{t("settings.env.accountPassword")}</Label>
        <Input
          id="share-account-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>
      {desktop ? (
        <p className="text-xs text-muted-foreground">{t("settings.env.accountCreateInBrowser")}</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="share-account-invite">{t("settings.env.accountInvite")}</Label>
            <Input
              id="share-account-invite"
              autoComplete="off"
              placeholder={t("settings.env.accountInvitePlaceholder")}
              value={invite}
              onChange={(event) => setInvite(event.target.value.trim())}
            />
          </div>
          {invite ? (
            <TurnstileWidget
              action={TURNSTILE_ACTIONS.register}
              onToken={setTurnstile}
              resetKey={turnstileReset}
            />
          ) : null}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void run("signIn")}>
          <LogIn className="me-2 h-3.5 w-3.5" />
          {t("settings.env.accountSignIn")}
        </Button>
        {desktop ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void run("create")}
          >
            <UserPlus className="me-2 h-3.5 w-3.5" />
            {t("settings.env.accountCreate")}
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("settings.env.accountClose")}
        </Button>
        {hasToken ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void revoke()}
          >
            <LogOut className="me-2 h-3.5 w-3.5" />
            {t("settings.env.accountSignOut")}
          </Button>
        ) : null}
      </div>
      {hasToken ? (
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">{t("settings.env.accountPasswordHelp")}</p>
          <div className="space-y-1.5">
            <Label htmlFor="share-account-current">
              {t("settings.env.accountCurrentPassword")}
            </Label>
            <Input
              id="share-account-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="share-account-next">{t("settings.env.accountNewPassword")}</Label>
            <Input
              id="share-account-next"
              type="password"
              autoComplete="new-password"
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
            />
          </div>
          <MfaCodeField
            id="share-account-change-code"
            label={t("settings.env.accountMfaCodeOptional")}
            value={changeCode}
            onChange={setChangeCode}
          />
          <Button type="button" size="sm" disabled={busy} onClick={() => void change()}>
            {t("settings.env.accountChangePassword")}
          </Button>
        </div>
      ) : null}
      {messages}
    </div>
  );
}
