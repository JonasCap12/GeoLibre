import { ShieldCheck, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * One or two letters for the avatar: the first letter of each of the first
 * two name parts (`nguyen-minh` → "NM"), or the first two letters of a
 * single-part name (`nhut` → "NH").
 */
export function accountInitials(name: string | null | undefined): string {
  const parts = (name ?? "").split(/[^\p{L}\p{N}]+/u).filter((part) => part !== "");
  if (parts.length === 0) return "?";
  const letters =
    parts.length === 1 ? Array.from(parts[0]).slice(0, 2) : [parts[0][0], parts[1][0]];
  return letters.join("").toUpperCase();
}

const AVATAR_SIZES = {
  xs: "h-5 w-5 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-lg",
} as const;

const AVATAR_BADGES = {
  xs: "h-3 w-3",
  sm: "h-4 w-4",
  md: "h-4 w-4",
  lg: "h-5 w-5",
} as const;

/**
 * Initials in a circle. An admin's carries an amber ring and a shield, so the
 * role is visible wherever the avatar is, including the toolbar button.
 */
export function AccountAvatar({
  name,
  admin,
  size = "md",
}: {
  name: string | null | undefined;
  admin: boolean;
  size?: keyof typeof AVATAR_SIZES;
}) {
  return (
    <span className="relative inline-flex shrink-0">
      <span
        aria-hidden
        className={`inline-flex items-center justify-center rounded-full font-semibold ${
          AVATAR_SIZES[size]
        } ${
          admin
            ? "bg-amber-500/15 text-amber-700 ring-2 ring-amber-500/70 dark:text-amber-300"
            : "bg-primary/10 text-primary"
        }`}
      >
        {accountInitials(name)}
      </span>
      {admin ? (
        <span
          className={`absolute -bottom-0.5 -end-0.5 flex items-center justify-center rounded-full bg-amber-500 text-white ring-2 ring-background ${AVATAR_BADGES[size]}`}
        >
          <ShieldCheck className={size === "xs" ? "h-2 w-2" : "h-2.5 w-2.5"} aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

/** "Administrator" in amber, or "Member" in the neutral tone. */
export function RoleBadge({ admin }: { admin: boolean }) {
  const { t } = useTranslation();
  const Icon = admin ? ShieldCheck : UserRound;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
        admin
          ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "bg-muted text-muted-foreground"
      }`}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {admin ? t("auth.center.role.admin") : t("auth.center.role.member")}
    </span>
  );
}
