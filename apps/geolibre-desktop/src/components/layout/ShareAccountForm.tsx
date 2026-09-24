import { Button, Input, Label } from "@geolibre/ui";
import { LogIn, UserPlus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createAccount, signIn, validateCredentials } from "../../lib/share-account";

interface ShareAccountFormProps {
  /** Called with a fresh token, to store in Settings. */
  onToken: (token: string) => void;
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
 */
export function ShareAccountForm({ onToken, hasToken }: ShareAccountFormProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (mode: "signIn" | "create") => {
    // Checked here as well as in the client so a typo does not spend one of the
    // ten attempts a minute the API's rate limiter allows.
    const problem = validateCredentials(username, password);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const token = await (mode === "create" ? createAccount : signIn)({ username, password });
      onToken(token);
      setPassword("");
      setNote(t("settings.env.accountSignedIn", { username }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <LogIn className="me-2 h-3.5 w-3.5" />
        {hasToken ? t("settings.env.accountSwitch") : t("settings.env.accountOpen")}
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{t("settings.env.accountHelp")}</p>
      <div className="space-y-1.5">
        <Label htmlFor="share-account-username">{t("settings.env.accountUsername")}</Label>
        <Input
          id="share-account-username"
          autoComplete="username"
          placeholder={t("settings.env.accountUsernamePlaceholder")}
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
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void run("signIn")}>
          <LogIn className="me-2 h-3.5 w-3.5" />
          {t("settings.env.accountSignIn")}
        </Button>
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
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t("settings.env.accountClose")}
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
