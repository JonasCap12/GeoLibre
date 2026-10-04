import type { CollaborationMode } from "@geolibre/core";
import { Button, Input, Label, Select } from "@geolibre/ui";
import { Check, Link2, Loader2, Pencil, Play, Plus, Trash2, Users } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { CollaborationApi } from "../../hooks/useCollaboration";
import { endSession } from "../../lib/collab-client";
import { recallHostToken, rememberHostToken } from "../../lib/collab-host-tokens";
import {
  deleteSavedSession,
  fetchSessionHostToken,
  listSavedSessions,
  saveSession,
  updateSavedSession,
  type SavedCollabSession,
} from "../../lib/collab-sessions";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    date,
  );
}

function inviteLink(code: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("collab", code);
  return url.toString();
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * The signed-in owner's standing sessions, one per team or group.
 *
 * Each is a persistent relay session (kept 30 days after last use) saved to the
 * account with a name, so it can be reopened from any device with the same
 * code and invite link, and with the owner still host: the host token comes
 * back from the projects API and is handed to the relay on join.
 */
export function CollabSessionManager({
  api,
  token,
  selfName,
  color,
  onOpened,
}: {
  api: CollaborationApi;
  token: string;
  selfName: string;
  color: string;
  /** Called with the session's name once it is live, for the active view. */
  onOpened: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<SavedCollabSession[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<CollaborationMode>("co-edit");
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await listSavedSessions({ token }));
    } catch (err) {
      setSessions([]);
      setError(errorText(err, t("collaborate.saved.loadFailed")));
    }
  }, [token, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const label = name.trim();
    if (label === "") return setError(t("collaborate.saved.nameRequired"));
    await run("create", async () => {
      let code: string;
      try {
        code = await api.start(selfName, color, mode, false, { persistent: true });
      } catch (err) {
        console.error("[GeoLibre] Collaboration error", err);
        setError(errorText(err, t("collaborate.connectFailed")));
        return;
      }
      onOpened(label);
      const hostToken = recallHostToken(code);
      if (!hostToken) return;
      try {
        await saveSession({ token, code, name: label, mode, hostToken });
        setName("");
      } catch (err) {
        // The session is live either way; only the list entry is missing.
        setError(t("collaborate.saved.saveFailed", { message: errorText(err, "") }));
      }
    });
  };

  const open = (session: SavedCollabSession) =>
    run(session.id, async () => {
      try {
        // Seed the device-local token store, which is what join() replays to
        // the relay to be recognised as host.
        rememberHostToken(session.code, await fetchSessionHostToken({ token, id: session.id }));
      } catch (err) {
        // Still joinable without it, only not as host.
        console.warn("[GeoLibre] Could not restore host token", err);
      }
      try {
        await api.join(session.code, selfName, color);
      } catch (err) {
        console.error("[GeoLibre] Collaboration error", err);
        setError(t("collaborate.saved.openFailed", { message: errorText(err, "") }));
        return;
      }
      onOpened(session.name);
      void updateSavedSession({ token, id: session.id, opened: true }).catch(() => {});
    });

  const rename = (session: SavedCollabSession, value: string) =>
    run(session.id, async () => {
      const label = value.trim();
      if (label === "") return setError(t("collaborate.saved.nameRequired"));
      try {
        await updateSavedSession({ token, id: session.id, name: label });
        setRenaming(null);
        await load();
      } catch (err) {
        setError(errorText(err, t("collaborate.saved.updateFailed")));
      }
    });

  const remove = (session: SavedCollabSession) =>
    run(session.id, async () => {
      try {
        const hostToken = await fetchSessionHostToken({ token, id: session.id }).catch(
          () => recallHostToken(session.code) ?? null,
        );
        // End it on the relay first, so nobody is left in a session that no
        // longer appears in any list. An expired session counts as ended.
        if (hostToken) await endSession(session.code, hostToken);
        await deleteSavedSession({ token, id: session.id });
        setConfirmDelete(null);
        await load();
      } catch (err) {
        setError(errorText(err, t("collaborate.saved.deleteFailed")));
      }
    });

  const copy = (session: SavedCollabSession) => {
    void navigator.clipboard
      .writeText(inviteLink(session.code))
      .then(() => {
        setCopied(session.id);
        window.setTimeout(() => setCopied((id) => (id === session.id ? null : id)), 2000);
      })
      .catch(() => setError(t("collaborate.copyFailed")));
  };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(event) => void create(event)}
        className="space-y-3 rounded-lg border bg-card p-3 shadow-sm"
        noValidate
      >
        <p className="flex items-center gap-2 text-sm font-medium">
          <Plus className="h-4 w-4 text-muted-foreground" aria-hidden />
          {t("collaborate.saved.newHeading")}
        </p>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="collab-session-name">{t("collaborate.saved.nameLabel")}</Label>
            <Input
              id="collab-session-name"
              value={name}
              maxLength={60}
              placeholder={t("collaborate.saved.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              disabled={busy !== null}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="collab-session-mode">{t("collaborate.mode")}</Label>
            <Select
              id="collab-session-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value as CollaborationMode)}
              disabled={busy !== null}
            >
              <option value="co-edit">{t("collaborate.modeCoEdit")}</option>
              <option value="view-only">{t("collaborate.modeViewOnly")}</option>
            </Select>
          </div>
        </div>
        <Button type="submit" className="w-full" disabled={busy !== null || name.trim() === ""}>
          {busy === "create" ? (
            <Loader2 className="me-2 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Users className="me-2 h-3.5 w-3.5" />
          )}
          {t("collaborate.saved.create")}
        </Button>
        <p className="text-xs text-muted-foreground">{t("collaborate.saved.retention")}</p>
      </form>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t("collaborate.saved.title")}</h3>
        {sessions === null ? (
          <p className="text-xs text-muted-foreground">{t("collaborate.saved.loading")}</p>
        ) : sessions.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {t("collaborate.saved.empty")}
          </p>
        ) : (
          <ul className="max-h-72 space-y-2 overflow-y-auto pe-1">
            {sessions.map((session) => {
              const rowBusy = busy === session.id;
              return (
                <li key={session.id} className="space-y-2 rounded-lg border bg-card p-3 shadow-sm">
                  {renaming?.id === session.id ? (
                    <form
                      className="flex gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void rename(session, renaming.value);
                      }}
                    >
                      <Input
                        aria-label={t("collaborate.saved.nameLabel")}
                        value={renaming.value}
                        maxLength={60}
                        autoFocus
                        onChange={(event) =>
                          setRenaming({ id: session.id, value: event.target.value })
                        }
                      />
                      <Button type="submit" size="sm" disabled={rowBusy}>
                        {t("collaborate.saved.save")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRenaming(null)}
                      >
                        {t("common.cancel")}
                      </Button>
                    </form>
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1 text-start">
                        <p className="truncate text-sm font-semibold">{session.name}</p>
                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="font-mono tracking-wider">{session.code}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold">
                            {session.mode === "view-only"
                              ? t("collaborate.modeViewOnly")
                              : t("collaborate.modeCoEdit")}
                          </span>
                          <span>
                            {t("collaborate.saved.lastOpened", {
                              date: formatDate(session.lastOpenedAt ?? session.createdAt),
                            })}
                          </span>
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy !== null}
                        onClick={() => void open(session)}
                      >
                        {rowBusy ? (
                          <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="me-1.5 h-3.5 w-3.5" />
                        )}
                        {t("collaborate.saved.open")}
                      </Button>
                    </div>
                  )}

                  {confirmDelete === session.id ? (
                    <div className="space-y-2 rounded-md bg-destructive/10 p-2">
                      <p className="text-xs text-destructive">
                        {t("collaborate.saved.deleteHint")}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={rowBusy}
                          onClick={() => void remove(session)}
                        >
                          {t("collaborate.saved.confirmDelete")}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmDelete(null)}
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : renaming?.id === session.id ? null : (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => copy(session)}
                      >
                        {copied === session.id ? (
                          <Check className="me-1 h-3.5 w-3.5" />
                        ) : (
                          <Link2 className="me-1 h-3.5 w-3.5" />
                        )}
                        {copied === session.id
                          ? t("collaborate.copied")
                          : t("collaborate.copyLink")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        disabled={busy !== null}
                        onClick={() => setRenaming({ id: session.id, value: session.name })}
                      >
                        <Pencil className="me-1 h-3.5 w-3.5" />
                        {t("collaborate.saved.rename")}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                        disabled={busy !== null}
                        onClick={() => setConfirmDelete(session.id)}
                      >
                        <Trash2 className="me-1 h-3.5 w-3.5" />
                        {t("collaborate.saved.delete")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {error ? (
        <p role="alert" className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
