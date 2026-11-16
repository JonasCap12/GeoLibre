import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as admin from "../apps/geolibre-desktop/src/lib/selfhost-admin";
import { ShareAccountError } from "../apps/geolibre-desktop/src/lib/share-account";

const id = "a/b ?";
const cases = [
  {
    call: admin.listInvites,
    path: "/api/admin/invites",
    method: "GET",
    result: { invites: [{ id: "invite" }] },
    expected: [{ id: "invite" }],
    fallback: "Could not load invites",
  },
  {
    call: admin.sendInvite,
    path: "/api/invites",
    method: "POST",
    body: { email: "new@example.com" },
    fallback: "Could not send the invite",
  },
  {
    call: admin.revokeInvite,
    path: `/api/admin/invites/${encodeURIComponent(id)}`,
    method: "DELETE",
    fallback: "Could not revoke the invite",
  },
  {
    call: admin.resendInvite,
    path: `/api/admin/invites/${encodeURIComponent(id)}/resend`,
    method: "POST",
    fallback: "Could not resend the invite",
  },
  {
    call: admin.listAccounts,
    path: "/api/admin/accounts",
    method: "GET",
    result: { accounts: [{ id: "account" }] },
    expected: [{ id: "account" }],
    fallback: "Could not load accounts",
  },
  {
    call: admin.setAccountDisabled,
    path: `/api/admin/accounts/${encodeURIComponent(id)}/disable`,
    method: "POST",
    disabled: true,
    fallback: "Could not disable the account",
  },
  {
    call: admin.setAccountDisabled,
    path: `/api/admin/accounts/${encodeURIComponent(id)}/enable`,
    method: "POST",
    disabled: false,
    fallback: "Could not enable the account",
  },
  {
    call: admin.revokeAccountSessions,
    path: `/api/admin/accounts/${encodeURIComponent(id)}/sessions`,
    method: "DELETE",
    fallback: "Could not sign the account out",
  },
  {
    call: admin.resetAccountMfa,
    path: `/api/admin/accounts/${encodeURIComponent(id)}/mfa`,
    method: "DELETE",
    fallback: "Could not reset two-factor authentication",
  },
  {
    call: admin.listAuthEvents,
    path: "/api/admin/events?limit=25&offset=50",
    method: "GET",
    result: { events: [{ id: "event" }] },
    expected: [{ id: "event" }],
    fallback: "Could not load the activity log",
  },
];

describe("self-host admin HTTP client", () => {
  for (const row of cases) {
    const options = {
      token: "admin-token",
      baseUrl: "https://api.example.com/",
      id,
      email: " new@example.com ",
      disabled: row.disabled ?? false,
      limit: 25,
      offset: 50,
    };
    it(`${row.method} ${row.path} builds the request and decodes the reply`, async () => {
      let requests = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        requests++;
        assert.equal(String(input), `https://api.example.com${row.path}`);
        assert.equal(init?.method, row.method);
        assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer admin-token");
        assert.deepEqual(init?.body ? JSON.parse(String(init.body)) : undefined, row.body);
        assert.equal(
          new Headers(init?.headers).get("Content-Type"),
          row.body ? "application/json" : null,
        );
        return row.result ? Response.json(row.result) : new Response(null, { status: 204 });
      };
      assert.deepEqual(await row.call({ ...options, fetchImpl }), row.expected);
      assert.equal(requests, 1);
    });
    it(`${row.call.name} maps network, API and non-JSON errors`, async () => {
      for (const mode of ["network", "json", "html"]) {
        const fetchImpl: typeof fetch = async () => {
          if (mode === "network") throw new TypeError("offline");
          return mode === "json"
            ? Response.json({ error: "admin only" }, { status: 403 })
            : new Response("bad gateway", { status: 502 });
        };
        await assert.rejects(
          row.call({ ...options, fetchImpl }),
          (error: unknown) =>
            error instanceof ShareAccountError &&
            error.message ===
              (mode === "network"
                ? "Could not reach the projects server."
                : mode === "json"
                  ? "admin only"
                  : `${row.fallback} (HTTP 502)`),
        );
      }
    });
  }
  it("defaults missing lists to empty and supplies activity pagination defaults", async () => {
    const options = {
      token: "token",
      baseUrl: "https://api.example.com",
      fetchImpl: (async () => Response.json({})) as typeof fetch,
    };
    assert.deepEqual(await admin.listInvites(options), []);
    assert.deepEqual(await admin.listAccounts(options), []);
    assert.deepEqual(
      await admin.listAuthEvents({
        ...options,
        fetchImpl: async (input) => {
          assert.equal(
            String(input),
            "https://api.example.com/api/admin/events?limit=100&offset=0",
          );
          return Response.json({});
        },
      }),
      [],
    );
  });
});
