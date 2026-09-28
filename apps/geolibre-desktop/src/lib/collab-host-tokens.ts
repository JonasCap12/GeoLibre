/**
 * Remember the host token of a collaboration session this device created.
 *
 * The relay decides the role on every join by comparing the token the client
 * sends against the one stored when the session was created, and it never
 * rotates that token (`/init` writes it once and refuses to overwrite it). So
 * the relay has always been willing to hand host back — the client simply threw
 * the token away. `start()` held it in the closure of a single `connect()` call,
 * and `join()` sent `undefined`, so a host who left and came back by code was
 * demoted to guest in their own session, with no way to get host back short of
 * starting a new one.
 *
 * Device-local, like the share API token: it stays in this browser, is never
 * sent anywhere but the relay that issued it, and does not follow the account.
 * Anyone with this browser profile can host these sessions, which is the same
 * trust boundary the share token already sets.
 */

/** Where the tokens live. Namespaced like the other per-device keys. */
export const COLLAB_HOST_TOKENS_KEY = "geolibre:collab-host-tokens";

/**
 * How many sessions to remember.
 *
 * Bounded so a long-lived profile cannot grow this entry without limit. Hosting
 * more than a handful of live sessions at once is not a real workflow, and the
 * oldest entry to fall off is the least likely to be rejoined.
 */
export const MAX_REMEMBERED_HOST_TOKENS = 20;

interface RememberedHostToken {
  sessionId: string;
  token: string;
  savedAt: number;
}

/**
 * Session codes are matched case-insensitively.
 *
 * `join()` upper-cases whatever the user typed before connecting, so a token
 * stored under a different casing would never be found again — the lookup has
 * to normalize the same way the connect path does.
 */
function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().toUpperCase();
}

function readAll(): RememberedHostToken[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(COLLAB_HOST_TOKENS_KEY);
  } catch {
    // Private window, or site data blocked. Hosting still works for the session
    // that is being created right now; only rejoining as host is lost.
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RememberedHostToken =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RememberedHostToken).sessionId === "string" &&
        typeof (entry as RememberedHostToken).token === "string" &&
        typeof (entry as RememberedHostToken).savedAt === "number",
    );
  } catch {
    // Corrupt or hand-edited value: start over rather than throw on every join.
    return [];
  }
}

function writeAll(entries: RememberedHostToken[]): void {
  try {
    localStorage.setItem(COLLAB_HOST_TOKENS_KEY, JSON.stringify(entries));
  } catch {
    // Storage full or unavailable; the current session is unaffected.
  }
}

/**
 * Record the host token for a session this device just created.
 *
 * @param sessionId - The session code the relay returned.
 * @param token - The host token issued with it.
 */
export function rememberHostToken(sessionId: string, token: string): void {
  const id = normalizeSessionId(sessionId);
  if (!id || !token) return;
  // Newest first, so the cap drops the least recently hosted session.
  const entries = [
    { sessionId: id, token, savedAt: Date.now() },
    ...readAll().filter((entry) => normalizeSessionId(entry.sessionId) !== id),
  ].slice(0, MAX_REMEMBERED_HOST_TOKENS);
  writeAll(entries);
}

/**
 * The host token for a session, when this device created it.
 *
 * @param sessionId - The code the user is joining with, in any casing.
 * @returns The token, or undefined when this device never hosted that session.
 */
export function recallHostToken(sessionId: string): string | undefined {
  const id = normalizeSessionId(sessionId);
  if (!id) return undefined;
  return readAll().find((entry) => normalizeSessionId(entry.sessionId) === id)?.token;
}
