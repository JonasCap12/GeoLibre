// The shared dataset library: row shape, serialization, and access rules.
//
// Projects share a finished map. This shares the source files behind one, so a
// team converts a drawing once instead of each person keeping a private copy in
// their own browser storage. See schema-datasets.sql for the table.

import { ApiError, type Config } from "./model";

export type DatasetVisibility = "public" | "private";

export interface DatasetRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  object_key: string;
  visibility: string;
  downloads: number;
  created_at: string;
  updated_at: string;
  owner_username: string | null;
}

/**
 * Every dataset read goes through this projection, so the uploader's username
 * is always present. A listing is the main surface, and "who put this here" is
 * the first thing a teammate needs — deriving it per row would turn one query
 * into one per dataset, the same trap PROJECT_SELECT avoids.
 */
export const DATASET_SELECT = `
  SELECT d.*, a.username AS owner_username
  FROM datasets d
  LEFT JOIN accounts a ON a.id = d.owner_id
`;

/**
 * Serialize a dataset for the API.
 *
 * `contentUrl` is absolute so the app can hand it straight to a fetch or to the
 * vector loader without knowing where the API lives, matching how projectJson
 * builds rawJsonUrl.
 */
export function datasetJson(row: DatasetRow, config: Config): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    visibility: row.visibility,
    downloads: row.downloads,
    owner: row.owner_username,
    tags: readTags((row as unknown as { tags?: unknown }).tags),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentUrl: `${config.baseUrl}/datasets/${row.id}/content`,
  };
}

/** R2 key for a dataset's bytes. */
export const datasetKey = (id: string): string => `datasets/${id}/content`;

/**
 * Reduce an uploaded filename to something safe to echo back.
 *
 * The name is returned in a JSON field and shown in the UI, and is used for the
 * download filename — never to build the R2 key, which is derived from the id
 * alone, so a traversal attempt cannot escape a prefix. Path separators are
 * still stripped so the stored value cannot *look* like a path to a client that
 * joins it onto a directory.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 200) || "dataset";
}

/**
 * Content types accepted for a dataset.
 *
 * Deliberately permissive about the *declared* type and strict about what it is
 * used for: the value is stored and echoed back on download, never used to
 * decide how to parse anything. `text/html` and SVG are the exceptions, because
 * the content endpoint serves from the API origin — a stored HTML document
 * would run as same-origin script against the API. Those are forced to
 * `application/octet-stream` instead of being rejected, so a legitimately named
 * file still uploads.
 */
const INLINE_SCRIPTABLE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml)/i;

/** Normalize a declared content type, neutralizing anything scriptable. */
export function safeContentType(raw: string | null): string {
  const declared = (raw ?? "").split(";")[0].trim().toLowerCase();
  if (declared === "" || INLINE_SCRIPTABLE.test(declared)) return "application/octet-stream";
  // A type is a token/subtype pair; anything else is not worth storing.
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(declared)
    ? declared
    : "application/octet-stream";
}

/** Parse the visibility field of an upload, defaulting to shared. */
export function datasetVisibility(raw: unknown): DatasetVisibility {
  if (raw === undefined || raw === null || raw === "") return "public";
  if (raw === "public" || raw === "private") return raw;
  throw new ApiError(422, "visibility must be public or private");
}

/**
 * 404 for both a missing dataset and one the caller may not discover, so a
 * status code never reveals that a private dataset exists. Mirrors `visible`
 * for projects.
 */
export function visibleDataset(row: DatasetRow | null, accountId: string | null): DatasetRow {
  if (
    row === null ||
    (row.visibility === "private" && (accountId === null || row.owner_id !== accountId))
  ) {
    throw new ApiError(404, "dataset not found");
  }
  return row;
}

/** The dataset, or 403/404 when the caller does not own it. */
export function ownedDataset(row: DatasetRow | null, accountId: string): DatasetRow {
  if (row === null) throw new ApiError(404, "dataset not found");
  if (row.owner_id !== accountId) throw new ApiError(403, "dataset ownership required");
  return row;
}

/** How many tags one dataset may carry, and how long each may be. */
export const MAX_TAGS = 12;
export const MAX_TAG_LENGTH = 32;

/**
 * Normalize a caller-supplied tag list into the stored form.
 *
 * Tags are lowercased so "Road" and "road" are one tag rather than two that
 * look identical in a list, trimmed, de-duplicated, and stored comma-separated
 * with a leading and trailing comma. Those sentinel commas are what let a tag
 * filter match a whole tag: `tags LIKE '%,road,%'` finds `road` and not the
 * `road` inside `railroad`, which a naive `LIKE '%road%'` would.
 *
 * Commas are stripped from inside a tag rather than rejected, because a tag is
 * free text a user typed and one stray comma should not fail the upload; it
 * would otherwise split one tag into two on the way back out.
 *
 * @param raw - The comma-separated value from the request.
 * @returns The stored form, or `""` when nothing usable was supplied.
 */
export function normalizeTags(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.trim() === "") return "";
  const seen: string[] = [];
  for (const piece of raw.split(",")) {
    const tag = piece.trim().toLowerCase().replace(/,/g, "").slice(0, MAX_TAG_LENGTH).trim();
    if (!tag || seen.includes(tag)) continue;
    seen.push(tag);
    if (seen.length >= MAX_TAGS) break;
  }
  return seen.length > 0 ? `,${seen.join(",")},` : "";
}

/**
 * The tags of a stored row, as a plain list for the API response.
 *
 * @param stored - The column value.
 * @returns The tags, without the sentinel commas.
 */
export function readTags(stored: unknown): string[] {
  if (typeof stored !== "string" || stored === "") return [];
  return stored.split(",").filter((tag) => tag !== "");
}

/**
 * The `LIKE` pattern that matches one whole tag.
 *
 * @param tag - A caller-supplied tag.
 * @returns The pattern, or null when the tag is unusable.
 */
export function tagLikePattern(tag: string | null | undefined): string | null {
  const normalized = normalizeTags(tag);
  if (!normalized) return null;
  // normalizeTags may have kept several; a filter takes the first.
  const first = readTags(normalized)[0];
  return first ? `%,${first},%` : null;
}

/**
 * The `LIKE` pattern for a free-text search, with wildcards escaped.
 *
 * Without escaping, a query containing `%` matches everything and a query
 * containing `_` matches any character, so a user searching for a filename
 * with an underscore -- which is most of them -- gets results that do not
 * contain what they typed.
 *
 * @param query - The raw search text.
 * @returns The pattern, or null when the query is empty.
 */
export function searchLikePattern(query: string | null | undefined): string | null {
  if (typeof query !== "string") return null;
  const trimmed = query.trim().slice(0, 200);
  if (!trimmed) return null;
  const escaped = trimmed.replace(/[\\%_]/g, (ch) => "\\" + ch);
  return `%${escaped.toLowerCase()}%`;
}
