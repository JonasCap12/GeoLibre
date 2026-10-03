/**
 * Notices when the saved bearer has stopped working, so the self-hosted gate
 * can return to the sign-in page instead of leaving every save to fail.
 *
 * Tokens now expire (30 days absolute, 7 idle) and can be revoked from another
 * device or by an admin. Every authenticated request goes through the share
 * fetch, so it is wrapped here rather than each caller checking for 401.
 *
 * A 401 alone is not proof: `POST /api/auth/password` answers 401 for a
 * mistyped current password with a perfectly good token. So a 401 on a request
 * that carried the current token triggers one `GET /api/account`, and only a
 * 401 from that clears the token. A network error clears nothing.
 */

import { getShareFetch, requestOrigin, setShareFetch } from "./share-fetch";

export interface SessionWatchOptions {
  /** The API base whose responses are watched. */
  baseUrl: string;
  /** The bearer currently saved, read at response time. */
  getToken: () => string;
  /** Called once the server has confirmed the token is no longer valid. */
  onExpired: (token: string) => void;
}

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string) {
  const fromInit = init?.headers;
  if (fromInit !== undefined) {
    const value = new Headers(fromInit).get(name);
    if (value !== null) return value;
  }
  if (typeof Request !== "undefined" && input instanceof Request) return input.headers.get(name);
  return null;
}

/**
 * Wraps the share fetch. Returns a function that restores the previous one.
 */
export function installSessionWatch(options: SessionWatchOptions): () => void {
  const inner = getShareFetch();
  const origin = requestOrigin(options.baseUrl);
  const base = options.baseUrl.replace(/\/+$/, "");
  let checking: string | null = null;

  const verify = async (token: string) => {
    if (checking === token) return;
    checking = token;
    try {
      const response = await inner(`${base}/api/account`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      // Only if it is still the saved token: a sign-in may have replaced it
      // while this request was in flight.
      if (response.status === 401 && options.getToken() === token) options.onExpired(token);
    } catch {
      // Offline is not signed out.
    } finally {
      checking = null;
    }
  };

  const watched: typeof globalThis.fetch = async (input, init) => {
    const response = await inner(input, init);
    if (response.status !== 401 || origin === null || requestOrigin(input) !== origin) {
      return response;
    }
    const token = options.getToken();
    if (token !== "" && headerValue(input, init, "Authorization") === `Bearer ${token}`) {
      void verify(token);
    }
    return response;
  };

  setShareFetch(watched);
  return () => {
    if (getShareFetch() === watched) setShareFetch(inner);
  };
}
