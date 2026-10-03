/**
 * Cloudflare Turnstile for the self-hosted register and password-reset forms.
 *
 * Explicit rendering: the script is loaded only when one of those forms is on
 * screen, never on the map, and never in the desktop or Jupyter builds. The
 * desktop app cannot run Turnstile at all (its origin is not a hostname the
 * widget can be issued for), which is why sign-in itself carries no challenge
 * and is protected by rate limits instead.
 *
 * No site key configured means no widget; the server skips the check when its
 * secret is unset too. A key on one side only fails closed on the server.
 */

import { readDeploymentEnvValue, type EnvRecord } from "./deployment-env";

export const TURNSTILE_SITE_KEY_ENV = "VITE_GEOLIBRE_TURNSTILE_SITE_KEY";

export const TURNSTILE_SCRIPT_URL =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Must match TURNSTILE_ACTIONS in workers/projects-api/src/turnstile.ts. */
export const TURNSTILE_ACTIONS = {
  register: "register",
  resetRequest: "reset-request",
  resetConfirm: "reset-confirm",
} as const;

export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];

export function resolveTurnstileSiteKey(
  deploymentEnv?: EnvRecord,
  buildEnv?: EnvRecord,
): string | null {
  const value = readDeploymentEnvValue(TURNSTILE_SITE_KEY_ENV, deploymentEnv, buildEnv)?.trim();
  return value ? value : null;
}

export interface TurnstileRenderOptions {
  sitekey: string;
  action: string;
  theme?: "auto" | "light" | "dark";
  language?: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** Loads the Turnstile script once per page. */
export function loadTurnstile(doc: Document = document): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = doc.createElement("script");
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not initialise"));
    };
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error("Turnstile could not be loaded"));
    };
    doc.head.appendChild(script);
  });
  return loading;
}
