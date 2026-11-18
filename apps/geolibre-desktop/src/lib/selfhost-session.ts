import { getShareFetch } from "./share-fetch";
import { clearLegacySessionToken, legacySessionToken } from "./selfhost-session-mode";

export const COOKIE_SESSION_HEADERS = { "X-GeoLibre-Session": "cookie" } as const;
let accessExpiresAt = 0;

/** Called for all four auth responses, before their caller updates the store. */
export function readAccessToken(body: { accessToken?: unknown; expiresAt?: unknown }): string {
  if (
    typeof body.accessToken !== "string" ||
    !body.accessToken ||
    typeof body.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(body.expiresAt))
  ) {
    throw new Error("The server did not return an access token.");
  }
  accessExpiresAt = Date.parse(body.expiresAt);
  return body.accessToken;
}

export interface SelfHostSessionOptions {
  baseUrl: string;
  getToken: () => string;
  setToken: (token: string) => void;
  onExpired: () => void;
  fetchImpl?: typeof fetch;
  readLegacy?: () => string;
  clearLegacy?: () => void;
  document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

/** One controller per tab. Refresh is shared only by concurrent calls in this tab. */
export function createSelfHostSession(options: SelfHostSessionOptions) {
  const fetchImpl = options.fetchImpl ?? ((input, init) => getShareFetch()(input, init));
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<string | null> | null = null;
  let stopped = false;
  let generation = 0;

  const schedule = (delay?: number) => {
    clearTimeout(timer);
    if (stopped || !options.getToken()) return;
    const remaining = accessExpiresAt - Date.now();
    timer = setTimeout(
      () => {
        void refresh().catch(() => schedule(30000));
      },
      delay ?? Math.max(1000, remaining * 0.8),
    );
  };

  const exchange = async (path: string, legacy?: string): Promise<string | null> => {
    const before = options.getToken();
    const version = generation;
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        ...COOKIE_SESSION_HEADERS,
        ...(legacy ? { Authorization: `Bearer ${legacy}` } : {}),
      },
    });
    if (stopped || generation !== version || options.getToken() !== before)
      return options.getToken() || null;
    if (response.status === 401) {
      if (legacy) (options.clearLegacy ?? clearLegacySessionToken)();
      options.setToken("");
      clearTimeout(timer);
      options.onExpired();
      return null;
    }
    if (!response.ok) throw new Error(`Session refresh failed (${response.status})`);
    const token = readAccessToken(await response.json());
    if (stopped || generation !== version || options.getToken() !== before)
      return options.getToken() || null;
    if (legacy) (options.clearLegacy ?? clearLegacySessionToken)();
    options.setToken(token);
    schedule();
    return token;
  };

  const refresh = (): Promise<string | null> => {
    if (stopped) return Promise.resolve(null);
    pending ??= exchange("/api/auth/refresh").finally(() => {
      pending = null;
    });
    return pending;
  };
  const visible = () => {
    if (
      doc?.visibilityState === "visible" &&
      options.getToken() &&
      accessExpiresAt - Date.now() <= 120000
    ) {
      void refresh().catch(() => schedule(30000));
    }
  };
  doc?.addEventListener("visibilitychange", visible);
  return {
    async boot() {
      const legacy = (options.readLegacy ?? legacySessionToken)();
      return legacy ? exchange("/api/auth/session/adopt", legacy) : refresh();
    },
    refresh,
    /** Store subscription: sign-in/password change replaces the in-memory bearer. */
    tokenChanged() {
      generation++;
      schedule();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      doc?.removeEventListener("visibilitychange", visible);
    },
  };
}
