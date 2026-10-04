// R2 object storage, replacing the FileStorage/S3Storage pair in
// backend/geolibre_server_api.
//
// Keys are unchanged from that implementation -- projects/<id>/versions/<n>.json
// and projects/<id>/thumbnail -- so an existing bucket can be copied into R2
// without rewriting any of them, and the `object_key` column of an imported
// versions table stays correct.
//
// Deleting through the API does not destroy anything at once. R2 has no object
// versioning, so a dataset or project deleted by mistake, or by someone holding
// a stolen session, used to be gone for good. Its objects now move under
// `trash/<YYYY-MM-DD>/<original key>` and a daily cron (see `scheduled` in
// index.ts) purges whatever has been there longer than the retention window.
// The D1 rows that pointed at them are recoverable with D1 Time Travel for the
// same 30 days, so a deletion can be undone end to end.

export const TRASH_PREFIX = "trash/";
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Objects {
  put(key: string, body: ArrayBuffer | Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  /** Removes an object for good. For cleaning up after a failed write only. */
  delete(key: string): Promise<void>;
  /** Moves an object to the trash; purged after the retention window. */
  trash(key: string): Promise<void>;
  /** Moves every object of a project to the trash. */
  trashProject(projectId: string): Promise<void>;
  /** Deletes trashed objects older than `retentionDays`. Returns how many. */
  purgeTrash(nowMs: number, retentionDays: number): Promise<number>;
}

/** Where `key` goes when trashed on the day `nowMs` falls in (UTC). */
export function trashKey(key: string, nowMs: number): string {
  return `${TRASH_PREFIX}${new Date(nowMs).toISOString().slice(0, 10)}/${key}`;
}

/**
 * Whether a trashed key is past the retention window. A key that does not
 * carry a readable date is kept: purging something unexpected is the one
 * mistake this cannot undo.
 */
export function trashKeyExpired(key: string, nowMs: number, retentionDays: number): boolean {
  const match = /^trash\/(\d{4}-\d{2}-\d{2})\//.exec(key);
  if (match === null) return false;
  const trashedAt = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(trashedAt)) return false;
  return nowMs - trashedAt > retentionDays * DAY_MS;
}

export function objectStorage(bucket: R2Bucket): Objects {
  async function moveToTrash(key: string, nowMs: number): Promise<void> {
    const object = await bucket.get(key);
    if (object === null) return;
    // Streamed, not buffered: a dataset can be tens of megabytes and a Worker
    // has 128 MB. R2 needs the length up front, which FixedLengthStream gives.
    const { readable, writable } = new FixedLengthStream(object.size);
    await Promise.all([
      object.body.pipeTo(writable),
      bucket.put(trashKey(key, nowMs), readable, {
        httpMetadata: object.httpMetadata,
        customMetadata: { ...object.customMetadata, trashedFrom: key },
      }),
    ]);
    // Only after the copy has landed, so a failure leaves the original.
    await bucket.delete(key);
  }

  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } });
    },

    async get(key) {
      const object = await bucket.get(key);
      return object === null ? null : await object.arrayBuffer();
    },

    async delete(key) {
      await bucket.delete(key);
    },

    async trash(key) {
      await moveToTrash(key, Date.now());
    },

    async trashProject(projectId) {
      // R2 has no recursive operation, so the prefix is listed in pages:
      // list() truncates at 1000 keys and a long version history exceeds that.
      const prefix = `projects/${projectId}/`;
      const nowMs = Date.now();
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        for (const object of page.objects) keys.push(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      for (const key of keys) await moveToTrash(key, nowMs);
    },

    async purgeTrash(nowMs, retentionDays) {
      let purged = 0;
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: TRASH_PREFIX, cursor });
        const expired = page.objects
          .map((object) => object.key)
          .filter((key) => trashKeyExpired(key, nowMs, retentionDays));
        if (expired.length > 0) {
          await bucket.delete(expired);
          purged += expired.length;
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return purged;
    },
  };
}

export const versionKey = (projectId: string, number: number): string =>
  `projects/${projectId}/versions/${number}.json`;

export const thumbnailKey = (projectId: string): string => `projects/${projectId}/thumbnail`;
