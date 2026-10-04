import type { CollaborationMode, CollaborationParticipant } from "@geolibre/core";
import { Eye, MonitorPlay, Pencil, Presentation, UserX, Ban } from "lucide-react";
import { useTranslation } from "react-i18next";
import { participantCanEdit } from "../../lib/collab-protocol";

interface CollaborationParticipantRowProps {
  participant: CollaborationParticipant;
  /** Current session mode, used to derive effective edit permission. */
  mode: CollaborationMode;
  /** True when this row is the local user (adds a "(you)" tag). */
  isSelf: boolean;
  /** True when the viewer is the host and may change this participant's
   *  permission. A toggle button replaces the read-only indicator. The host's
   *  own row never shows a control. */
  canManage: boolean;
  onSetParticipantMode: (clientId: string, canEdit: boolean) => void;
  onKickParticipant?: (clientId: string) => void;
  onBlockParticipant?: (clientId: string) => void;
  /** True when the local camera is following this participant. */
  following?: boolean;
  /** True when this participant has published a camera at least once. */
  hasView?: boolean;
  /** Follow this person, or pass null to stop. Omitted hides the control. */
  onFollow?: (clientId: string | null) => void;
  /** True when this participant is the session's presenter. */
  presenting?: boolean;
  /** Claim or release presenting. Shown only on the local user's row. */
  onPresent?: (active: boolean) => void;
  /** Render the smaller variant used in the on-canvas badge roster. */
  compact?: boolean;
}

/**
 * One participant row shared by the Collaborate dialog roster and the on-canvas
 * status-badge roster (#754): color swatch, name, "you" / host tags, and either
 * a host-only per-participant permission toggle or a read-only permission
 * indicator. `compact` selects the badge's tighter sizing.
 */
export function CollaborationParticipantRow({
  participant: p,
  mode,
  isSelf,
  canManage,
  onSetParticipantMode,
  onKickParticipant,
  onBlockParticipant,
  following = false,
  hasView = false,
  onFollow,
  presenting = false,
  onPresent,
  compact = false,
}: CollaborationParticipantRowProps) {
  const { t } = useTranslation();
  const editable = participantCanEdit(p, mode);
  const isHostRow = p.role === "host";
  // The host can pin any guest (never themselves) to view-only / edit.
  const showToggle = canManage && !isHostRow;
  const permIcon = editable ? (
    <Pencil className="h-3 w-3" aria-hidden="true" />
  ) : (
    <Eye className="h-3 w-3" aria-hidden="true" />
  );
  const permLabel = editable ? t("collaborate.canEdit") : t("collaborate.viewOnly");
  const followLabel = hasView
    ? t("collaborate.followScreen", { name: p.displayName })
    : t("collaborate.followWhenMoves", { name: p.displayName });
  const followButtonLabel = following ? t("collaborate.stopFollowing") : followLabel;

  return (
    <li
      className={`flex items-center gap-2 rounded-sm ${following ? "border px-1 py-0.5" : ""} ${compact ? "text-xs" : "text-sm"}`}
      style={
        following
          ? {
              borderColor: p.color,
              backgroundColor: `color-mix(in srgb, ${p.color} 14%, transparent)`,
            }
          : undefined
      }
    >
      <span
        className={`${compact ? "h-2.5 w-2.5" : "h-3 w-3"} shrink-0 rounded-full`}
        style={{ backgroundColor: p.color }}
      />
      <span className="truncate">{p.displayName}</span>
      {p.identity && (
        <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">
          {p.identity.provider === "geolibre" ? "✓" : p.identity.provider}
        </span>
      )}
      {isSelf && <span className="text-xs text-muted-foreground">({t("collaborate.you")})</span>}
      {isHostRow && (
        <span
          className={`rounded bg-muted py-0.5 ${compact ? "px-1 text-[10px]" : "px-1.5 text-xs"}`}
        >
          {t("collaborate.host")}
        </span>
      )}
      {!isSelf && onFollow && (
        <button
          type="button"
          aria-pressed={following}
          aria-label={followButtonLabel}
          title={followButtonLabel}
          onClick={() => onFollow(following ? null : p.clientId)}
          className="shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
          style={following ? { color: p.color } : undefined}
        >
          <MonitorPlay className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
        </button>
      )}
      {following && !compact && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("collaborate.following")}
        </span>
      )}
      {isSelf && onPresent && (
        <button
          type="button"
          aria-pressed={presenting}
          aria-label={
            presenting ? t("collaborate.stopPresenting") : t("collaborate.presentToEveryone")
          }
          title={presenting ? t("collaborate.stopPresenting") : t("collaborate.presentToEveryone")}
          onClick={() => onPresent(!presenting)}
          className={`shrink-0 rounded p-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground ${compact ? "" : "flex items-center gap-1 px-1 text-xs"}`}
        >
          <Presentation className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden="true" />
          {!compact && (
            <span>
              {presenting ? t("collaborate.stopPresenting") : t("collaborate.presentToEveryone")}
            </span>
          )}
        </button>
      )}
      {presenting && (
        <span
          className={`shrink-0 rounded bg-muted py-0.5 text-muted-foreground ${compact ? "px-1 text-[10px]" : "px-1.5 text-xs"}`}
        >
          {t("collaborate.presenting")}
        </span>
      )}
      {!isHostRow &&
        (showToggle ? (
          <div className="ms-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onSetParticipantMode(p.clientId, !editable)}
              role="switch"
              aria-checked={editable}
              title={editable ? t("collaborate.setViewOnly") : t("collaborate.allowEdit")}
              className={`flex items-center gap-1 rounded border py-0.5 text-muted-foreground transition hover:bg-accent hover:text-foreground ${compact ? "px-1 text-[10px]" : "px-1.5 text-xs"}`}
            >
              {permIcon}
              {permLabel}
            </button>
            {canManage && !compact && (
              <>
                {onKickParticipant && (
                  <button
                    type="button"
                    onClick={() => onKickParticipant(p.clientId)}
                    title={(t as (key: string) => string)("collaborate.kick")}
                    aria-label={(t as (key: string) => string)("collaborate.kick")}
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <UserX className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
                {onBlockParticipant && (
                  <button
                    type="button"
                    onClick={() => onBlockParticipant(p.clientId)}
                    title={(t as (key: string) => string)("collaborate.block")}
                    aria-label={(t as (key: string) => string)("collaborate.block")}
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Ban className="h-3 w-3" aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
        ) : (
          // Non-host viewers still see each guest's current permission.
          <span
            className={`ms-auto flex shrink-0 items-center gap-1 text-muted-foreground ${compact ? "text-[10px]" : "text-xs"}`}
          >
            {permIcon}
            {permLabel}
          </span>
        ))}
    </li>
  );
}
