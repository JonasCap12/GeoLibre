/**
 * Client for an account's saved collaboration sessions on the projects API
 * (`/api/collab-sessions`, see workers/projects-api/src/collab-sessions.ts).
 *
 * The relay holds each session; the API remembers which ones belong to the
 * signed-in account, under a name, together with the sealed host token. That
 * is what lets the owner reopen a team's session from any device and still be
 * its host.
 */

import type { CollaborationMode } from "@geolibre/core";
import { authRequest } from "./share-account";

interface Options {
  token: string;
  baseUrl?: string | null;
  fetchImpl?: typeof globalThis.fetch;
}

export interface SavedCollabSession {
  id: string;
  code: string;
  name: string;
  mode: CollaborationMode;
  createdAt: string;
  lastOpenedAt: string | null;
}

export async function listSavedSessions(options: Options): Promise<SavedCollabSession[]> {
  const response = await authRequest("/api/collab-sessions", {
    ...options,
    method: "GET",
    fallback: "Could not load your sessions",
  });
  const body = (await response.json()) as { sessions?: SavedCollabSession[] };
  return body.sessions ?? [];
}

export async function saveSession(
  options: Options & { code: string; name: string; mode: CollaborationMode; hostToken: string },
): Promise<SavedCollabSession> {
  const response = await authRequest("/api/collab-sessions", {
    ...options,
    body: {
      code: options.code,
      name: options.name,
      mode: options.mode,
      hostToken: options.hostToken,
    },
    fallback: "Could not save the session",
  });
  return ((await response.json()) as { session: SavedCollabSession }).session;
}

export async function updateSavedSession(
  options: Options & { id: string; name?: string; opened?: boolean },
): Promise<SavedCollabSession> {
  const response = await authRequest(`/api/collab-sessions/${encodeURIComponent(options.id)}`, {
    ...options,
    method: "PATCH",
    body: {
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.opened ? { opened: true } : {}),
    },
    fallback: "Could not update the session",
  });
  return ((await response.json()) as { session: SavedCollabSession }).session;
}

/** The owner's host token, so rejoining from this device makes them host again. */
export async function fetchSessionHostToken(options: Options & { id: string }): Promise<string> {
  const response = await authRequest(
    `/api/collab-sessions/${encodeURIComponent(options.id)}/host-token`,
    { ...options, method: "GET", fallback: "Could not open the session" },
  );
  return ((await response.json()) as { hostToken: string }).hostToken;
}

export async function deleteSavedSession(options: Options & { id: string }): Promise<void> {
  await authRequest(`/api/collab-sessions/${encodeURIComponent(options.id)}`, {
    ...options,
    method: "DELETE",
    fallback: "Could not delete the session",
  });
}
