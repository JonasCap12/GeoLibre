// How many saved versions a project keeps.
//
// Every save of a project (the app autosaves) is a new version: a D1 row and
// a whole copy of the document in R2. Nothing ever removed old ones, so one
// workspace autosaving a 7 MB document every couple of minutes filled the
// bucket's 5 GB with 870 copies nobody could reach: the app only ever opens
// the newest. Each save now drops the versions older than the newest
// GEOLIBRE_VERSION_LIMIT, for good rather than into the trash, since the
// trash would hold them for another 30 days.

import type { Objects } from "./storage";

/** Versions kept per project when GEOLIBRE_VERSION_LIMIT is unset. */
export const DEFAULT_VERSION_LIMIT = 10;

/**
 * Delete a project's versions older than the newest `keep`.
 *
 * Rows go first, then objects, as a project deletion does: an object left
 * behind is invisible, whereas a row whose object is gone is a 404.
 *
 * Args:
 *   db: The D1 database.
 *   objects: R2 storage.
 *   projectId: The project.
 *   newest: The number of the version just saved.
 *   keep: How many of the newest versions stay; at least 1.
 *
 * Returns:
 *   How many versions were removed. Throws after trying every object if any
 *   object delete failed (the rows are already gone, so the next save does
 *   not retry those objects).
 */
export async function pruneVersions(
  db: D1Database,
  objects: Pick<Objects, "delete">,
  projectId: string,
  newest: number,
  keep: number,
): Promise<number> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`version limit must be at least 1, got ${keep}`);
  }
  const cutoff = newest - keep;
  if (cutoff < 1) return 0;
  const { results } = await db
    .prepare(`DELETE FROM versions WHERE project_id = ? AND number <= ? RETURNING object_key`)
    .bind(projectId, cutoff)
    .all<{ object_key: string }>();
  const outcomes = await Promise.allSettled(results.map((row) => objects.delete(row.object_key)));
  const failure = outcomes.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
  );
  if (failure) throw failure.reason;
  return results.length;
}
