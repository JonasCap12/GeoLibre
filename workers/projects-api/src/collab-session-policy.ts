// Validation for an account's saved collaboration sessions. Pure, so the test
// runner can import it; collab-sessions.ts is the D1 side.

/**
 * The relay's session code: eight characters of its unambiguous base32
 * alphabet (no 0/1/O/I). Mirrors CODE_ALPHABET in workers/collab/src/index.ts.
 */
export const COLLAB_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/;

/** The relay's host token: 24 random bytes as lowercase hex. */
export const COLLAB_HOST_TOKEN_RE = /^[0-9a-f]{48}$/;

export const MAX_COLLAB_SESSION_NAME = 60;

/**
 * Sessions one account may keep. A team runs a handful; the cap only stops a
 * script from filling the table.
 */
export const MAX_COLLAB_SESSIONS = 50;

export type CollabSessionMode = "co-edit" | "view-only";

/** Upper-cased and trimmed, or null when it cannot be a relay code. */
export function normalizeCollabCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return COLLAB_CODE_RE.test(code) ? code : null;
}

/** Whitespace collapsed, control characters removed; null when empty or too long. */
export function normalizeCollabName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Whitespace first: a tab or newline between two words is a word break, and
  // stripping it as a control character would glue them together.
  const name = value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (name === "" || Array.from(name).length > MAX_COLLAB_SESSION_NAME) return null;
  return name;
}

export function normalizeCollabMode(value: unknown): CollabSessionMode | null {
  return value === "co-edit" || value === "view-only" ? value : null;
}

export function isCollabHostToken(value: unknown): value is string {
  return typeof value === "string" && COLLAB_HOST_TOKEN_RE.test(value);
}
