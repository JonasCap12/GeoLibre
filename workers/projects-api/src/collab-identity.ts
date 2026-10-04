// The identity issuer for the collaboration relay.
//
// The relay (workers/collab) is members-only on this deployment
// (COLLAB_REQUIRE_IDENTITY): creating or joining a session needs a token that
// proves the person is signed in here. This route mints it for the account the
// bearer belongs to:
//
//   POST /api/collab/identity  ->  { identityToken, expiresAt }
//
// The format is the relay's (packages/collab-core/src/identity.ts), reproduced
// rather than imported so this Worker keeps no dependency on that package:
//
//   <base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, first segment))>
//
// tests/collab-identity.test.ts checks every token this file mints against the
// relay's own verifier.

import { empty, json, requireSession, type Scope } from "./context";
import { ApiError } from "./model";

/**
 * How long a token is good for. The app fetches one before each connect and
 * reuses it for automatic reconnects, so it has to outlast a working session;
 * a leaked one only lets its holder in as this account until it lapses.
 */
export const COLLAB_IDENTITY_TTL_SECONDS = 12 * 60 * 60;

export interface CollabIdentityPayload {
  provider: string;
  userId: string;
  username: string;
  /** Epoch seconds. */
  exp: number;
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Signs a payload the way the relay's verifyIdentityToken expects. */
export async function signCollabIdentity(
  payload: CollabIdentityPayload,
  secret: string,
): Promise<string> {
  const encoded = base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(encoded)));
  return `${encoded}.${base64Url(signature)}`;
}

export async function collabIdentityRoute(
  scope: Scope,
  path: readonly string[],
  method: string,
): Promise<Response | null> {
  if (path.length !== 2 || path[0] !== "collab" || path[1] !== "identity") return null;
  if (method !== "POST") return empty(405);
  const { account } = await requireSession(scope);
  const secret = scope.env.COLLAB_IDENTITY_SECRET?.trim() ?? "";
  if (secret === "") {
    throw new ApiError(503, "collaboration sign-in is not configured on this deployment");
  }
  const exp = Math.floor(Date.now() / 1000) + COLLAB_IDENTITY_TTL_SECONDS;
  const identityToken = await signCollabIdentity(
    { provider: "geolibre", userId: account.id, username: account.username ?? account.id, exp },
    secret,
  );
  return json({ identityToken, expiresAt: new Date(exp * 1000).toISOString() });
}
