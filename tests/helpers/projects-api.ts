import { FakeD1 } from "./fake-d1";
import type { Scope, Env } from "../../workers/projects-api/src/context";
import type { AccountRow } from "../../workers/projects-api/src/model";
import type { OutboundEmail } from "../../workers/projects-api/src/email";
import workerEntry from "../../workers/projects-api/src/index";

// tsx's ESM-to-CJS boundary wraps this workspace's default export on Node.
export const worker =
  "fetch" in workerEntry
    ? workerEntry
    : (workerEntry as unknown as { default: typeof workerEntry }).default;

export const account: AccountRow = {
  id: "owner",
  username: "surveyor",
  email: "old@example.com",
  password_hash: "invalid",
  created_at: new Date().toISOString(),
  disabled_at: null,
};

export function apiScope(
  options: {
    account?: AccountRow | null;
    method?: string;
    path?: string;
    body?: unknown;
    db?: FakeD1;
  } = {},
) {
  const db = options.db ?? new FakeD1();
  const pending: Promise<unknown>[] = [];
  const messages: OutboundEmail[] = [];
  const env = {
    DB: db,
    OBJECTS: {},
    GEOLIBRE_ADMIN_USERNAMES: "admin",
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    GEOLIBRE_EMAIL_FROM: "no-reply@example.com",
    EMAIL: {
      async send(message: OutboundEmail) {
        messages.push(message);
      },
    },
  } as unknown as Env;
  const request = new Request(`https://api.example.com${options.path ?? "/api/account"}`, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const scope: Scope = {
    request,
    env,
    db: db as unknown as Scope["db"],
    url: new URL(request.url),
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    } as Scope["ctx"],
    config: {
      baseUrl: "https://api.example.com",
      viewerUrl: "https://viewer.example.com/",
      maxProjectBytes: 100000,
      maxThumbnailBytes: 10000,
      maxDatasetBytes: 100000,
      activityRetentionDays: 30,
      corsOrigins: [],
      session: { ttlMs: 30 * 86400000, idleMs: 7 * 86400000 },
    },
    session: Promise.resolve(
      options.account === null
        ? null
        : {
            account: options.account ?? { ...account },
            digest: "current-session",
          },
    ),
  };
  return {
    scope,
    db,
    messages,
    async drain() {
      await Promise.all(pending);
    },
  };
}

export function signedInRow(overrides: Partial<AccountRow> = {}) {
  const at = new Date().toISOString();
  return {
    ...account,
    ...overrides,
    t_created_at: at,
    t_last_used_at: at,
    t_expires_at: new Date(Date.now() + 86400000).toISOString(),
  };
}
