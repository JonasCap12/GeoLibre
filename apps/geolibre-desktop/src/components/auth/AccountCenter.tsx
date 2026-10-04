import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@geolibre/ui";
import {
  BadgeCheck,
  ChevronRight,
  CircleAlert,
  KeyRound,
  LayoutDashboard,
  Lock,
  Mail,
  MailPlus,
  MonitorSmartphone,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listSessions, type AccountInfo } from "../../lib/share-account";
import { AccountAvatar, RoleBadge } from "./account-badges";
import {
  EmailSection,
  MfaSection,
  PasswordSection,
  SessionsSection,
} from "./AccountSecurityDialog";
import { AccountsTab, ActivityTab, InvitesTab } from "./AdminDialog";

/**
 * One place for everything about the signed-in account: an overview, security,
 * email and devices for everyone, plus an Administration group for admins.
 *
 * The admin group is the visible difference between the two roles. It is drawn
 * only when the server says the account is an admin (AccountInfo.isAdmin), and
 * every route behind it checks again, so hiding it is presentation, not access
 * control.
 */

export type AccountView =
  | "overview"
  | "security"
  | "email"
  | "sessions"
  | "invites"
  | "members"
  | "activity";

const PERSONAL_NAV = [
  { id: "overview", labelKey: "auth.center.nav.overview", icon: LayoutDashboard },
  { id: "security", labelKey: "auth.center.nav.security", icon: ShieldCheck },
  { id: "email", labelKey: "auth.center.nav.email", icon: Mail },
  { id: "sessions", labelKey: "auth.center.nav.sessions", icon: MonitorSmartphone },
] as const;

const ADMIN_NAV = [
  { id: "invites", labelKey: "auth.admin.invites", icon: MailPlus },
  { id: "members", labelKey: "auth.admin.accounts", icon: Users },
  { id: "activity", labelKey: "auth.admin.activity", icon: ScrollText },
] as const;

const VIEW_DESCRIPTIONS = {
  overview: "auth.center.description.overview",
  security: "auth.center.description.security",
  email: "auth.center.description.email",
  sessions: "auth.center.description.sessions",
  invites: "auth.center.description.invites",
  members: "auth.center.description.members",
  activity: "auth.center.description.activity",
} as const;

const ADMIN_VIEWS: ReadonlySet<AccountView> = new Set(["invites", "members", "activity"]);

interface AccountCenterProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: AccountView;
  onViewChange: (view: AccountView) => void;
  token: string;
  account: AccountInfo | null;
  /** Stores a replacement bearer, or "" once this session has ended. */
  onToken: (token: string) => void;
  /** Reloads `account` after a change made here (two-factor on or off). */
  onAccountChange: () => Promise<void>;
}

