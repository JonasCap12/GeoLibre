// Refuses a production deploy that would break sign-in or quietly weaken it.
//
// Run by deploy-projects-api.yml before `wrangler deploy`, from
// workers/projects-api with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID set.
// Read-only: it lists secret names and reads the table layout, nothing else.
//
// Two checks, each for a failure that is silent until it hurts:
//
// 1. Schema. D1 has no migration runner here; schema-auth.sql and
//    schema-sessions-mfa.sql are applied by hand. The Worker selects their
//    columns on every authenticated request, so deploying before they exist
//    turns every signed-in call into a 500.
// 2. Secrets. Without TURNSTILE_SECRET_KEY the Worker skips the bot check with
//    only a log line; without MFA_ENCRYPTION_KEY nobody can turn two-factor on,
//    and admin routes require it, so no invite can be sent.

import { spawnSync } from "node:child_process";

const DATABASE = "geolibre-projects";

const REQUIRED_COLUMNS = {
  accounts: [
    // schema-auth.sql
    "email",
    "email_verified_at",
    "password_changed_at",
    // schema-sessions-mfa.sql
    "disabled_at",
    "mfa_secret",
    "mfa_pending_secret",
    "mfa_enabled_at",
    "mfa_last_used_step",
    "mfa_failed_attempts",
  ],
  tokens: ["expires_at", "last_used_at", "user_agent", "created_ip"],
  auth_actions: ["digest", "kind", "expires_at", "used_at"],
  auth_events: ["id", "account_id", "kind", "created_at"],
  mfa_recovery_codes: ["digest", "account_id", "used_at"],
  mfa_tickets: ["digest", "account_id", "expires_at", "attempts"],
};

const REQUIRED_SECRETS = ["TURNSTILE_SECRET_KEY", "MFA_ENCRYPTION_KEY"];

function wrangler(args) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    // npx is npx.cmd on Windows, which Node will not resolve without a shell.
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(`wrangler ${args.join(" ")} failed:`);
    console.error(result.stderr || result.stdout);
    console.error(
      "If this is a permission error, the CLOUDFLARE_API_TOKEN secret needs " +
        "D1 read and Workers Scripts read on this account.",
    );
    process.exit(1);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    console.error(`wrangler ${args.join(" ")} did not print JSON:`);
    console.error(result.stdout);
    process.exit(1);
  }
}

const problems = [];

for (const [table, wanted] of Object.entries(REQUIRED_COLUMNS)) {
  const output = wrangler([
    "d1",
    "execute",
    DATABASE,
    "--remote",
    "--json",
    "--command",
    `PRAGMA table_info(${table});`,
  ]);
  const rows = Array.isArray(output) ? (output[0]?.results ?? []) : [];
  const present = new Set(rows.map((row) => row.name));
  if (present.size === 0) {
    problems.push(`table ${table} does not exist`);
    continue;
  }
  const missing = wanted.filter((column) => !present.has(column));
  if (missing.length > 0) problems.push(`${table} is missing ${missing.join(", ")}`);
}

const secrets = wrangler(["secret", "list", "--format", "json"]);
const names = new Set((Array.isArray(secrets) ? secrets : []).map((entry) => entry.name));
for (const name of REQUIRED_SECRETS) {
  if (!names.has(name)) problems.push(`secret ${name} is not set`);
}

if (problems.length > 0) {
  console.error("Not deploying the projects API:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    "\nApply the missing schema files (see the header of each for the exact " +
      "command and why each runs only once) and set the missing secrets with " +
      "`wrangler secret put <NAME> -c workers/projects-api/wrangler.jsonc`, then " +
      "re-run this workflow. docs/selfhost-auth.md lists the full order.",
  );
  process.exit(1);
}

console.log("D1 schema and Worker secrets are in place.");
