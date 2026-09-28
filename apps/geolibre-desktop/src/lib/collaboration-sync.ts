/**
 * Fallback ceiling, in bytes, used until a rejection names the live one.
 *
 * This is `MAX_SNAPSHOT_BYTES` from `packages/collab-core/src/session.ts`.
 * It is copied rather than imported: the desktop tsconfig does not include
 * that package, and adding the dependency would touch an upstream lockfile.
 * A test asserts the two numbers stay equal. The relay may still run a lower
 * `COLLAB_MAX_SNAPSHOT_BYTES`; that value arrives as "live sync holds N.N MB"
 * on a `too-large` rejection and replaces this fallback.
 */
export const CLIENT_SNAPSHOT_LIMIT_FALLBACK = 10_000_000;

/**
 * Whether a built snapshot may be sent, or must stay on this machine.
 *
 * Measuring here is what lets sync resume after the user drops a layer,
 * without putting the oversized payload on the wire again to find out.
 */
export function snapshotSyncLimit(learnedLimit: number | null): number {
  return learnedLimit ?? CLIENT_SNAPSHOT_LIMIT_FALLBACK;
}

/**
 * Pull the relay's live ceiling out of a `too-large` message.
 *
 * The relay formats with `toFixed(1)`, which rounds. `8,388,608` prints as
 * `8.4 MB`; rounding that figure back up yields `8,400,000`, which is past
 * the real ceiling, so the next edit is sent and rejected again. The learned
 * value is therefore the smallest byte count that still prints as the figure
 * in the message — never above the true ceiling.
 *
 * @returns The byte ceiling, or null when this message is not that rejection.
 */
export function learnedSnapshotLimit(message: string): number | null {
  const match = /live sync holds (\d+(?:\.\d+)?) MB/.exec(message);
  if (!match) return null;
  const megabytes = Number(match[1]);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return null;
  const printed = match[1];
  const printsAs = (bytes: number): boolean => (bytes / 1_000_000).toFixed(1) === printed;
  let bytes = Math.round(megabytes * 1_000_000);
  while (bytes > 1 && printsAs(bytes - 1)) bytes -= 1;
  return bytes;
}

/**
 * `hold` means do not send. `send` means the project fits and a paused session
 * may broadcast again.
 */
export function snapshotSyncAction(
  byteLength: number,
  learnedLimit: number | null,
): "hold" | "send" {
  return byteLength > snapshotSyncLimit(learnedLimit) ? "hold" : "send";
}

/** Same wording shape as the relay, so the badge can show both numbers before a rejection has arrived. */
export function localTooLargeMessage(byteLength: number, limit: number): string {
  const mb = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;
  return (
    `Project is ${mb(byteLength)}; live sync holds ${mb(limit)}. ` +
    `Load fewer or smaller layers — one CAD layer at a time rather than ` +
    `all of them — or share the project by URL instead.`
  );
}