export function AccountCenter({
  open,
  onOpenChange,
  view,
  onViewChange,
  token,
  account,
  onToken,
  onAccountChange,
}: AccountCenterProps) {
  const { t } = useTranslation();
  const admin = account?.isAdmin === true;
  // A non-admin can only land on an admin view through a stale state; show
  // the overview rather than an empty pane.
  const current: AccountView = !admin && ADMIN_VIEWS.has(view) ? "overview" : view;
  const adminView = ADMIN_VIEWS.has(current);
  const label = [...PERSONAL_NAV, ...ADMIN_NAV].find((item) => item.id === current)!.labelKey;
  const body = useRef<HTMLElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-4xl"
        bodyClassName="p-0"
        // Focus the pane, not the first nav button: a focus ring parked on
        // "Overview" reads as the selected item while another one is open.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          body.current?.focus();
        }}
      >
        {/* min-w-0: the dialog body is a grid, and without it the scrolling
            tab row on a phone would widen the whole dialog past the screen. */}
        <div className="flex h-[min(44rem,calc(100dvh-1rem))] min-h-0 min-w-0 flex-col md:flex-row">
          <aside className="flex min-w-0 shrink-0 flex-col gap-3 border-b bg-muted/30 p-3 md:w-60 md:border-b-0 md:border-e md:p-4">
            <div className="flex items-center gap-3 pe-8 md:pe-0">
              <AccountAvatar name={account?.username} admin={admin} />
              <div className="min-w-0 space-y-1 text-start">
                <DialogTitle className="truncate text-sm leading-tight">
                  {account?.username ?? t("auth.center.title")}
                </DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {account?.email ?? t("auth.center.noEmail")}
                </DialogDescription>
              </div>
            </div>
            <div className="hidden md:block">
              <RoleBadge admin={admin} />
            </div>
            <nav
              aria-label={t("auth.center.nav.label")}
              className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0"
            >
              <NavGroupLabel>{t("auth.center.nav.personal")}</NavGroupLabel>
              {PERSONAL_NAV.map((item) => (
                <NavButton
                  key={item.id}
                  icon={item.icon}
                  label={t(item.labelKey)}
                  active={current === item.id}
                  onClick={() => onViewChange(item.id)}
                />
              ))}
              {admin ? (
                <>
                  <div className="hidden md:mt-3 md:block md:border-t md:pt-3" />
                  <NavGroupLabel admin>{t("auth.center.nav.admin")}</NavGroupLabel>
                  {ADMIN_NAV.map((item) => (
                    <NavButton
                      key={item.id}
                      icon={item.icon}
                      label={t(item.labelKey)}
                      active={current === item.id}
                      admin
                      locked={!account?.mfaEnabled}
                      onClick={() => onViewChange(item.id)}
                    />
                  ))}
                </>
              ) : null}
            </nav>
          </aside>

          <section
            ref={body}
            tabIndex={-1}
            className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 outline-none sm:p-6"
          >
            <header className="mb-4 space-y-1 pe-8 text-start">
              <h2 className="text-lg font-semibold leading-tight">{t(label)}</h2>
              <p className="text-sm text-muted-foreground">{t(VIEW_DESCRIPTIONS[current])}</p>
            </header>
            {adminView ? (
              <p className="mb-4 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
                {t("auth.center.adminArea")}
              </p>
            ) : null}
            {open ? (
              <ViewBody
                view={current}
                token={token}
                account={account}
                onToken={onToken}
                onAccountChange={onAccountChange}
                onViewChange={onViewChange}
              />
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NavGroupLabel({ children, admin = false }: { children: string; admin?: boolean }) {
  return (
    <p
      className={`hidden px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide md:block ${
        admin ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"
      }`}
    >
      {children}
    </p>
  );
}

function NavButton({
  icon: Icon,
  label,
  active,
  admin = false,
  locked = false,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  active: boolean;
  admin?: boolean;
  locked?: boolean;
  onClick: () => void;
}) {
  const tone = active
    ? admin
      ? "bg-amber-500/15 font-medium text-amber-800 dark:text-amber-200"
      : "bg-background font-medium text-foreground shadow-sm"
    : admin
      ? "text-amber-800/80 hover:bg-amber-500/10 dark:text-amber-200/80"
      : "text-muted-foreground hover:bg-background/60 hover:text-foreground";
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-start text-sm transition-colors ${tone}`}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      <span className="flex-1">{label}</span>
      {locked ? <Lock className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden /> : null}
    </button>
  );
}

function ViewBody({
  view,
  token,
  account,
  onToken,
  onAccountChange,
  onViewChange,
}: {
  view: AccountView;
  token: string;
  account: AccountInfo | null;
  onToken: (token: string) => void;
  onAccountChange: () => Promise<void>;
  onViewChange: (view: AccountView) => void;
}) {
  switch (view) {
    case "overview":
      return <Overview token={token} account={account} onViewChange={onViewChange} />;
    case "security":
      return (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          <MfaSection token={token} account={account} onAccountChange={onAccountChange} />
          <PasswordSection token={token} account={account} onToken={onToken} />
        </div>
      );
    case "email":
      return (
        <div className="max-w-lg">
          <EmailSection token={token} account={account} />
        </div>
      );
    case "sessions":
      return <SessionsSection token={token} onToken={onToken} />;
    default:
      // Admin views. The server answers every admin route with 403 until the
      // admin has a second factor, so say that once instead of three times.
      if (account === null) return null;
      if (!account.mfaEnabled) return <AdminLocked onViewChange={onViewChange} />;
      if (view === "invites") return <InvitesTab token={token} />;
      if (view === "members") return <AccountsTab token={token} self={account} />;
      return <ActivityTab token={token} />;
  }
}

function AdminLocked({ onViewChange }: { onViewChange: (view: AccountView) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-5 text-start">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300">
        <ShieldAlert className="h-5 w-5" aria-hidden />
      </span>
      <p className="text-sm">{t("auth.center.adminTools.locked")}</p>
      <Button type="button" size="sm" onClick={() => onViewChange("security")}>
        {t("auth.center.adminTools.unlock")}
      </Button>
    </div>
  );
}

type Tone = "ok" | "warn" | "neutral";

const TONE_CLASSES: Record<Tone, string> = {
  ok: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  neutral: "bg-muted text-muted-foreground",
};

function StatCard({
  icon: Icon,
  title,
  value,
  tone,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  tone: Tone;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border bg-card p-3 text-start shadow-sm transition-colors hover:bg-accent"
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${TONE_CLASSES[tone]}`}
      >
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-muted-foreground">{title}</span>
        <span className="block truncate text-sm font-medium">{value}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-180" aria-hidden />
    </button>
  );
}

