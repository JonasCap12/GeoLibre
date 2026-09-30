import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
} from "@geolibre/ui";
import { LogOut, User } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBeforeUnloadGuard } from "../../hooks/useBeforeUnloadGuard";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import {
  requestPasswordReset,
  signIn,
  signOut,
  validateCredentials,
} from "../../lib/share-account";

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
 * Registration is invite-only, so this page has no create-account button. A
 * person without an invite uses the link in the invite email, or Settings on
 * an ungated build.
 */
export function SelfHostGate({ children }: { children: ReactNode }) {
  // Same reason as Auth0Gate: App unmounts when the session ends, and the
  // project state survives in the module store, so the tab could otherwise
  // close with unsaved changes and no prompt.
  useBeforeUnloadGuard();
  const token = useDesktopSettingsStore((state) => state.desktopSettings.shareToken.trim());
  if (!token) return <SignInScreen />;
  return (
    <>
      {children}
      <UserMenu token={token} />
    </>
  );
}

/** Full-screen centered layout, matching Auth0Gate's signed-out screens. */
function AuthScreen({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <main
      {...(alert ? { role: "alert" } : {})}
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center"
    >
      {children}
    </main>
  );
}

function writeShareToken(shareToken: string): void {
  const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({ ...desktopSettings, shareToken });
}

function SignInScreen() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"sign-in" | "reset">("sign-in");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const onSignIn = async (event: FormEvent) => {
    event.preventDefault();
    // Checked before the request so a typo does not spend one of the ten
    // attempts a minute the auth limiter allows.
    const problem = validateCredentials(username, password);
    if (problem) {
      setError(problem);
      setNote(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const fresh = await signIn({ username, password });
      writeShareToken(fresh);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onReset = async (event: FormEvent) => {
    event.preventDefault();
    if (email.trim() === "" || !email.includes("@")) {
      setError(t("auth.emailInvalid"));
      setNote(null);
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await requestPasswordReset({ email });
      setNote(t("auth.resetRequested"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (mode === "reset") {
    return (
      <AuthScreen alert={error !== null}>
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">{t("auth.forgotPasswordTitle")}</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("auth.forgotPasswordDescription")}
          </p>
        </div>
        <form
          onSubmit={(event) => void onReset(event)}
          className="w-full max-w-sm space-y-3 text-start"
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
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {t("auth.sendResetLink")}
          </Button>
        </form>
        <Button
          variant="ghost"
          type="button"
          onClick={() => {
            setMode("sign-in");
            setError(null);
            setNote(null);
          }}
        >
          {t("auth.backToSignIn")}
        </Button>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen alert={error !== null}>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">{t("auth.signInTitle")}</h1>
        <p className="max-w-md text-sm text-muted-foreground">{t("auth.selfHostDescription")}</p>
      </div>
      <form
        onSubmit={(event) => void onSignIn(event)}
        className="w-full max-w-sm space-y-3 text-start"
      >
        <div className="space-y-1.5">
          <Label htmlFor="selfhost-username">{t("settings.env.accountUsername")}</Label>
          <Input
            id="selfhost-username"
            autoComplete="username"
            placeholder={t("settings.env.accountUsernamePlaceholder")}
            value={username}
            onChange={(event) => setUsername(event.target.value.trim().toLowerCase())}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="selfhost-password">{t("settings.env.accountPassword")}</Label>
          <Input
            id="selfhost-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? t("auth.signingIn") : t("auth.signIn")}
        </Button>
      </form>
      <Button
        variant="ghost"
        type="button"
        onClick={() => {
          setMode("reset");
          setError(null);
        }}
      >
        {t("auth.forgotPassword")}
      </Button>
    </AuthScreen>
  );
}

/** Sign-out. The server revoke runs before the saved token is cleared. */
function UserMenu({ token }: { token: string }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      await signOut({ token });
      writeShareToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
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
            className="h-8 w-8 overflow-hidden rounded-full border border-border bg-background p-0 shadow-sm"
          >
            <User className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {error ? (
            <p className="px-2 py-1.5 text-start text-xs text-destructive">{error}</p>
          ) : null}
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
    </div>
  );
}
