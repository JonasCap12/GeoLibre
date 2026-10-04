import { useAppStore } from "@geolibre/core";
import { useTranslation } from "react-i18next";
import type { CollaborationApi } from "../../hooks/useCollaboration";

/**
 * Map-frame chrome while the local camera follows someone: a thin border in
 * their color and a top-center label with a stop button. The frame itself
 * does not take pointer events, so panning the map still works (and that
 * gesture is what turns following off).
 */
export function CollaborationFollowChrome({ api }: { api: CollaborationApi }) {
  const { t } = useTranslation();
  const isActive = useAppStore((s) => s.collaboration.isActive);
  const followClientId = useAppStore((s) => s.collaboration.followClientId);
  const participants = useAppStore((s) => s.collaboration.participants);
  if (!isActive || !followClientId) return null;
  const person = participants.find((p) => p.clientId === followClientId);
  if (!person) return null;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-10"
      style={{ boxShadow: `inset 0 0 0 2px ${person.color}` }}
    >
      <div
        className="absolute left-1/2 top-3 flex max-w-[min(92vw,24rem)] -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1 text-xs text-white shadow-md"
        style={{ backgroundColor: person.color }}
        role="status"
        aria-label={t("collaborate.followingName", { name: person.displayName })}
      >
        <span className="truncate">
          {t("collaborate.following")}{" "}
          <strong className="font-semibold">{person.displayName}</strong>
        </span>
        <button
          type="button"
          className="pointer-events-auto shrink-0 rounded-full bg-white/20 px-2 py-0.5 font-medium hover:bg-white/30"
          onClick={() => api.setFollow(null)}
        >
          {t("collaborate.followStop")}
        </button>
      </div>
    </div>
  );
}
