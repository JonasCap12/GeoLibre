# GeoLibre projects and identity API

This document defines version 1 of the HTTP contract used by GeoLibre's
Project Gallery and **Project → Share** flow. A compatible server may use any
implementation or storage engine. The reference implementation lives in
`backend/geolibre_server_api`.

## Conventions

- The base URL is configured with `GEOLIBRE_SHARE_URL` at container runtime
  (or `VITE_GEOLIBRE_SHARE_URL` at build time).
- JSON request and response bodies use `application/json` and camel-case keys.
- Dates are UTC ISO 8601 strings.
- Authenticated endpoints accept a personal API token in
  `Authorization: Bearer <token>`.
- Error responses are JSON objects with an `error` string. `401` means a
  missing, invalid, or expired token; `403` means the authenticated principal
  lacks permission; `404` deliberately covers both a missing project and a
  project the caller may not discover; `409` is a uniqueness conflict; `422`
  is malformed input; and `429` is rate limiting.
- Servers should send `Cache-Control: public, max-age=3600` on immutable raw
  project versions and may use `ETag`/conditional requests. Private responses
  must use `Cache-Control: private, no-store`.
- CORS deployments must allow `Authorization` and `Content-Type` from the
  GeoLibre web origin. Native desktop requests do not depend on CORS.

## What the reference server leaves to the operator

Three parts of the contract above are deliberately not implemented in
`backend/geolibre_server_api`, and an operator exposing it publicly has to
supply them:

- **Rate limiting.** `429` is in the error vocabulary, but no route returns it.
  `POST /api/auth/token` and `POST /api/accounts` are unauthenticated and run
  scrypt on every call, so without a limiter in front they allow password
  brute-forcing, username enumeration through the `409`/`401` distinction, and
  a cheap CPU-burn. Put a reverse proxy or WAF limit on both, keyed by client IP
  and by username.
- **Token expiry.** `401` covers an expired token, but tokens issued here do not
  carry an expiry and stay valid until `DELETE /api/auth/token` revokes them.
- **A request-size limit.** The server rejects an oversized *declared*
  `Content-Length` before reading the body, but a chunked or HTTP/2 request
  declares no length and is parsed in full before the per-route limit applies.
  Cap request size at the proxy as well.

All three are contract-level capabilities a compatible server may implement;
the reference implementation is a correctness baseline, not a hardened
deployment.

## Limits

| Field | Limit |
| --- | ---: |
| project title (derived from the uploaded project) | 100 Unicode code points |
| username | 3–39 lowercase ASCII letters, digits, or hyphens |
| slug | 1–100 lowercase ASCII letters, digits, or hyphens |
| description | 2,000 Unicode code points |
| tags | 20 tags, 40 Unicode code points each |
| project document | 50 MiB UTF-8 JSON |
| thumbnail | 5 MiB; PNG, JPEG, or WebP |
| `limit` | default 24, maximum 100 |

Servers may configure a smaller upload limit, but must return `413` and an
`error` explaining that limit.

## Visibility

- `public`: discoverable in the public listing and readable without auth.
- `unlisted`: omitted from public listings, but readable by anyone holding its
  URL. It appears in the owner's authenticated listing.
- `private`: readable and mutable only by its owner. Raw and thumbnail URLs
  require the same Bearer token as the metadata endpoint.

Changing visibility affects every version immediately. A raw URL is therefore
not a capability URL for a private project.

## Identity

### `POST /api/accounts`

Creates an account and returns a token once. This endpoint may be disabled when
an installation delegates identity to an external provider.

```json
{
  "username": "ada",
  "password": "correct horse battery staple"
}
```

Response `201`:

```json
{
  "account": {"id": "uuid", "username": "ada", "createdAt": "2026-08-03T12:00:00Z"},
  "token": "secret-token"
}
```

### `POST /api/auth/token`

Exchanges account credentials for a personal API token.

```json
{"username": "ada", "password": "correct horse battery staple"}
```

Response `200` has the same shape as account creation. Tokens are opaque and
must be stored hashed by the server.

### `DELETE /api/auth/token`

Revokes the presented Bearer token. Response: `204`.

### `GET /api/users/me`

Returns the account associated with the token:

```json
{"user": {"id": "uuid", "username": "ada", "createdAt": "2026-08-03T12:00:00Z"}}
```