function Overview({
  token,
  account,
  onViewChange,
}: {
  token: string;
  account: AccountInfo | null;
  onViewChange: (view: AccountView) => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    listSessions({ token })
      .then((list) => {
        if (!cancelled) setSessions(list.length);
      })
      .catch(() => {
        // The card then shows "—"; the Devices view reports the error itself.
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (account === null) {
    return <p className="text-sm text-muted-foreground">{t("auth.loading")}</p>;
  }
  const admin = account.isAdmin;
  const verified = account.email !== null && account.emailVerifiedAt !== null;

  return (
    <div className="space-y-4">
      <div
        className={`flex flex-wrap items-center gap-4 rounded-xl border bg-gradient-to-br p-5 ${
          admin
            ? "border-amber-500/30 from-amber-500/10 to-transparent"
            : "from-primary/10 to-transparent"
        }`}
      >
        <AccountAvatar name={account.username} admin={admin} size="lg" />
        <div className="min-w-0 flex-1 space-y-1 text-start">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-lg font-semibold">{account.username ?? "—"}</p>
            <RoleBadge admin={admin} />
          </div>
          <p className="truncate text-sm text-muted-foreground">
            {account.email ?? t("auth.center.noEmail")}
          </p>
          <p className="text-xs text-muted-foreground">
            {admin ? t("auth.center.hero.admin") : t("auth.center.hero.member")}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          icon={verified ? BadgeCheck : CircleAlert}
          title={t("auth.center.stat.email")}
          value={
            verified ? t("auth.center.stat.emailVerified") : t("auth.center.stat.emailMissing")
          }
          tone={verified ? "ok" : "warn"}
          onClick={() => onViewChange("email")}
        />
        <StatCard
          icon={account.mfaEnabled ? ShieldCheck : ShieldAlert}
          title={t("auth.center.stat.mfa")}
          value={account.mfaEnabled ? t("auth.center.stat.mfaOn") : t("auth.center.stat.mfaOff")}
          tone={account.mfaEnabled ? "ok" : "warn"}
          onClick={() => onViewChange("security")}
        />
        {account.mfaEnabled ? (
          <StatCard
            icon={KeyRound}
            title={t("auth.center.stat.recovery")}
            value={t("auth.center.stat.recoveryLeft", { count: account.recoveryCodesLeft })}
            tone={account.recoveryCodesLeft < 3 ? "warn" : "neutral"}
            onClick={() => onViewChange("security")}
          />
        ) : null}
        <StatCard
          icon={MonitorSmartphone}
          title={t("auth.center.stat.sessions")}
          value={
            sessions === null ? "—" : t("auth.center.stat.sessionsActive", { count: sessions })
          }
          tone="neutral"
          onClick={() => onViewChange("sessions")}
        />
      </div>

      {admin ? (
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-start">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />
            <h3 className="text-sm font-semibold">{t("auth.center.adminTools.title")}</h3>
          </div>
          {account.mfaEnabled ? null : (
            <p className="text-xs text-amber-800 dark:text-amber-200">
              {t("auth.center.adminTools.locked")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {ADMIN_NAV.map((item) => (
              <Button
                key={item.id}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => onViewChange(item.id)}
              >
                <item.icon className="me-1.5 h-4 w-4" aria-hidden />
                {t(item.labelKey)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
