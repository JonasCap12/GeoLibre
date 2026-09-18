// R2 object storage, replacing the FileStorage/S3Storage pair in
// backend/geolibre_server_api.
//
// Keys are unchanged from that implementation -- projects/<id>/versions/<n>.json
// and projects/<id>/thumbnail -- so an existing bucket can be copied into R2
// without rewriting any of them, and the `object_key` column of an imported
// versions table stays correct.

export interface Objects {
  put(key: string, body: ArrayBuffer | Uint8Array | string, contentType: string): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
}

export function objectStorage(bucket: R2Bucket): Objects {
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

    async deleteProject(projectId) {
      // R2 has no recursive delete, so the prefix is listed and removed in
      // batches. Paginated because list() truncates at 1000 keys and a project
      // with a long version history exceeds that.
      const prefix = `projects/${projectId}/`;
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, cursor });
        if (page.objects.length > 0) {
          await bucket.delete(page.objects.map((object) => object.key));
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

export const versionKey = (projectId: string, number: number): string =>
  `projects/${projectId}/versions/${number}.json`;

export const thumbnailKey = (projectId: string): string => `projects/${projectId}/thumbnail`;
