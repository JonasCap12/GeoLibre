/**
 * Client for the shared dataset library on the GeoLibre projects API.
 *
 * The app's own Layer Library (`layer-library-store.ts`) keeps datasets in
 * IndexedDB, which is per-browser: nobody else can see what you added, and
 * clearing site data loses it. This is the shared counterpart — one person
 * uploads a file once and the rest of the team adds it as a layer.
 *
 * It reuses the share host and fetch the project upload already uses, so a
 * self-hosted deployment configures one URL (`VITE_GEOLIBRE_SHARE_URL`) and both
 * features follow it, and the desktop build gets the same Tauri-native HTTP path
 * that bypasses WebView CORS.
 */

import { getShareFetch } from "./share-fetch";
import { resolveShareBaseUrl } from "./share-geolibre";

/** How long a listing or delete may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Uploads get much longer than other calls: these are the files too big for the
 * browser to handle comfortably in the first place, which is why they are being
 * shared, and an office uplink is often the slow part.
 */
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type SharedDatasetVisibility = "public" | "private";

/** One entry in the shared library, as the API returns it. */
export interface SharedDataset {
  id: string;
  name: string;
  description: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  visibility: SharedDatasetVisibility;
  downloads: number;
  /** Uploader's username, or null for an account that has not picked one. */
  owner: string | null;
  createdAt: string;
  updatedAt: string;
  /** Lowercased tags the uploader attached, for filtering. */
  tags: string[];
  /** Absolute URL the bytes can be fetched from. */
  contentUrl: string;
}

export interface SharedDatasetRequest {
  /** Bearer token from Settings; required to upload or delete, optional to read. */
  token?: string;
  signal?: AbortSignal;
  /** Overrides the configured host. Tests pass this; callers should not. */
  baseUrl?: string;
  /** Overrides the share fetch. Tests pass this; callers should not. */
  fetchImpl?: typeof globalThis.fetch;
}

export interface SharedDatasetUpload extends SharedDatasetRequest {
  token: string;
  data: Uint8Array | ArrayBuffer;
  /** Original file name, shown in the library and used for the download name. */
  filename: string;
  /** Display name. Falls back to the filename when blank. */
  name?: string;
  description?: string;
  /** Defaults to "public" — the point of the library is that others see it. */
  visibility?: SharedDatasetVisibility;
  contentType?: string;
  /** Free-text tags. Normalized server-side: lowercased, trimmed, de-duplicated. */
  tags?: string[];
}

/** A listing, optionally narrowed by free text or one tag. */
export interface SharedDatasetListRequest extends SharedDatasetRequest {
  /** Matched against name, description, filename and tags. */
  query?: string;
  /** Exact tag to filter by. */
  tag?: string;
}

/** Thrown for every failure here, so callers have one type to catch. */
export class SharedDatasetError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SharedDatasetError";
  }
}

/** The configured API base, without a trailing slash. */
function requireBaseUrl(override?: string): string {
  const resolved = override ?? resolveShareBaseUrl();
  if (!resolved) {
    throw new SharedDatasetError(
      "No share server is configured for this deployment, so there is no shared data library.",
    );
  }
  return resolved.replace(/\/+$/, "");
}

/** Combine the caller's abort with a timeout so nothing hangs forever. */
function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Turn a failed response into a {@link SharedDatasetError}.
 *
 * The API reports its reason in a JSON `detail`, so that is preferred over a
 * bare status; a proxy returning HTML falls back to the status line.
 */
async function failure(response: Response): Promise<SharedDatasetError> {
  let detail = "";
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") detail = body.detail;
  } catch {
    // Not JSON; the status is all there is.
  }
  if (response.status === 401) {
    return new SharedDatasetError(
      "The share API token was rejected. Check it in Settings.",
      response.status,
    );
  }
  if (response.status === 413) {
    return new SharedDatasetError(
      detail || "That file is larger than the server accepts.",
      response.status,
    );
  }
  return new SharedDatasetError(
    detail || `The shared data library returned ${response.status}.`,
    response.status,
  );
}

/** Headers for a request, with the bearer token when one is available. */
function authHeaders(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { Authorization: `Bearer ${trimmed}` } : {};
}