An identity provider may create accounts without a username. Project creation
for such an account must return `400` with an error containing the stable,
case-insensitive sentinel text `username required`. Existing clients recognize
that phrase and direct the user to account settings.

## Projects

### Project representation

```json
{
  "id": "uuid",
  "username": "ada",
  "slug": "wetlands",
  "title": "Wetlands",
  "description": "",
  "visibility": "public",
  "thumbnailUrl": "/api/projects/uuid/thumbnail",
  "views": 12,
  "forkCount": 0,
  "versionCount": 1,
  "featured": false,
  "createdAt": "2026-08-03T12:00:00Z",
  "updatedAt": "2026-08-03T12:00:00Z",
  "tags": [],
  "rawJsonUrl": "https://example.org/ada/wetlands.geolibre.json",
  "projectUrl": "https://example.org/ada/wetlands",
  "viewerUrl": "https://example.org/?project=https%3A%2F%2Fexample.org%2Fada%2Fwetlands.geolibre.json"
}
```

URLs are absolute except that `thumbnailUrl` may be root-relative. Consumers
must resolve a relative thumbnail URL against the server base URL. Unknown
fields must be ignored.

### `POST /api/projects`

Requires auth. Creates a project and its first immutable version.

```json
{
  "filename": "Wetlands.geolibre.json",
  "content": "{\"version\":\"1.0\", ...}",
  "visibility": "public"
}
```

`content` is a string containing a valid GeoLibre project JSON document.
`filename` supplies a fallback title/slug; the project document's non-empty
title is authoritative. `visibility` is required and is `public`, `unlisted`,
or `private`.

Response `201`:

```json
{"project": {"id": "uuid", "username": "ada", "slug": "wetlands", "projectUrl": "...", "viewerUrl": "...", "rawJsonUrl": "..."}}
```

The `project` object is the full project representation. In particular,
`projectUrl` and `rawJsonUrl` are required because the current client treats a
successful response without them as invalid.

### `GET /api/projects`

Returns a page in newest-updated-first order:

```json
{"projects": [], "limit": 24, "offset": 0, "total": 0}
```

Query parameters:

- `limit`: integer page size.
- `offset`: non-negative number of matching records to skip.
- `featured=true`: return featured projects only.
- `mine=true`: return the caller's own projects, including unlisted and private
  ones. Requires auth; without a valid token this is `401`.

Only public projects are returned unless `mine=true` is set. An Authorization
header does not broaden a public listing by itself. Invalid pagination is `422`.

### `GET /api/users/{username}/projects`

Returns `{"projects": [...]}` owned by `{username}`, in newest-updated-first
order. Auth is optional and decides the breadth of the result: when the token
identifies `{username}`, the listing includes their unlisted and private
projects; every other caller, authenticated or not, sees only that user's public
projects. The current client first resolves its username through
`GET /api/users/me`, then calls this route.

A non-owner therefore gets a filtered `200`, not a `403` — the listing narrows
rather than refusing, which keeps a user's existence from being probed through
the status code.

### `GET /api/projects/{id}`

Returns `{"project": <project>}` if visible to the caller.

### `PATCH /api/projects/{id}`

Requires ownership. Accepted fields are `title`, `description`, `visibility`,
and `tags`. Response: `{"project": <project>}`.

### `PUT /api/projects/{id}/content`

Requires ownership. Creates a new immutable version.

```json
{"content": "{\"version\":\"1.0\", ...}"}
```

Response `201`: `{"project": <project>, "version": <positive integer>}`.

### `DELETE /api/projects/{id}`

Requires ownership. Deletes metadata and stored objects. Response: `204`.

### `GET /api/projects/{id}/activity`

Requires ownership. Returns the project's activity log, newest first, capped
at 100 entries:

```json
{"activity": [
  {"id": "…", "action": "visibility_change", "actorId": "…",
   "details": {"before": "private", "after": "public"}, "createdAt": "…"},
  {"id": "…", "action": "open", "actorId": null,
   "details": {"date": "2026-08-21", "count": 40}, "createdAt": "…"}
]}
```

