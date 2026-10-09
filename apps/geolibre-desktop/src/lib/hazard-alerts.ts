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
/** A new detection event, or `null` while checking a continuing presence. */
export type AlertEvent = AlertKind | null;

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
 * A new entry always rings immediately. This deliberately ignores both the
 * repeat window and an acknowledgement from a preceding near warning: a
 * near -> inside escalation is a new, more serious event. Passing `null`
 * means the worker is still in the same presence, so acknowledgement and the
 * repeat window apply. An inside -> near de-escalation is a `near` event, so
 * it remains subject to those gates and never causes a new loud enter alert.
 */
export function shouldAlert(
  memory: AlertMemory,
  zoneId: string,
  event: AlertEvent,
  now: number,
  repeatMs: number,
): boolean {
  if (event === "enter") return true;
  const silencedUntil = memory.silencedUntil[zoneId] ?? 0;
  if (now < silencedUntil) return false;
  const last = memory.lastAlertAt[zoneId] ?? 0;
  if (last === 0) return true;
  return now - last >= repeatMs;
}

/**
 * Forget one completed visit to a zone.
 *
 * Acknowledgement only silences the visit during which it was given. Once an
 * exit is published, a later enter starts with no silence or repeat history.
 */
export function forgetZone(memory: AlertMemory, zoneId: string): AlertMemory {
  const silencedUntil = { ...memory.silencedUntil };
  const lastAlertAt = { ...memory.lastAlertAt };
  const lastKind = { ...memory.lastKind };
  delete silencedUntil[zoneId];
  delete lastAlertAt[zoneId];
  delete lastKind[zoneId];
  return { silencedUntil, lastAlertAt, lastKind };
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
