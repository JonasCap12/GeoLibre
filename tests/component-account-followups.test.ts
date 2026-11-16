import {
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";
import type { AccountInfo } from "../apps/geolibre-desktop/src/lib/share-account";
import { resetCapturedSelfHostRoute } from "../apps/geolibre-desktop/src/lib/selfhost-routes";

const { MfaSection, EmailSection, PasswordSection } =
  await import("../apps/geolibre-desktop/src/components/auth/AccountSecurityDialog");
const { AccountsTab, ActivityTab } =
  await import("../apps/geolibre-desktop/src/components/auth/AdminDialog");
const { SelfHostGate } = await import("../apps/geolibre-desktop/src/components/auth/SelfHostGate");
const t = i18n.t.bind(i18n);
const account: AccountInfo = {
  id: "owner",
  username: "owner",
  email: "old@example.com",
  emailVerifiedAt: "2026-11-01T00:00:00Z",
  isAdmin: false,
  mfaEnabled: false,
  recoveryCodesLeft: 0,
  mfaRequiredBy: null,
  mfaEnrollmentRequired: false,
};
const password = "t4W!qp9#Lv6$Bs2@Kx8";
afterEach(() => {
  window.history.replaceState({}, "", "/");
  resetCapturedSelfHostRoute();
});

it("enrolls MFA and requires recovery-code acknowledgement before finishing", async () => {
  let reloaded = 0;
  const requests: unknown[] = [];
  mockFetch(async (input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return String(input).endsWith("/setup")
      ? Response.json({
          secret: "ABCDEFGHIJKLMNOP",
          otpauthUri: "otpauth://totp/GeoLibre:owner?secret=ABCDEFGHIJKLMNOP",
        })
      : Response.json({
          recoveryCodes: ["ABCD-EFGH-IJKL-MNOP-QRST-UVWX", "BCDE-FGHI-JKLM-NOPQ-RSTU-VWXY"],
        });
  });
  render(
    createElement(MfaSection, {
      token: "mfa-token",
      account,
      async onAccountChange() {
        reloaded++;
      },
    }),
  );
  fireEvent.change(screen.getByLabelText(t("auth.currentPassword")), {
    target: { value: "current-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: t("auth.mfa.setUp") }));
  const code = await screen.findByLabelText(t("auth.mfa.firstCode"));
  fireEvent.change(code, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: t("auth.mfa.enable") }));
  await screen.findByRole("list", { name: t("auth.mfa.codesLabel") });
  const done = screen.getByRole("button", { name: t("auth.mfa.done") }) as HTMLButtonElement;
  assert.equal(done.disabled, true);
  assert.equal(reloaded, 0);
  fireEvent.click(screen.getByRole("checkbox", { name: t("auth.mfa.savedConfirm") }));
  fireEvent.click(done);
  await waitFor(() => assert.equal(reloaded, 1));
  assert.deepEqual(requests, [{ currentPassword: "current-secret" }, { code: "123456" }]);
});

it("requests an email change with reauthentication and clears sensitive fields after success", async () => {
  const bodies: unknown[] = [];
  mockFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true }, { status: 202 });
  });
  render(
    createElement(EmailSection, {
      token: "email-token",
      account: { ...account, mfaEnabled: true },
    }),
  );
  fireEvent.change(screen.getByLabelText(t("auth.emailChange.newAddress")), {
    target: { value: "new@example.com" },
  });
  fireEvent.change(screen.getByLabelText(t("auth.currentPassword")), {
    target: { value: "current-secret" },
  });
  fireEvent.change(screen.getByLabelText(t("auth.mfa.code")), { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: t("auth.emailChange.submit") }));
  await screen.findByText(t("auth.emailChange.sent", { email: "new@example.com" }));
  assert.deepEqual(bodies, [
    { email: "new@example.com", currentPassword: "current-secret", code: "123456" },
  ]);
  assert.equal((screen.getByLabelText(t("auth.currentPassword")) as HTMLInputElement).value, "");
  assert.equal((screen.getByLabelText(t("auth.mfa.code")) as HTMLInputElement).value, "");
  assert.equal(account.email, "old@example.com");
});

it("validates password confirmation locally and stores a replacement token only after server success", async () => {
  const tokens: string[] = [];
  const bodies: unknown[] = [];
  mockFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ token: "replacement-token" });
  });
  render(
    createElement(PasswordSection, {
      token: "old-token",
      account,
      onToken: (token) => tokens.push(token),
    }),
  );
  fireEvent.change(screen.getByLabelText(t("auth.currentPassword")), {
    target: { value: "old-secret" },
  });
  fireEvent.change(screen.getByLabelText(t("auth.newPassword")), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(t("auth.confirmPassword")), {
    target: { value: "wrong" },
  });
  fireEvent.click(screen.getByRole("button", { name: t("auth.passwordChange.submit") }));
  assert.equal(bodies.length, 0);
  fireEvent.change(screen.getByLabelText(t("auth.confirmPassword")), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: t("auth.passwordChange.submit") }));
  await waitFor(() => assert.deepEqual(tokens, ["replacement-token"]));
  assert.deepEqual(bodies, [{ currentPassword: "old-secret", password }]);
});

