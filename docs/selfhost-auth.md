# Self-hosted accounts: design notes

How the invite-only accounts of a self-hosted deployment (`workers/projects-api`
plus the app built with `VITE_GEOLIBRE_SELFHOST_AUTH`) are put together, and why.
The HTTP contract is in [`server-api.md`](server-api.md#self-hosted-account-extensions);
deployment steps are in [`workers/projects-api/README.md`](../workers/projects-api/README.md).

The target is OWASP ASVS 5.0 Level 2 (chapters V6 Authentication, V7 Session
Management, V16 Security Logging) and NIST SP 800-63B-4 for passwords. The
deployment it was written for is a team of about six, invited by an admin.
Where the design falls short of Level 2 it says so in
[Known gaps](#known-gaps-against-asvs-level-2).

## Token transport: bearer, not cookies

Sessions are opaque bearer tokens sent in `Authorization`, stored by the app in
`desktopSettings.shareToken` (the same slot the Share dialog already used, so
there is one token store, not two). The server keeps only a SHA-256 digest.

A cookie would be the textbook choice for a browser session, and it is not used
here because:

- The app (`geolibre-web.<account>.workers.dev`) and the API
  (`geolibre-projects-api.<account>.workers.dev`) are different *sites*:
  `workers.dev` is on the Public Suffix List. An `HttpOnly` session cookie set
  by the API would be a third-party cookie, which browsers increasingly block.
- The desktop app (Tauri) and the Jupyter widget call the same API with a
  bearer and have no shared cookie jar with the browser.

The cost is that script running in the page can read the token. The mitigations
are a strict CSP (no inline script, a short host allowlist in
`apps/geolibre-desktop/public/_headers`), short session lifetimes, a session list
the user can prune, and server-side revocation. Moving the app and API under one
custom domain would make a same-site `HttpOnly` cookie possible later.

## Accounts and invites

There is no open registration. An admin sends an invite to an email address;
the link carries a 256-bit single-use token in the URL **fragment**
(`/register#invite=…`), which is never sent to a server and so never lands in
request logs. Links mailed before this change used `?invite=`; the app still
reads that form. Either way the app moves the token into memory and removes it
from the address bar with `history.replaceState` before rendering.

Opening the link does not spend it: the page calls `POST /api/invites/inspect`,
which is read-only, so a mail scanner that follows links cannot burn the
invite. Only `POST /api/accounts` consumes it, and the account takes the
invite's address as already verified, because receiving the invite proved
control of the mailbox. Invites last 72 hours; password-reset links 30
minutes; email-change links 24 hours.

Accounts created before invites existed may have no email address. They keep
signing in with username and password; they cannot use password reset until
they add an address from **Account & security**.

Sign-in accepts a username or an email address in the same field. Every
failure that happens before the password is checked (unknown name, unknown
address, wrong password) is the same `401`, and an unknown account still pays
the full scrypt cost so timing does not reveal which names exist. A disabled
account is reported only after the correct password.

## Passwords

Following OWASP ASVS 5.0 V6.2 and NIST SP 800-63B-4. The rules live in one
file, `password-strength.ts`, kept as two byte-identical copies (the Worker
enforces it, the app shows it live) and pinned by
`tests/password-strength.test.ts`:

- **At least 8 characters**, at most 1024 (ASVS 6.2.1). NIST's 15-character
  floor applies to a password that is the *only* factor; this deployment
  offers two-factor to everyone and requires it for admins, and the strength
  rule below stops short passwords from also being simple ones.
- **No composition rules** ("must contain a symbol") and no forced periodic
  change. They push people to `Matkhau@123`.
- **Refused outright:** the username, the part of the email before `@` or
  "geolibre" anywhere in the password; a common password or a common base word
  with only digits and symbols around it (`Password123!`, `matkhau@2026`);
  sequences, keyboard runs and repetition (`12345678`, `qwertyui`,
  `abababab`).
- **Minimum strength "Fair".** The estimate is length times the bits per
  character of the character classes used, with repeated and sequential
  characters counting a quarter. Eight random lowercase letters sit at the
  threshold, so a short password needs some variety, while a passphrase of
  plain words (`correct horse battery staple`) passes without symbols.
- **Breach corpus:** finally, the password must not appear in Have I Been
  Pwned.
- Every form that sets a password shows a strength bar and the rules as a
  live checklist, plus a match indicator on the confirmation field. The rules
  apply when a password is *set*; existing passwords keep signing in.
- The breach check uses the k-anonymity range API: only the first five hex
  characters of the SHA-1 leave the Worker, with `Add-Padding: true` so the
  response size does not reveal the match count. It has a 2-second timeout and
  **fails open**: if HIBP is unreachable the password is accepted and the
  outage is logged. Failing closed would let a third-party outage stop the team
  from resetting passwords, which is worse for a six-person deployment than an
  occasional unchecked password that still passed every other rule.
- Pasting and password managers are allowed; every field carries the right
  `autocomplete` value and a show/hide toggle.

Hashes are scrypt with a version prefix. `scrypt$` (N=2^14, r=8, p=1) is what
the Python reference server writes. New hashes are `scrypt2$` (N=2^14, r=8,
p=5), one of OWASP's listed equivalents to its recommended floor. The 128 MiB
variant does not fit a Worker isolate's memory; raising `p` costs CPU only.
Measured under `wrangler dev`: about 67 ms per `scrypt$` call and 333 ms per
`scrypt2$` call, so `cpu_ms` is raised to 2000. A successful sign-in with an
old hash rehashes it. The trade-off: the Python server cannot verify
`scrypt2$`, so exporting the table back to it would strand rehashed accounts.

## Sessions

- A token expires 30 days after issue (absolute) and after 7 days without use
  (idle). Both are `vars` in `wrangler.jsonc`. Tokens issued before expiry
  columns existed are judged by their `created_at`.
- `last_used_at` is written at most once an hour per token, to keep D1 writes
  off the hot path. The idle timeout is therefore accurate to about an hour.
- Expired rows are deleted lazily when the account next signs in.
- Each session records a truncated User-Agent and the client IP at issue, so
  **Account & security** can list devices and revoke one, or all.
- Changing or resetting the password ends every session; a password change
  returns a fresh token for the device that made it.
- When any authenticated request comes back `401`, the app confirms with
  `GET /api/account` and, if the token is really dead, clears it and returns to
  the sign-in screen with a notice instead of failing request by request.

## Two-factor authentication

The second factor is a TOTP authenticator app (RFC 6238), with recovery codes
for a lost phone. It is **required of every account**:

- **Members** get `GEOLIBRE_MFA_GRACE_DAYS` (7) from `GEOLIBRE_MFA_REQUIRED_FROM`,
  or from their own account's creation if later, to turn it on. Until then the
  app shows a reminder with the date; after it, every route except those
  needed to turn the factor on (`GET /api/account`, `/api/auth/*`) answers
  `403 two-factor authentication is required for this account`, and the app is
  replaced by the setup screen. Removing `GEOLIBRE_MFA_REQUIRED_FROM` from
  `wrangler.jsonc` turns the requirement off. The policy is `mfaDeadline` and
  `mfaEnrollmentRequired` in `auth-policy.ts`.
- **Admins** get `403` from every admin route until they turn it on, deadline
  or not. The Administration area says so instead of showing empty tabs.

- **Algorithm.** HMAC-SHA-1, six digits, 30-second step, and one step either
  side for clock drift. SHA-1 is what every authenticator app supports by
  default; its collision weakness does not apply to HMAC. Implemented on
  WebCrypto in `totp.ts`, no new dependency, and checked against the RFC 6238
  and RFC 4226 test vectors.
- **One use per code.** The account stores the last accepted time step, and
  a code is accepted only for a later step. The update is conditional, so two
  requests racing with the same code cannot both pass.
- **Secret at rest.** The 160-bit secret is sealed with AES-256-GCM under
  `MFA_ENCRYPTION_KEY` (a Worker secret, 32 random bytes), with the account id
  as associated data so a sealed value copied to another row does not open.
  A D1 export alone does not reveal any secret. Without the key, the MFA
  routes answer `503`, which locks admins out of admin routes, so the key must
  be set before deploying.
- **Enrolment.** Setup needs the current password and keeps the new secret
  *pending*. The QR code is drawn in the browser from the `otpauth://` URI
  (`qrcode.react`, already a dependency), so the secret is never sent to a
  QR service. Two-factor turns on only after the first correct code, which
  proves the app saved the secret.
- **Recovery codes.** Ten codes of 120 random bits
  (`XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`), shown once, stored as SHA-256, each
  usable once. ASVS 5.0 V6.5.2 allows a plain hash only above 112 bits; a
  shorter code would need a slow hash per stored code on every attempt.
  Regenerating replaces all ten. Using one sends a notice email.
- **Sign-in.** A correct password on an account with two-factor returns a
  ticket instead of a token. The ticket is a 256-bit random value stored as a
  digest, valid for 5 minutes, single-use, and good for 5 wrong codes; then the
  password is needed again. The ticket is a new table, `mfa_tickets`, not
  another `auth_actions` kind, because it has an attempt counter and is
  deleted on a schedule the email links do not share.
- **Guessing.** Codes are limited per account (5 a minute) as well as per IP,
  so minting fresh tickets from many addresses does not buy more guesses.
  After 10 wrong codes in a row, authenticator codes are taken only once per
  15 minutes until one is right (or an admin resets two-factor). Recovery
  codes are always accepted. It is a cooldown rather than a lockout: a hard
  lock would let anyone holding a leaked password lock the owner out for
  good, and would strand the only admin.
- **Factor changes end other sessions.** Turning two-factor on or off signs
  out every other session of the account, so a session someone else opened
  with the password alone does not outlive the change. Changing or resetting
  the password also spends any other reset link and any pending sign-in step.
- **Re-authentication.** Changing the password or email, regenerating
  recovery codes and turning two-factor off need the current password *and*
  a current code (ASVS V7.5.1).
- **Admin reset.** For a lost phone with no codes left, an admin can turn
  two-factor off for an account. This also ends its sessions and mails the
  owner. If the *only* admin loses both their phone and their recovery codes
  there is no one to reset them; the operator clears the `mfa_*` columns for
  that account directly in D1.
- **Older clients** that do not know the ticket see a `200` without a token
  and report "The server did not return a token". Members without two-factor
  are unaffected.

## Bot defence and rate limits

Cloudflare Turnstile guards the three unauthenticated routes that send mail or
create accounts: registration, reset request and reset confirmation. The widget
renders explicitly with a distinct `action` per form, and the Worker's
siteverify call checks `success`, `hostname` and `action`, and sends
`remoteip` and an `idempotency_key`. Siteverify **fails closed** (`503`):
these routes send mail, and the check costs the user one retry.

Turnstile is deliberately **not** required on `POST /api/auth/token`. The
desktop app runs on `tauri.localhost`, a hostname a Turnstile widget cannot be
issued for, and requiring it would lock desktop users out of sign-in. Sign-in
is instead throttled twice: per client IP (10 per minute) and per account
(5 per minute, keyed on the normalised username or email). There is no hard
lockout after N failures, because a lockout lets anyone lock a colleague out.
The desktop Settings form does not offer account creation; it tells the user to
open the invite link in a browser.

A `429` carries `Retry-After`. Cloudflare's rate-limit binding does not report
when its window resets, so the value is the window length (60 seconds).

When `TURNSTILE_SECRET_KEY` is not set the check is skipped with a warning,
like the other optional bindings, so local development works without it.

## Email

Reset mail, password-changed notices, email-change confirmations and new-device
notices are sent with `ctx.waitUntil`, after the response. For reset requests
this also closes a timing channel: the branch with a real account no longer
waits for the mail provider, so both branches answer in the same time with the
same body.

A sign-in counts as a new device when its User-Agent, with version numbers
blanked, has never appeared on an earlier successful sign-in for that account.
IP is ignored on purpose; phones change address on every network. An account's
first recorded sign-in sends nothing, so deploying this does not mail the whole
team at once.

Changing the address requires the current password, mails a single-use link to
the new address and a notice to the old one, and only writes the new address
once the link is used.

## Administration

Admins are the usernames in `GEOLIBRE_ADMIN_USERNAMES`. `GET /api/account`
returns `isAdmin` so the app can show the **Administration** dialog; every
admin route checks again on the server. Admins can send, resend and revoke
invites, list accounts, disable or re-enable an account (which also ends its
sessions), end every session of an account, and reset an account's two-factor.
The last enabled admin cannot be disabled. Every admin route requires the
admin to have two-factor on.

## Audit log

`auth_events` records sign-in success and failure, sign-out, password change,
reset request and completion, invite creation, use and revocation, email
change, session revocation, account disable/enable, and two-factor changes
(on, off, wrong code, recovery code used, codes regenerated, admin reset), with IP and
User-Agent. It never stores a password, token or one-time code. A failed
sign-in records the name that was typed, truncated, and nothing else. Addresses
in `detail` are masked. Rows older than `GEOLIBRE_ACTIVITY_RETENTION_DAYS` (the
same setting as the project activity log) are pruned whenever a new event is
written. Admins read it in the **Activity** tab.

## Members-only collaboration

The relay (`workers/collab`, `wrangler.selfhost.jsonc`) sets
`COLLAB_REQUIRE_IDENTITY=1`. Creating a session and joining one, including as
the host, need an identity token from `POST /api/collab/identity`. The token
lasts 12 hours and is checked with HMAC-SHA256. A request that omits `Origin`
still passes the origin allowlist (`isAllowedOrigin` treats a missing origin as
allowed, so a non-browser client is not stuck), and the identity check is what
refuses it: without a valid token, `POST /sessions` is `401`.

`COLLAB_IDENTITY_SECRET` is one value set on **both** the projects API and the
relay, and it has to exist **before** the deploy that turns the requirement
on. `wrangler secret put` publishes a new version of the Worker that is already
running, so putting the secret first is safe: the relay currently running does
not require the token yet. The other order breaks collaboration. If the relay
deploys with the requirement and no secret, it refuses everyone. If the API
deploys without the secret, `scripts/predeploy-check.mjs` blocks that deploy
while the relay workflow can still succeed on its own.

The host token is compared in constant time. Session-creation rate limits live
in the memory of each isolate, so they are a local ceiling, not a global count.

## HTTP details

- Every account, auth, invite and admin response is `Cache-Control: no-store`.
- Auth request bodies are capped at 16 KiB before parsing, so the scrypt inputs
  cannot be inflated.
- `Referrer-Policy: strict-origin-when-cross-origin` is already set for the
  app. With tokens in the fragment, a link token cannot leak through `Referer`
  either way.
- `/*` carries `frame-ancestors 'self'`, so no other site can frame the app and
  trick a click onto an admin action. Embedding by other sites is off here
  anyway (`VITE_GEOLIBRE_EMBED_ORIGINS` is unset); to turn it on, add each host
  origin to that directive in `_headers` in the same change. The pages that act
  on a mailed token (`/register`, `/reset`, `/verify-email`) also get
  `frame-ancestors 'self'` from the web Worker, so they stay unframeable even
  if the app policy is widened.
- `/*` also sends `Strict-Transport-Security` (a year, including subdomains),
  `Permissions-Policy` (camera, microphone and the other device APIs off;
  `geolocation` for this origin only) and
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`. The last one keeps
  another site from holding a handle to the window and still lets the Google
  Earth Engine sign-in open a popup. The web Worker sets the same three on the
  SPA fallback and on `/jupyterlite/*`, because those responses are built in
  the Worker rather than taken from a file. JupyterLite replaces the CSP; COOP
  on that prefix does not isolate the notebook iframe, which is same-origin and
  not the top window.

## Deleted data

R2 has no object versioning, so a dataset or project deleted through the API
used to be gone for good. Its objects now move to
`trash/<YYYY-MM-DD>/<original key>` in the same bucket, and a daily cron
(`triggers.crons` in `wrangler.jsonc`, the `scheduled` handler in `index.ts`)
deletes trash older than `GEOLIBRE_TRASH_RETENTION_DAYS` (30). The D1 rows that
pointed at the objects are recoverable with D1 Time Travel over the same 30
days, so a deletion can be undone end to end:

1. `npx wrangler d1 time-travel restore geolibre-projects --timestamp=<before the delete> -c workers/projects-api/wrangler.jsonc`
   (this restores the whole database to that point; export first if anything
   else has changed since).
2. Copy the objects back from `trash/<date>/…` to their original keys.

## Known gaps against ASVS Level 2

- **No phishing-resistant factor yet.** Two-factor is required of everyone,
  but TOTP codes can be phished; see [Passkeys: proposal](#passkeys-proposal).
- **A locked-out sole admin needs D1 access** to recover; there is no
  break-glass route.
- **Token readable by page script.** See
  [Token transport](#token-transport-bearer-not-cookies); mitigated by CSP and
  short lifetimes, not eliminated.
- **Breach check fails open** during an HIBP outage (logged).
- **Approximate throttling.** Cloudflare's rate-limit binding is eventually
  consistent and per location, so the limits are a ceiling on cost, not an
  exact count. `Retry-After` is the window length, not the true remaining time.
- **No Turnstile on desktop sign-in**; rate limits only.
- **Audit log is not tamper-evident.** It lives in the same D1 database as the
  data it describes, and an operator with D1 access can edit it.
- **Idle timeout accurate to about an hour**, because last-use writes are
  throttled.
- **Legacy passwords** of 12–14 characters remain valid until their owner
  changes them; the app does not force the change.
- **Legacy accounts without an email** cannot reset a forgotten password
  without an admin.
- **The main app can be framed** by any origin when embedding is enabled; only
  the token pages are protected.

## Passkeys: proposal

Not implemented. This is the design for the next phase, written down so the
choices that are hard to undo (the RP ID above all) are made on purpose.

### What it adds

A passkey (WebAuthn credential with user verification) is phishing-resistant
and, under NIST SP 800-63B-4, a multi-factor cryptographic authenticator on its
own, synced passkeys included, at AAL2. So it is offered as a **sign-in method**,
not only as a second step:

- **Sign in with a passkey**: no password, no TOTP. The credential is
  discoverable and the ceremony requires `userVerification: "required"`.
- **Satisfies the admin two-factor rule** in place of TOTP.
- **Re-authentication**: one passkey assertion replaces password + code for
  the sensitive changes listed under
  [Two-factor authentication](#two-factor-authentication).
- Password + TOTP stays as the fallback, and is the only method on desktop
  until the handoff below exists.

### Server: `@simplewebauthn/server` on Workers

Version 14 does its cryptography through WebCrypto (`globalThis.crypto`), which
workerd provides, and it bundles for the browser platform without any Node
built-in. Its [documentation](https://simplewebauthn.dev/docs/packages/server)
lists only Node 22+ and Deno as supported runtimes, though, so the first task
of the phase is a spike: register and sign in under `wrangler dev` with
Chrome's virtual authenticator, first without `nodejs_compat`, before any other
code is written. Signature checks (ES256, RS256, EdDSA) cost a few
milliseconds of CPU, well inside the current `cpu_ms`.
Request `attestationType: "none"`: a small team has no use for authenticator
make attestation, and it avoids most of the certificate-chain code at runtime.

Writing the verifier by hand (CBOR, COSE keys, authenticator data flags,
counters) would avoid the dependency, but it is exactly the security-critical
parsing that is better taken from a maintained, widely reviewed library.

Two new tables, by the same reasoning as `mfa_tickets`:

```sql
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,            -- credential id, base64url
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,       -- COSE key
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                -- JSON array, passed back as allowCredentials hints
  backed_up INTEGER NOT NULL DEFAULT 0,
  name TEXT,                      -- "MacBook", shown in Account & security
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE webauthn_challenges (
  digest TEXT PRIMARY KEY,        -- SHA-256 of the challenge
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, -- NULL for sign-in
  purpose TEXT NOT NULL,          -- 'register' | 'login' | 'reauth'
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,       -- 5 minutes
  used_at TEXT
);
```

Routes, all under the existing `no-store` and body-limit rules:

| Route | Bearer | Notes |
| --- | --- | --- |
| `POST /api/auth/passkeys/register-options` | yes | Needs re-authentication; returns creation options |
| `POST /api/auth/passkeys/register` | yes | `{response, name}`; stores the credential, records `passkey_added`, mails a notice |
| `POST /api/auth/passkeys/login-options` | no | Per-IP rate limit; returns request options and a challenge id |
| `POST /api/auth/passkeys/login` | no | `{challengeId, response}`; same response as `POST /api/auth/token` |
| `GET /api/auth/passkeys` | yes | `{passkeys: [{id, name, createdAt, lastUsedAt, backedUp}]}` |
| `DELETE /api/auth/passkeys/{id}` | yes | Needs re-authentication |

The challenge is spent with a conditional `UPDATE … WHERE used_at IS NULL`,
like the ticket. A sign count that goes backwards on a credential that reported
one is refused and logged (a cloned authenticator); synced passkeys report `0`
and are exempt. The admin two-factor reset also deletes the account's
passkeys. New config: `GEOLIBRE_WEBAUTHN_RP_ID` and `GEOLIBRE_WEBAUTHN_ORIGINS`
(the app origins the server accepts as `expectedOrigin`).

### Choosing the RP ID

A passkey is bound to its RP ID forever: change it and every passkey stops
working and has to be enrolled again. The RP ID must equal, or be a registrable
suffix of, the host of the page running the ceremony (the app, not the API;
the API only checks the result).

| Option | RP ID | Consequence |
| --- | --- | --- |
| Stay on `workers.dev` | `geolibre-web.<account>.workers.dev`, or `<account>.workers.dev` | `workers.dev` is a public suffix, so nothing broader is allowed. Tied to the Cloudflare account subdomain; renaming it, or the later move to a custom domain, orphans every passkey |
| Custom domain | e.g. `geolibre.example.org` | Stable across Cloudflare account changes. Also what makes the other deferred items possible: an `HttpOnly` same-site session cookie, HSTS, and Leaked Credentials Detection, which needs a zone |

**Recommendation: move the app and API to a custom domain first, then ship
passkeys with that domain as the RP ID.** WebAuthn Related Origin Requests
(`/.well-known/webauthn`) can let one RP ID serve several origins, but browser
support is uneven, so the design does not rely on it to undo a premature
`workers.dev` choice.

### Desktop (Tauri)

The desktop webview cannot run a ceremony for the web RP ID:

- **Windows** (WebView2) serves the app from `http://tauri.localhost`, and
  **macOS** (WKWebView) from `tauri://localhost`. Neither host can claim
  `geolibre.example.org` as RP ID. WKWebView only allows it through the
  Associated Domains entitlement, which needs a signed build and an
  `apple-app-site-association` file on the RP domain.
- **Linux** (WebKitGTK) has no WebAuthn at all.

So the desktop app hands the ceremony to the system browser, using the pattern
RFC 8252 sets out for native apps with a PKCE-style binding (RFC 7636):

1. The app makes a random `verifier`, and opens
   `https://<app>/desktop-signin#challenge=<SHA-256(verifier)>` with
   `tauri-plugin-opener` (already a dependency).
2. The user signs in there with the passkey, as on the web. The page calls
   `POST /api/auth/desktop-grant {challenge}`, which stores a single-use grant
   valid for two minutes, and redirects to `geolibre://signin?grant=…`.
   `tauri-plugin-deep-link` is already in the crate; only the desktop scheme
   needs registering.
3. The app posts `POST /api/auth/desktop-redeem {grant, verifier}`, and the
   server issues the desktop its own session after checking
   `SHA-256(verifier)` against the stored challenge.

A custom URL scheme can be claimed by another program, and the binding is what
makes that harmless: an intercepted grant is useless without the verifier,
which never leaves the app. A loopback redirect (`http://127.0.0.1:<port>`)
would avoid the scheme registration but needs a listener in the Rust side.

### Dependency and `package-lock.json` impact

Measured against the current lockfile:

- `workers/projects-api/package.json` gains `@simplewebauthn/server@^14`.
- `package-lock.json` gains about 24 entries: `@simplewebauthn/server`, 15
  `@peculiar/*` packages (ASN.1 and X.509 parsing), `asn1js`, `pvtsutils`,
  `pvutils`, `reflect-metadata`, `tsyringe` (with its own `tslib@1`),
  `@hexagon/base64` and `@levischuck/tiny-cbor`. `tslib@2` is already present.
- The Worker bundle grows by about 304 KB minified, 85 KB gzipped
  (esbuild, browser/worker conditions).
- The app needs no dependency: `PublicKeyCredential.parseCreationOptionsFromJSON`,
  `parseRequestOptionsFromJSON` and `toJSON()` cover the JSON round trip in
  current browsers. `@simplewebauthn/browser` (no dependencies of its own) is
  the fallback if the support matrix at implementation time says otherwise.
- `docs/maintenance.md` gets a note: a major bump of the server library is a
  security review, not a routine Dependabot merge.

### Effort

| Part | Estimate |
| --- | --- |
| Spike: the library under `wrangler dev` with a virtual authenticator | ½ day |
| Worker: tables, migration, six routes, re-auth by passkey, admin reset, audit kinds | 2–3 days |
| App (web): sign-in button, Account & security list/add/rename/remove, i18n | 2 days |
| Tests: pure policy modules under `node --test`; local E2E with Chrome's virtual authenticator (DevTools `WebAuthn` domain) | 1–2 days |
| Desktop handoff (scheme registration, grant routes, per-OS testing) | 2–3 days |

About a week and a half in total, or four to five days for web only, with
desktop keeping password + TOTP. The custom-domain move is a prerequisite, not
included above.
