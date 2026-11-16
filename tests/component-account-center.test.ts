import {
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import type { AccountInfo } from "../apps/geolibre-desktop/src/lib/share-account";

const { SessionsSection } =
  await import("../apps/geolibre-desktop/src/components/auth/AccountSecurityDialog");
const { InvitesTab } = await import("../apps/geolibre-desktop/src/components/auth/AdminDialog");
const { AccountCenter } =
  await import("../apps/geolibre-desktop/src/components/auth/AccountCenter");
const { SelfHostGate } = await import("../apps/geolibre-desktop/src/components/auth/SelfHostGate");
const t = i18n.t.bind(i18n);
const account: AccountInfo = {
  id: "owner",
  username: "surveyor",
  email: "old@example.com",
  emailVerifiedAt: "2026-11-01T00:00:00Z",
  isAdmin: false,
  mfaEnabled: true,
  recoveryCodesLeft: 5,
  mfaRequiredBy: null,
  mfaEnrollmentRequired: false,
};

it("revokes another session and requires confirmation before signing out everywhere", async () => {
  let removed = false;
  const deletes: string[] = [];
  const tokens: string[] = [];
  const at = "2026-11-01T00:00:00Z";
  mockFetch(async (input, init) => {
    const url = String(input);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
    if (init?.method === "DELETE") {
      deletes.push(url);
      removed = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      sessions: [
        {
          id: "current",
          createdAt: at,
          lastUsedAt: at,
          expiresAt: at,
          userAgent: "Current browser",
          ip: "192.0.2.1",
          current: true,
        },
        ...(removed
          ? []
          : [
              {
                id: "other",
                createdAt: at,
                lastUsedAt: at,
                expiresAt: at,
                userAgent: "Other browser",
                ip: "192.0.2.2",
                current: false,
              },
            ]),
      ],
    });
  });
  render(
    createElement(SessionsSection, { token: "token", onToken: (token) => tokens.push(token) }),
  );
  fireEvent.click(await screen.findByRole("button", { name: t("auth.sessions.revoke") }));
  await waitFor(() => assert.equal(deletes.length, 1));
  assert.ok(deletes[0].endsWith("/auth/sessions/other"));
  fireEvent.click(screen.getByRole("button", { name: t("auth.sessions.signOutAll") }));
  assert.equal(deletes.length, 1);
  fireEvent.click(screen.getByRole("button", { name: t("auth.sessions.confirmAll") }));
  await waitFor(() => assert.deepEqual(tokens, [""]));
  assert.ok(deletes[1].endsWith("/auth/sessions"));
});

it("sends an invite, reloads the list and revokes the displayed invitation", async () => {
  let email: string | null = null;
  let removed = false;
  const writes: string[] = [];
  mockFetch(async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      email = JSON.parse(String(init.body)).email;
      writes.push("send");
      return Response.json({ ok: true }, { status: 201 });
    }
    if (init?.method === "DELETE") {
      writes.push(url);
      removed = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      invites:
        email && !removed
          ? [
              {
                id: "invite-id",
                email,
                status: "pending",
                createdAt: "2026-11-01T00:00:00Z",
                expiresAt: "2026-11-20T00:00:00Z",
                usedAt: null,
                createdBy: "admin",
                usedBy: null,
              },
            ]
          : [],
    });
  });
  render(createElement(InvitesTab, { token: "admin-token" }));
  await screen.findByText(t("auth.admin.noInvites"));
  fireEvent.change(screen.getByLabelText(t("auth.email")), {
    target: { value: " new@example.com " },
  });
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.send") }));
  await screen.findByText("new@example.com", { selector: "p" });
  assert.equal(email, "new@example.com");
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.revoke") }));
  await screen.findByText(t("auth.admin.noInvites"));
  assert.equal(writes.length, 2);
  assert.ok(writes[1].endsWith("/admin/invites/invite-id"));
});

it("falls back to the personal overview for a non-admin's stale admin view", () => {
  const views: string[] = [];
  render(
    createElement(AccountCenter, {
      open: true,
      onOpenChange() {},
      view: "invites",
      onViewChange: (view) => views.push(view),
      token: "token",
      account,
      onToken() {},
      async onAccountChange() {},
    }),
  );
  const dialog = within(screen.getByRole("dialog"));
  assert.ok(dialog.getByRole("heading", { name: t("auth.center.nav.overview") }));
  assert.equal(dialog.queryByRole("button", { name: t("auth.admin.invites") }), null);
  fireEvent.click(dialog.getByRole("button", { name: t("auth.center.nav.sessions") }));
  assert.deepEqual(views, ["sessions"]);
});

it("opens the app after gate sign-in and stores the bearer for shared services", async () => {
  window.history.replaceState({}, "", "/");
  mockFetch(async (input, init) => {
    if (String(input).endsWith("/auth/token")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        username: "surveyor",
        password: "secret",
      });
      return Response.json({ token: "gate-token" });
    }
    return Response.json({ account });
  });
  render(
    createElement(SelfHostGate, { children: createElement("main", null, "Private map workspace") }),
  );
  assert.equal(screen.queryByText("Private map workspace"), null);
  fireEvent.change(screen.getByLabelText(t("auth.usernameOrEmail")), {
    target: { value: "surveyor" },
  });
  fireEvent.change(screen.getByLabelText(t("auth.password")), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: t("auth.signIn") }));
  await screen.findByText("Private map workspace");
  assert.equal(useDesktopSettingsStore.getState().desktopSettings.shareToken, "gate-token");
});