Actions and their `details`: `version_save` (`version`), `fork`
(`forked_project_id`), `visibility_change` (`before`, `after`), `fetch` of
the raw JSON (`version`) and `open` of the project page. `actorId` is the
acting account, or `null` for an anonymous visitor. Anonymous `open` and
`fetch` events are **never stored per visitor**: they are aggregated into one
row per action and UTC day carrying a `count`, and no IP address or other
visitor fingerprint is recorded. Rows are pruned after
`GEOLIBRE_ACTIVITY_RETENTION_DAYS` (default 90) the next time the project logs
an event. The log is visible only to the owner and never appears in listings.

### `DELETE /api/projects/{id}/activity`

Requires ownership. Deletes every activity row for the project. Response: `204`.

### `POST /api/projects/{id}/forks`

Requires auth. Creates a new project owned by the caller from the visible
source's latest content. The request body is **optional**: `{"visibility": ...}`
selects the fork's visibility, and omitting the body entirely (the common "fork
this project" call) must behave as `{"visibility":"private"}` rather than
returning `422`. Responds `201` with `{"project": <project>}`. The source
`forkCount` increases atomically.

### Raw project and website-compatible routes

- `GET /{username}/{slug}.geolibre.json` returns the latest project document
  with `Content-Type: application/json`.
- `GET /api/projects/{id}/versions/{version}` returns an immutable historical
  document.
- `GET /{username}/{slug}` may return an HTML project page or redirect to the
  configured GeoLibre viewer. It is the `projectUrl` advertised by the API.

Every successful read of the latest raw document may increment `views`; servers
must not count failed or unauthorized reads.

### Thumbnails

`PUT /api/projects/{id}/thumbnail` requires ownership and accepts the image
bytes with their image content type. `GET /api/projects/{id}/thumbnail` follows
project visibility. `DELETE` removes it. Upload and delete responses are `204`.

## Self-hosted account extensions

The Cloudflare Worker in `workers/projects-api` adds invite-only accounts,
session management and an admin console on top of the routes above. They are
optional, additive extensions of version 1: a server without them stays
compatible, and the app only calls them when it is built with
`VITE_GEOLIBRE_SELFHOST_AUTH`. The Python reference server does not implement
them. Design notes and the standards they follow are in
[`selfhost-auth.md`](selfhost-auth.md).

Every route under `/api/accounts`, `/api/account`, `/api/auth`, `/api/invites`,
`/api/admin` and `/api/users/me` answers with `Cache-Control: no-store`.
JSON bodies on these routes are capped at 16 KiB (`413` above that). A `429`
carries `Retry-After` in seconds.

