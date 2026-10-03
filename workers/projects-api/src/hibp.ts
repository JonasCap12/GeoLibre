// Breached-password check against Have I Been Pwned's Pwned Passwords range API.
//
// k-anonymity: only the first five hex characters of the password's SHA-1 leave
// the Worker, and the API answers with every suffix sharing that prefix. The
// match happens here, so neither the password nor its full hash is ever sent.
// `Add-Padding: true` makes every response a similar size, so an observer of
// the encrypted response cannot narrow the prefix down from its length.
//
// FAIL-OPEN, deliberately. When the API is slow or down, the password is
// accepted and a warning is logged. The alternative is that an outage at a
// third party stops a six-person team from registering or resetting a
// password, with no workaround but waiting; that is a worse outcome than
// briefly losing one of three checks, since the 15-character minimum and the
// context list in auth-policy.ts still apply. ASVS 5.0 V6.2.12 asks for the
// check, not for availability to depend on it.

export const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";
export const PWNED_TIMEOUT_MS = 2000;

export interface PwnedResult {
  /** True only when the API answered and listed this password. */
  pwned: boolean;
  /** False when the API could not be asked; the caller fails open on that. */
  checked: boolean;
}

export async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * How many times `suffix` appears in a range response.
 *
 * Padding rows carry a count of 0 and must not count as a hit, otherwise
 * every password whose suffix happens to match padding would be refused.
 */
export function rangeCount(body: string, suffix: string): number {
  const wanted = suffix.toUpperCase();
  for (const line of body.split(/\r?\n/)) {
    const [candidate, count] = line.trim().split(":");
    if (candidate?.toUpperCase() === wanted) {
      const value = Number.parseInt(count ?? "0", 10);
      return Number.isFinite(value) ? value : 0;
    }
  }
  return 0;
}

export async function checkPwnedPassword(
  password: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PWNED_TIMEOUT_MS,
): Promise<PwnedResult> {
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${PWNED_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "geolibre-projects-api" },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.warn(`pwned-passwords returned ${response.status}; accepting the password`);
      return { pwned: false, checked: false };
    }
    return { pwned: rangeCount(await response.text(), suffix) > 0, checked: true };
  } catch (error) {
    console.warn("pwned-passwords unreachable; accepting the password", String(error));
    return { pwned: false, checked: false };
  } finally {
    clearTimeout(timer);
  }
}
