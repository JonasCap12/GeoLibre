import { readDeploymentEnvValue } from "./deployment-env";
import { isTauri } from "./is-tauri";
import { DESKTOP_SETTINGS_STORAGE_KEY } from "./storage-keys";

/** Off by default; native and notebook builds retain their existing credentials. */
export function sessionCookieMode(): boolean {
  return (
    typeof window !== "undefined" &&
    !isTauri() &&
    !(typeof __GEOLIBRE_EMBED_BUILD__ !== "undefined" && __GEOLIBRE_EMBED_BUILD__) &&
    readDeploymentEnvValue("VITE_GEOLIBRE_SESSION_COOKIE") === "1"
  );
}

export function cookieApiOrigin(): string | null {
  return sessionCookieMode() ? window.location.origin : null;
}

export function legacySessionToken(): string {
  const raw = window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY);
  if (!raw) return "";
  try {
    const settings = JSON.parse(raw) as { shareToken?: unknown };
    return typeof settings.shareToken === "string" ? settings.shareToken.trim() : "";
  } catch {
    return "";
  }
}

/**
 * What cookie mode writes as `shareToken` when it saves the settings blob.
 *
 * Never the in-memory access token. Until adoption succeeds or definitively
 * fails, the bearer an older build saved is written back unchanged, so the
 * other settings keep saving while a migration that hit a network error waits
 * for the next boot (rather than either losing the bearer or blocking every
 * settings write for the whole visit).
 */
export function persistedSessionToken(): string {
  try {
    return legacySessionToken();
  } catch {
    return "";
  }
}

export function clearLegacySessionToken(): void {
  try {
    const raw = window.localStorage.getItem(DESKTOP_SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const settings = JSON.parse(raw) as Record<string, unknown>;
    window.localStorage.setItem(
      DESKTOP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ ...settings, shareToken: "" }),
    );
  } catch {
    // Unreadable or unwritable storage holds no bearer worth clearing.
  }
}
