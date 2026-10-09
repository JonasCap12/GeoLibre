/**
 * Alert decisions for the danger-zone prototype.
 *
 * Vibration, sound, and the on-screen warning are driven from here so the
 * dialog stays thin. Browser objects are passed in: tests never touch a real
 * phone. The Vibration API does not exist on iPhone Safari; this reports
 * "unsupported" and does not claim the phone vibrated.
 *
 * The packaged Tauri app does not depend on `@tauri-apps/plugin-haptics`
 * (only the geolocation plugin is wired up). Adding haptics needs a native
 * plugin, permissions, and a rebuild, so this prototype uses the web
 * Vibration API. TODO: call plugin-haptics from the packaged app if a
 * device stays silent there.
 */

/** Long pulses when the worker enters a zone. */
export const ENTER_VIBRATION_MS = [600, 200, 600, 200, 600];
/** Short pulses when the worker is only near a zone. */
export const NEAR_VIBRATION_MS = [120, 80, 120];

/** How often an unacknowledged inside/near alert repeats. */
export const DEFAULT_REPEAT_MS = 15_000;
/** How long "Đã biết" keeps one zone quiet. */
export const DEFAULT_SILENCE_MS = 3 * 60_000;

export type AlertKind = "enter" | "near";

export interface VibrateHost {
  vibrate?: (pattern: number | number[]) => boolean;
  userAgent: string;
}

export interface AlertMemory {
  silencedUntil: Record<string, number>;
  lastAlertAt: Record<string, number>;
  lastKind: Record<string, AlertKind>;
}

export function emptyAlertMemory(): AlertMemory {
  return { silencedUntil: {}, lastAlertAt: {}, lastKind: {} };
}

export function vibrationPattern(kind: AlertKind): number[] {
  return kind === "enter" ? ENTER_VIBRATION_MS : NEAR_VIBRATION_MS;
}

/** iPhone and iPad Safari do not implement `navigator.vibrate`. */
export function isIosUserAgent(userAgent: string): boolean {
  return /iPad|iPhone|iPod/.test(userAgent);
}

/**
 * Vibrate for an enter or near alert.
 *
 * @returns `"unsupported"` on iOS and wherever `vibrate` is missing, without
 *   calling it.
 */
export function triggerVibration(host: VibrateHost, kind: AlertKind): "vibrated" | "unsupported" {
  if (isIosUserAgent(host.userAgent) || typeof host.vibrate !== "function") return "unsupported";
  host.vibrate(vibrationPattern(kind));
  return "vibrated";
}

/**
 * True when this zone should ring again.
 *
 * A zone the worker has acknowledged stays quiet until `silencedUntil`.
 * Otherwise the alert repeats once `repeatMs` has passed since the last one.
 * Stepping from "near" into the zone (`kind === "enter"`) rings at once.
 */
export function shouldAlert(
  memory: AlertMemory,
  zoneId: string,
  now: number,
  repeatMs: number,
  kind?: AlertKind,
): boolean {
  const silencedUntil = memory.silencedUntil[zoneId] ?? 0;
  if (now < silencedUntil) return false;
  if (kind === "enter" && memory.lastKind[zoneId] !== "enter") return true;
  const last = memory.lastAlertAt[zoneId] ?? 0;
  if (last === 0) return true;
  return now - last >= repeatMs;
}

export function markAlerted(
  memory: AlertMemory,
  zoneId: string,
  now: number,
  kind?: AlertKind,
): AlertMemory {
  return {
    silencedUntil: memory.silencedUntil,
    lastAlertAt: { ...memory.lastAlertAt, [zoneId]: now },
    lastKind: kind ? { ...memory.lastKind, [zoneId]: kind } : memory.lastKind,
  };
}

/** Silence one zone until `now + silenceMs`. Repeats resume after that. */
export function acknowledgeZone(
  memory: AlertMemory,
  zoneId: string,
  now: number,
  silenceMs: number,
): AlertMemory {
  return {
    silencedUntil: { ...memory.silencedUntil, [zoneId]: now + silenceMs },
    lastAlertAt: { ...memory.lastAlertAt, [zoneId]: now },
    lastKind: memory.lastKind,
  };
}
