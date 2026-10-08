/**
 * The signed-in account menu for this deployment's own gate.
 *
 * The toolbar is deep inside the app, and the gate wraps the app, so a small
 * context is the link: the gate owns the account, the open Account Center and
 * the sign-out flag, and the toolbar renders the trigger while it is mounted.
 * A context (rather than a portal) lets the toolbar register itself, so the
 * gate can drop the floating fallback and never show both. State stays here,
 * so hiding the toolbar does not close an open Account Center.
 *
 * Auth0, Clerk and the desktop build without this gate never provide the
 * context, and the toolbar slot renders nothing.
 */
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@geolibre/ui";
import { ChevronDown, LogOut, ShieldCheck, User, UserRound } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useDesktopSettingsStore } from "../../hooks/useDesktopSettings";
import {
  accountAttentionKind,
  accountAttentionView,
  accountTriggerLabel,
  type AccountAttentionKind,
} from "../../lib/account-menu";
import { fetchAccount, signOut, type AccountInfo } from "../../lib/share-account";
import { AccountCenter, type AccountView } from "./AccountCenter";
import { AccountAvatar, RoleBadge } from "./account-badges";

interface AccountMenuContextValue {
  setHosted: (hosted: boolean) => void;
  account: AccountInfo | null;
  busy: boolean;
  show: (view: AccountView) => void;
  revoke: () => void;
}

const AccountMenuContext = createContext<AccountMenuContextValue | null>(null);

const ATTENTION_KEYS: Record<
  AccountAttentionKind,
  "auth.menu.attentionMfa" | "auth.menu.attentionEmail"
> = {
  mfa: "auth.menu.attentionMfa",
  email: "auth.menu.attentionEmail",
};

function writeShareToken(shareToken: string): void {
  const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
  setDesktopSettings({ ...desktopSettings, shareToken });
}

export function SelfHostAccountFrame({ token, children }: { token: string; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<AccountView>("overview");
  const [hosted, setHostedState] = useState(false);
  const setHosted = useCallback((next: boolean) => setHostedState(next), []);
  const show = useCallback((next: AccountView) => {
    setView(next);
    setOpen(true);
  }, []);

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
  const revoke = useCallback(async () => {
    setBusy(true);
    try {
      await signOut({ token });
    } catch (err) {
      console.warn("sign-out could not reach the server; clearing the local session", err);
    } finally {
      writeShareToken("");
      setBusy(false);
    }
  }, [token]);

  return (
    <AccountMenuContext.Provider value={{ setHosted, account, busy, show, revoke }}>
      {children}
      {hosted ? null : (
        // Built-in map controls occupy the top-end corner, so the fallback
        // sits at the top-start and stays under dialogs (the old z-100 button
        // floated over them).
        <div className="fixed start-3 top-3 z-30">
          <AccountMenuTrigger floating />
        </div>
      )}
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
    </AccountMenuContext.Provider>
  );
}

/** Last item of the toolbar. Renders nothing when this deployment has no gate. */
export function AccountMenuToolbarItem() {
  const menu = useContext(AccountMenuContext);
  const setHosted = menu?.setHosted;
  // Depend on the setter, not the whole value: the value is a new object on
  // every account update, and re-running this would clear `hosted` and loop.
  useLayoutEffect(() => {
    if (!setHosted) return;
    setHosted(true);
    return () => setHosted(false);
  }, [setHosted]);
  if (!menu) return null;
  return (
    <div className="ms-1 flex items-center border-s border-border ps-1.5">
      <AccountMenuTrigger />
    </div>
  );
}

function AccountMenuTrigger({ floating = false }: { floating?: boolean }) {
  const menu = useContext(AccountMenuContext);
  const { t } = useTranslation();
  if (!menu) return null;
  const { account, busy, show, revoke } = menu;
  const attention = accountAttentionKind(account);
  const attentionText = attention ? t(ATTENTION_KEYS[attention]) : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          aria-label={accountTriggerLabel(account, {
            account: t("auth.account"),
            attention: attentionText,
          })}
          className={
            floating
              ? "h-7 gap-1.5 rounded-md border bg-card px-1.5 shadow-sm"
              : "h-7 gap-1.5 rounded-md px-1.5"
          }
        >
          {account ? (
            <span className="relative inline-flex">
              <AccountAvatar name={account.username} admin={account.isAdmin} size="xs" />
              {attention ? (
                <span
                  aria-hidden
                  className="absolute -end-0.5 -top-0.5 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-card"
                />
              ) : null}
            </span>
          ) : (
            <User className="h-3.5 w-3.5" />
          )}
          {account?.username ? (
            <span className="hidden max-w-32 truncate text-xs md:inline">{account.username}</span>
          ) : null}
          <ChevronDown className="hidden h-3.5 w-3.5 text-muted-foreground md:inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="w-64">
        {account ? (
          <>
            <DropdownMenuLabel className="flex items-center gap-3 py-2 text-start font-normal">
              <AccountAvatar name={account.username} admin={account.isAdmin} />
              <span className="min-w-0 flex-1 space-y-1">
                <span className="block truncate text-sm font-semibold">
                  {account.username ?? "—"}
                </span>
                {account.email ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {account.email}
                  </span>
                ) : null}
                <RoleBadge admin={account.isAdmin} />
              </span>
            </DropdownMenuLabel>
            {attention ? (
              <DropdownMenuItem
                className="text-xs text-muted-foreground"
                onSelect={() => show(accountAttentionView(attention))}
              >
                {attentionText}
              </DropdownMenuItem>
            ) : null}
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
  );
}