/** Wrap a network failure, letting a caller-initiated abort through untouched. */
function networkError(error: unknown): never {
  if (error instanceof DOMException) {
    if (error.name === "AbortError") throw error;
    if (error.name === "TimeoutError") {
      throw new SharedDatasetError("The shared data library timed out. Please try again.");
    }
  }
  if (error instanceof SharedDatasetError) throw error;
  throw new SharedDatasetError("Could not reach the shared data library.");
}

/**
 * List the datasets the caller can see.
 *
 * Without a token this returns the shared ones; with a token it also returns
 * the caller's own private uploads.
 *
 * @returns Datasets, newest first.
 */
export async function listSharedDatasets(
  options: SharedDatasetListRequest = {},
): Promise<SharedDataset[]> {
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  // Filtering happens on the server: the library is meant to outgrow what a
  // client can hold, so narrowing a list it already downloaded would only work
  // until it stopped fitting.
  const query = new URLSearchParams();
  if (options.query?.trim()) query.set("q", options.query.trim());
  if (options.tag?.trim()) query.set("tag", options.tag.trim());
  const suffix = query.toString() ? `?${query}` : "";
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/datasets${suffix}`, {
      headers: authHeaders(options.token),
      signal: deadline(options.signal, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    networkError(error);
  }
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { datasets?: SharedDataset[] };
  return body.datasets ?? [];
}

/**
 * Upload a file to the shared library.
 *
 * The bytes are the request body and the metadata rides in the query string:
 * multipart would force the whole upload through a parser, and base64 in JSON
 * would inflate a 45 MB drawing by a third for no benefit.
 *
 * @returns The stored dataset, including the URL its bytes can be read from.
 */
export async function uploadSharedDataset(options: SharedDatasetUpload): Promise<SharedDataset> {
  const token = options.token.trim();
  if (!token) {
    throw new SharedDatasetError("Add a share API token in Settings before uploading.");
  }
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();

  const query = new URLSearchParams({ filename: options.filename });
  if (options.name?.trim()) query.set("name", options.name.trim());
  if (options.description?.trim()) query.set("description", options.description.trim());
  if (options.visibility) query.set("visibility", options.visibility);
  if (options.tags?.length) query.set("tags", options.tags.join(","));

  const body =
    options.data instanceof Uint8Array
      ? // Copy onto a plain ArrayBuffer: a Uint8Array that is a view into a
        // larger buffer would otherwise send the whole buffer.
        options.data.slice().buffer
      : options.data;

  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/datasets?${query.toString()}`, {
      method: "POST",
      headers: {
        ...authHeaders(token),
        "Content-Type": options.contentType || "application/octet-stream",
      },
      body,
      signal: deadline(options.signal, UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    networkError(error);
  }
  if (!response.ok) throw await failure(response);
  const parsed = (await response.json()) as { dataset?: SharedDataset };
  if (!parsed.dataset) {
    throw new SharedDatasetError("The server accepted the upload but returned no dataset.");
  }
  return parsed.dataset;
}

/**
 * Download a dataset's bytes.
 *
 * The element type is pinned to a plain ArrayBuffer rather than the default
 * ArrayBufferLike, because the vector reader will not accept a view that might
 * be backed by a SharedArrayBuffer.
 *
 * @returns The file contents.
 */
export async function fetchSharedDatasetBytes(
  id: string,
  options: SharedDatasetRequest = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/datasets/${encodeURIComponent(id)}/content`, {
      headers: authHeaders(options.token),
      signal: deadline(options.signal, UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    networkError(error);
  }
  if (!response.ok) throw await failure(response);
  return new Uint8Array(await response.arrayBuffer());
}

/** Remove a dataset. Only its uploader may do this. */
export async function deleteSharedDataset(
  id: string,
  options: SharedDatasetRequest & { token: string },
): Promise<void> {
  const base = requireBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? getShareFetch();
  let response: Response;
  try {
    response = await fetchImpl(`${base}/api/datasets/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: authHeaders(options.token),
      signal: deadline(options.signal, REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    networkError(error);
  }
  if (!response.ok && response.status !== 404) throw await failure(response);
}

/** Human-readable size, for the library listing. */
export function formatDatasetSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