Every response from this Worker, including errors and `OPTIONS`, also sends
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox`,
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `Strict-Transport-Security`, and
`Cross-Origin-Resource-Policy: cross-origin`. Nothing this API serves is a
page. `cross-origin` is what lets the app, on another host, read a download.

### Changes to existing identity routes

- `POST /api/accounts` additionally requires `invite` (the token from the
  invite link) and, when the deployment enables Cloudflare Turnstile,
  `turnstileToken`. The account takes the invite's email address, already
  verified. A new password must be 8–1024 characters, must not contain the
  username, the name part of the email or the product name, must not be a
  common or predictable password (`password is too common or predictable`),
  must reach a minimum estimated strength (`password is too weak; make it
  longer or less predictable`), and must not appear in a known breach corpus;
  `422` names the reason. The rules are in
  `workers/projects-api/src/password-strength.ts`.
- `POST /api/auth/token` accepts an email address in `username`; the key is
  unchanged. Unknown account and wrong password are the same `401`. A disabled
  account is `403` once the password is right. Passwords set under earlier
  rules keep working; the rules apply when a password is set.
- Tokens now expire: 30 days after issue and after 7 days unused (both
  configurable). An expired token is `401`, like a revoked one.
- When the account has two-factor authentication on, a correct password to
  `POST /api/auth/token` answers `200` `{"mfaRequired": true, "mfaTicket": "…"}`
  with no `token`; the client finishes at
  [`POST /api/auth/mfa`](#two-factor-authentication). Accounts without
  two-factor are unchanged. A client that predates this sees a `200` without a
  token and must report it as an error rather than store nothing.

### Invites

`POST /api/invites` (admin) — `{"email": "…"}`. Mails a single-use link valid
for 72 hours. Response `201` `{"ok": true}`; `503` when the deployment cannot
send mail.

`POST /api/invites/inspect` (no bearer) — `{"invite": "…"}`. Read-only: does
not spend the invite. Response `200` `{"email": "a***@example.com",
"expiresAt": "…"}` with the address masked; `403` for an invalid, used or
expired invite.

### Password and email

`POST /api/auth/password` — `{"currentPassword": "…", "password": "…"}`. Signs
out every session, then returns a fresh one: `200` `{"token": "…"}`. `401` for
a wrong current password. With two-factor on, the body also needs `"code"` (a
current authenticator code or an unused recovery code): `403` `two-factor code
required` without it, `403` `two-factor code is incorrect` for a wrong one.

`POST /api/auth/reset-request` (no bearer) — `{"email": "…",
"turnstileToken": "…"}`. Always `200` `{"ok": true}`, whether or not the
address has an account.

`POST /api/auth/reset-confirm` (no bearer) — `{"token": "…", "password": "…",
"turnstileToken": "…"}`. Sets the password, signs out every session, and spends
any other reset link and pending two-factor sign-in step for the account.
`200` `{"ok": true}`; `403` for an invalid or expired link (30 minutes).

`POST /api/auth/email` — `{"email": "…", "currentPassword": "…"}`. Mails a
confirmation link to the new address and a notice to the old one; the address
changes only when the link is used. `202` `{"ok": true}`; `403` for a wrong
current password; `409` when another account has the address. Takes `"code"`
under the same rule as the password change.

`POST /api/auth/email-confirm` (no bearer) — `{"token": "…"}`. `200`
`{"ok": true}`; `403` for an invalid or expired link (24 hours).

### Account and sessions

`GET /api/account` — the signed-in account with the fields the app needs to
draw its menus:

```json
{"account": {"id": "uuid", "username": "ada", "createdAt": "…",
  "email": "ada@example.com", "emailVerifiedAt": "…", "isAdmin": false,
  "mfaEnabled": true, "recoveryCodesLeft": 9,
  "mfaRequiredBy": null, "mfaEnrollmentRequired": false}}
