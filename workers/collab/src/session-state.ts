import { MAX_SNAPSHOT_BYTES } from "@geolibre/collab-core";
import type { SessionLogEntry } from "./protocol";

/** Parse persisted snapshots without locking joiners out on corrupt JSON. */
export function parseStoredSnapshot(snapshot: string | undefined): unknown {
  if (!snapshot) return null;
  try {
    return JSON.parse(snapshot);
  } catch {
    return null;
  }
}

export function parseStoredSessionLog(raw: unknown): SessionLogEntry[] {
  // Both historical bare arrays and the current JSON encoding are accepted.
  if (Array.isArray(raw)) return raw as SessionLogEntry[];
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SessionLogEntry[]) : [];
  } catch {
    return [];
  }
}

export function snapshotByteLimit(raw: string | undefined): number {
  const configured = Number(raw);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : MAX_SNAPSHOT_BYTES;
}