it("disables another account and requires confirmation before resetting its MFA", async () => {
  let disabledAt: string | null = null;
  let mfaEnabled = true;
  const writes: { method: string; url: string }[] = [];
  mockFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ method, url });
      if (url.endsWith("/disable")) disabledAt = "2026-11-16T00:00:00Z";
      if (url.endsWith("/mfa")) mfaEnabled = false;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      accounts: [
        {
          id: "other",
          username: "other-surveyor",
          email: "other@example.com",
          emailVerifiedAt: null,
          createdAt: "2026-11-01T00:00:00Z",
          disabledAt,
          isAdmin: false,
          mfaEnabled,
          sessions: 0,
          lastSeenAt: null,
        },
      ],
    });
  });
  render(
    createElement(AccountsTab, {
      token: "admin-token",
      self: { ...account, isAdmin: true, mfaEnabled: true },
    }),
  );
  await screen.findByText("other-surveyor");
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.disable") }));
  await screen.findByRole("button", { name: t("auth.admin.enable") });
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.resetMfa") }));
  assert.equal(writes.length, 1);
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.confirmMfaReset") }));
  await waitFor(() => assert.equal(writes.length, 2));
  assert.deepEqual(
    writes.map((r) => r.method),
    ["POST", "DELETE"],
  );
  assert.ok(writes[0].url.endsWith("/accounts/other/disable"));
  assert.ok(writes[1].url.endsWith("/accounts/other/mfa"));
});

it("shows audit event details and loads the next page with the correct offset", async () => {
  const offsets: string[] = [];
  mockFetch(async (input) => {
    const url = new URL(String(input));
    offsets.push(url.searchParams.get("offset")!);
    const count = Number(url.searchParams.get("limit"));
    return Response.json({
      events:
        offsets.length === 1
          ? Array.from({ length: count }, (_, i) => ({
              id: `event-${i}`,
              accountId: "other",
              username: "member",
              kind: "mfa_reset",
              ip: "192.0.2.1",
              userAgent: "Browser",
              createdAt: "2026-11-16T00:00:00Z",
              detail: { by: "admin", to: "o***@example.com" },
            }))
          : [],
    });
  });
  render(createElement(ActivityTab, { token: "audit-token" }));
  await screen.findByRole("button", { name: t("auth.admin.loadMore") });
  assert.ok(screen.getAllByText(/o\*\*\*@example.com/).length > 0);
  fireEvent.click(screen.getByRole("button", { name: t("auth.admin.loadMore") }));
  await waitFor(() => assert.equal(offsets.length, 2));
  assert.equal(offsets[0], "0");
  assert.ok(Number(offsets[1]) > 0);
});

it("requires an explicit click before confirming an email link and removes its token from the URL", async () => {
  window.history.replaceState({}, "", "/verify-email#token=verify-token-12345678901234567890");
  const bodies: unknown[] = [];
  mockFetch(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  });
  render(createElement(SelfHostGate, { children: createElement("main", null, "Private map") }));
  assert.equal(window.location.hash, "");
  assert.equal(bodies.length, 0);
  fireEvent.click(screen.getByRole("button", { name: t("auth.verify.submit") }));
  await screen.findByText(t("auth.verify.done"));
  assert.deepEqual(bodies, [{ token: "verify-token-12345678901234567890" }]);
});

it("resets a password from a link and returns to sign-in without treating the link as a bearer", async () => {
  window.history.replaceState({}, "", "/reset#token=reset-token-12345678901234567890");
  const bodies: unknown[] = [];
  mockFetch(async (input, init) => {
    if (String(input).endsWith("/reset-confirm")) {
      assert.equal(new Headers(init?.headers).has("Authorization"), false);
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json({ account });
  });
  render(createElement(SelfHostGate, { children: createElement("main", null, "Private map") }));
  fireEvent.change(screen.getByLabelText(t("auth.newPassword")), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(t("auth.confirmPassword")), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: t("auth.reset.submit") }));
  await screen.findByRole("button", { name: t("auth.signIn") });
  assert.equal(useDesktopSettingsStore.getState().desktopSettings.shareToken, "");
  assert.deepEqual(bodies, [
    { token: "reset-token-12345678901234567890", password, turnstileToken: "" },
  ]);
});
