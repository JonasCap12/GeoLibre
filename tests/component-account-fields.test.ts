import { act, fireEvent, i18n, mockFetch, render, screen, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement, useState } from "react";
import type { TurnstileRenderOptions } from "../apps/geolibre-desktop/src/lib/turnstile";

const { PasswordField } =
  await import("../apps/geolibre-desktop/src/components/auth/PasswordField");
const { PasswordStrength } =
  await import("../apps/geolibre-desktop/src/components/auth/PasswordStrength");
const { MfaCodeField } = await import("../apps/geolibre-desktop/src/components/auth/MfaCodeField");
const { TurnstileWidget, turnstileRequired } =
  await import("../apps/geolibre-desktop/src/components/auth/TurnstileWidget");
const { AccountAvatar, RoleBadge, accountInitials } =
  await import("../apps/geolibre-desktop/src/components/auth/account-badges");
const { ShareAccountForm } =
  await import("../apps/geolibre-desktop/src/components/layout/ShareAccountForm");
const t = i18n.t.bind(i18n);
afterEach(() => {
  delete window.turnstile;
  delete (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: unknown })
    .__GEOLIBRE_DEPLOYMENT_ENV__;
});

it("keeps password text, descriptions and autocomplete while toggling visibility", () => {
  function Field() {
    const [value, onChange] = useState("initial");
    return createElement(PasswordField, {
      id: "password",
      label: "Password",
      value,
      onChange,
      autoComplete: "new-password",
      hint: "Use a password manager",
      describedBy: "strength",
    });
  }
  render(createElement(Field));
  const input = screen.getByLabelText("Password") as HTMLInputElement;
  assert.equal(input.type, "password");
  assert.equal(input.autocomplete, "new-password");
  assert.equal(input.getAttribute("aria-describedby"), "password-hint strength");
  fireEvent.change(input, { target: { value: "new secret" } });
  fireEvent.click(screen.getByRole("button", { name: t("auth.showPassword") }));
  assert.equal(input.type, "text");
  assert.equal(input.value, "new secret");
  fireEvent.click(screen.getByRole("button", { name: t("auth.hidePassword") }));
  assert.equal(input.type, "password");
});

it("shows translated strength feedback for empty, weak and strong passwords", () => {
  const result = render(createElement(PasswordStrength, { id: "strength", password: "" }));
  assert.ok(screen.getByText(t("auth.strength.empty")));
  result.rerender(createElement(PasswordStrength, { id: "strength", password: "12345678" }));
  assert.ok(screen.getByText(t("auth.strength.level.0")));
  result.rerender(
    createElement(PasswordStrength, { id: "strength", password: "t4W!qp9#Lv6$Bs2@Kx8" }),
  );
  assert.ok(screen.getByText(t("auth.strength.level.4")));
  assert.equal(document.querySelectorAll("#strength li").length, 4);
});

it("accepts recovery-code letters in the same field as a one-time code", () => {
  let value = "";
  render(
    createElement(MfaCodeField, {
      id: "code",
      value,
      onChange: (next) => {
        value = next;
      },
      autoFocus: true,
    }),
  );
  const input = screen.getByLabelText(t("auth.mfa.code")) as HTMLInputElement;
  assert.equal(input.autocomplete, "one-time-code");
  assert.equal(input.inputMode, "");
  assert.equal(input.maxLength, 40);
  assert.equal(input.getAttribute("aria-describedby"), "code-hint");
  fireEvent.change(input, { target: { value: "ABCD-EFGH-IJKL-MNOP-QRST-UVWX" } });
  assert.equal(value, "ABCD-EFGH-IJKL-MNOP-QRST-UVWX");
});