```

`isAdmin` only decides what the app shows; every admin route checks again.
`recoveryCodesLeft` is `0` when two-factor is off.

Two-factor is required of every account on this deployment. `mfaRequiredBy`
is the deadline for an account that has not turned it on (null once it has, or
when the requirement is off), and `mfaEnrollmentRequired` is true once that
deadline has passed. From then on every route other than `GET /api/account`,
`GET /api/users/me` and `/api/auth/*` answers
`403 {"error": "two-factor authentication is required for this account; turn it on to continue"}`.

Deleting a project or dataset moves its stored objects to a trash prefix kept
for 30 days rather than destroying them; the response is unchanged (`204`).

`GET /api/auth/sessions` — the account's live sessions, newest first:

```json
{"sessions": [{"id": "64-hex digest", "createdAt": "…", "lastUsedAt": "…",
  "expiresAt": "…", "userAgent": "…", "ip": "…", "current": true}]}
```

`id` is the stored digest, never the token. `lastUsedAt` is updated at most
once an hour.

`DELETE /api/auth/sessions` signs out every session, including the caller's.
`DELETE /api/auth/sessions/{id}` signs out one. Both `204`; `404` for an id the
account does not own.

### Two-factor authentication

Time-based one-time passwords (RFC 6238: SHA-1, six digits, 30-second step)
plus ten single-use recovery codes. Every route here except `POST /api/auth/mfa`
needs the bearer. A deployment without `MFA_ENCRYPTION_KEY` answers `503`
`two-factor authentication is not configured on this deployment`.

`POST /api/auth/mfa` (no bearer) — `{"ticket": "…", "code": "…"}`. Finishes a
sign-in that `POST /api/auth/token` paused. `code` is the six-digit code or a
recovery code (case, spaces and dashes are ignored). Response `200` has the
same shape as `POST /api/auth/token`. Errors:

| Status | Error | Meaning |
| --- | --- | --- |
| `401` | `two-factor code is incorrect` | Try again with the same ticket |
| `401` | `sign-in step expired; sign in again` | The ticket is unknown, used, older than 5 minutes or has had 5 wrong codes |
| `403` | `too many wrong two-factor codes; wait 15 minutes or use a recovery code` | 10 wrong codes in a row; after that one authenticator code per 15 minutes. Recovery codes are still accepted, and an admin reset clears the count |
| `429` | — | Per-IP and per-account limits |

A code is accepted once: a TOTP step that has been used, even within its
window, is refused.

`POST /api/auth/mfa/setup` — `{"currentPassword": "…"}`. Starts setup and
returns `200` `{"secret": "BASE32…", "otpauthUri": "otpauth://totp/…"}`. The
secret is not active yet. `409` when two-factor is already on.

`POST /api/auth/mfa/enable` — `{"code": "…"}`. A code from the new secret
turns two-factor on, signs out every other session of the account, and
returns `200` `{"recoveryCodes": ["XXXX-XXXX-XXXX-XXXX-XXXX-XXXX",
…]}`, the only time the codes are shown. `403` for a wrong code; `409` without
a pending setup.

`POST /api/auth/mfa/recovery-codes` — `{"currentPassword": "…", "code": "…"}`.
Replaces every recovery code; `200` `{"recoveryCodes": […]}`.

`POST /api/auth/mfa/disable` — `{"currentPassword": "…", "code": "…"}`. Turns
two-factor off, deletes the recovery codes and signs out every other session.
`200` `{"ok": true}`.

The last two are `403` for a wrong password or code and `409` when two-factor
is off.

### Administration

Admins are the usernames listed in `GEOLIBRE_ADMIN_USERNAMES`. Every route here
is `403` for anyone else, and `403` `admin accounts must turn on two-factor
authentication first` for an admin who has not.

| Route | Effect |
| --- | --- |
| `GET /api/admin/invites` | `{"invites": [{id, email, status, createdAt, expiresAt, usedAt, createdBy, usedBy}]}`; `status` is `pending`, `used` or `expired` |
| `DELETE /api/admin/invites/{id}` | Revokes an unused invite. `204`; `409` if used |
| `POST /api/admin/invites/{id}/resend` | Replaces the invite with a fresh link and 72 hours. `201` |
| `GET /api/admin/accounts` | `{"accounts": [{id, username, email, emailVerifiedAt, createdAt, disabledAt, isAdmin, mfaEnabled, sessions, lastSeenAt}]}` |
| `POST /api/admin/accounts/{id}/disable` | Blocks sign-in and ends every session. `204`; `409` for the last enabled admin |
| `POST /api/admin/accounts/{id}/enable` | `204` |
| `DELETE /api/admin/accounts/{id}/sessions` | Ends every session of that account. `204` |
| `DELETE /api/admin/accounts/{id}/mfa` | Turns two-factor off for a user who lost their device, clears the wrong-code lockout and ends their sessions. `204` |
| `GET /api/admin/events?limit=&offset=` | The audit log, newest first (`limit` default 100, maximum 500): `{"events": [{id, kind, accountId, username, ip, userAgent, createdAt, detail}]}` |

The audit log never holds a password, token or one-time code. `detail` carries
only masked addresses and the acting admin's username.

### Collaboration identity

`POST /api/collab/identity` (bearer) mints the token the members-only relay
asks for before creating or joining a session. Response `200`:

```json
{"identityToken": "<payload>.<hmac>", "expiresAt": "2026-10-04T12:00:00.000Z"}
```

The token is HMAC-SHA256 over a JSON payload (`provider`, `userId`,
`username`, `exp`), valid for 12 hours, and signed with
`COLLAB_IDENTITY_SECRET` — the same secret as the relay. `401` without a
session. `503` `collaboration sign-in is not configured on this deployment`
when the secret is unset. The value is not stored.

### Dataset downloads

`GET /api/datasets/{id}/content` sends the bytes as an attachment. The
`Content-Disposition` value follows RFC 6266: `filename` is an ASCII fallback
(quotes, backslashes and control characters removed), and `filename*` carries
the original name, including Vietnamese, as UTF-8 percent-encoding. A name is
never written into the header raw, because a Worker rejects a non-ByteString
header value.

## Compatibility

The API is additive within version 1. Implementations must not repurpose fields
or narrow visibility rules. New optional fields and endpoints may be added.
Breaking changes require a new `/api/v2` namespace. The conformance baseline is
the frontend tests for `share-geolibre.ts` and `share-gallery.ts`, plus the
reference server's API tests.
