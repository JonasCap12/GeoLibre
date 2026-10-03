// Cloudflare Turnstile server-side validation.
//
// A token proves nothing until siteverify accepts it, and even an accepted one
// can belong to another site or another form: `hostname` and `action` are what
// stop a token solved on a different page from being replayed against this
// route. Both are checked here, not only `success`.

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The `action` each form renders its widget with. The client must send the same string. */
export const TURNSTILE_ACTIONS = {
  register: "register",
  resetRequest: "reset-request",
  resetConfirm: "reset-confirm",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  "error-codes"?: string[];
}

export type TurnstileRefusal = "missing" | "rejected" | "hostname" | "action" | "unavailable";

/** Decides on a siteverify body. Pure, so the hostname/action rules are testable. */
export function turnstileVerdict(
  body: SiteverifyResponse,
  expected: { action: TurnstileAction; hostnames: readonly string[] },
): TurnstileRefusal | null {
  if (body.success !== true) return "rejected";
  if (expected.hostnames.length > 0) {
    if (typeof body.hostname !== "string" || !expected.hostnames.includes(body.hostname)) {
      return "hostname";
    }
  }
  if (body.action !== expected.action) return "action";
  return null;
}

/**
 * Hostnames a token may have been solved on: the app origins this API already
 * trusts for CORS, plus the viewer. A token from any other page is refused.
 */
export function turnstileHostnames(origins: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const origin of origins) {
    if (origin === "*") continue;
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      // Not a URL; CORS ignores it too.
    }
  }
  return [...hosts];
}

export async function verifyTurnstile(options: {
  secret: string;
  token: string;
  remoteIp: string | null;
  action: TurnstileAction;
  hostnames: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<TurnstileRefusal | null> {
  // Tokens are at most 2048 characters; anything else is not worth a round trip.
  if (options.token === "" || options.token.length > 2048) return "missing";
  const form = new FormData();
  form.append("secret", options.secret);
  form.append("response", options.token);
  if (options.remoteIp) form.append("remoteip", options.remoteIp);
  // Makes a retried siteverify call idempotent instead of a "token already
  // spent" failure. This Worker does not retry, but the key costs nothing.
  form.append("idempotency_key", crypto.randomUUID());
  let body: SiteverifyResponse;
  try {
    const response = await (options.fetchImpl ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      body: form,
    });
    body = (await response.json()) as SiteverifyResponse;
  } catch (error) {
    // Closed, unlike the breach check: Turnstile is the bot defence on routes
    // that send mail, and a siteverify outage is also a Cloudflare outage, at
    // which point this Worker is unlikely to be answering anyway.
    console.error("turnstile siteverify failed", String(error));
    return "unavailable";
  }
  return turnstileVerdict(body, { action: options.action, hostnames: options.hostnames });
}