it("derives initials and renders translated account roles", () => {
  for (const [name, initials] of [
    ["nguyen-minh-nhut", "NM"],
    ["nhut", "NH"],
    ["Élodie Nguyễn", "ÉN"],
    ["", "?"],
    [null, "?"],
  ])
    assert.equal(accountInitials(name), initials);
  const result = render(
    createElement(
      "div",
      null,
      createElement(AccountAvatar, { name: "Nguyen Minh", admin: true }),
      createElement(RoleBadge, { admin: true }),
    ),
  );
  assert.ok(screen.getByText("NM"));
  assert.ok(screen.getByText(t("auth.center.role.admin")));
  result.rerender(createElement(RoleBadge, { admin: false }));
  assert.ok(screen.getByText(t("auth.center.role.member")));
});

it("passes Turnstile tokens, expiry and reset events and removes the widget on unmount", async () => {
  Object.assign(window, {
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_TURNSTILE_SITE_KEY: "test-site-key" },
  });
  let options: TurnstileRenderOptions | undefined;
  const removed: string[] = [];
  const resets: string[] = [];
  const tokens: (string | null)[] = [];
  window.turnstile = {
    render(_container, next) {
      options = next;
      return "widget-id";
    },
    reset(id) {
      resets.push(id);
    },
    remove(id) {
      removed.push(id);
    },
  };
  assert.equal(turnstileRequired(), true);
  const result = render(
    createElement(TurnstileWidget, {
      action: "register",
      onToken: (token) => tokens.push(token),
      resetKey: 0,
    }),
  );
  await waitFor(() => assert.ok(options));
  assert.equal(options!.sitekey, "test-site-key");
  assert.equal(options!.action, "register");
  act(() => {
    options!.callback("response-token");
    options!["expired-callback"]?.();
    options!["error-callback"]?.();
  });
  assert.deepEqual(tokens, ["response-token", null, null]);
  result.rerender(
    createElement(TurnstileWidget, {
      action: "register",
      onToken: (token) => tokens.push(token),
      resetKey: 1,
    }),
  );
  assert.deepEqual(resets, ["widget-id"]);
  assert.equal(tokens.at(-1), null);
  result.unmount();
  assert.deepEqual(removed, ["widget-id"]);
});

it("signs in through the account form and completes a second-factor challenge", async () => {
  const tokens: string[] = [];
  const requests: string[] = [];
  mockFetch(async (input, init) => {
    requests.push(String(input));
    const body = JSON.parse(String(init?.body));
    if (String(input).endsWith("/auth/token")) {
      assert.deepEqual(body, { username: "surveyor", password: "secret" });
      return Response.json({ mfaRequired: true, mfaTicket: "mfa-ticket" });
    }
    assert.deepEqual(body, { ticket: "mfa-ticket", code: "123456" });
    return Response.json({ token: "signed-in-token" });
  });
  render(
    createElement(ShareAccountForm, {
      onToken: (token) => tokens.push(token),
      onSignedOut() {},
      token: "",
      hasToken: false,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: t("settings.env.accountOpen") }));
  fireEvent.change(screen.getByLabelText(t("settings.env.accountUsernameOrEmail")), {
    target: { value: " Surveyor " },
  });
  fireEvent.change(screen.getByLabelText(t("settings.env.accountPassword")), {
    target: { value: "secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: t("settings.env.accountSignIn") }));
  const code = await screen.findByLabelText(t("auth.mfa.code"));
  assert.deepEqual(tokens, []);
  fireEvent.change(code, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: t("auth.mfa.verify") }));
  await waitFor(() => assert.deepEqual(tokens, ["signed-in-token"]));
  assert.equal(requests.length, 2);
});

it("keeps the saved token when server-side sign-out fails", async () => {
  let signedOut = 0;
  mockFetch(async () => Response.json({ error: "unavailable" }, { status: 503 }));
  render(
    createElement(ShareAccountForm, {
      onToken() {},
      onSignedOut() {
        signedOut++;
      },
      token: "saved",
      hasToken: true,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: t("settings.env.accountSignOut") }));
  await screen.findByText("unavailable");
  assert.equal(signedOut, 0);
});
