/**
 * Whether two secrets are equal, without returning at the first differing byte.
 *
 * A host token is the only thing that makes someone the host. Comparing it
 * with `===` can stop early, and a patient caller could learn the matching
 * prefix from how long the check took. The tokens are fixed-length and random,
 * so this is a small risk; the loop still costs nothing next to a Durable
 * Object read.
 */
export function sameSecret(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
