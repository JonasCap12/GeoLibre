import {
  act,
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useAppStore,
  waitFor,
  within,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";
import type { CollaborationParticipant } from "@geolibre/core";
import { collaborationApi } from "./helpers/collaboration-api";

const { CollaborationParticipantRow } =
  await import("../apps/geolibre-desktop/src/components/layout/CollaborationParticipantRow");
const { CollaborationFollowChrome } =
  await import("../apps/geolibre-desktop/src/components/layout/CollaborationFollowChrome");
const { CollaborationStatusBadge } =
  await import("../apps/geolibre-desktop/src/components/layout/CollaborationStatusBadge");
const { CollaborateDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/CollaborateDialog");
const { CloudWorkspaceStatus } =
  await import("../apps/geolibre-desktop/src/components/layout/CloudWorkspaceStatus");
const t = i18n.t.bind(i18n);
const guest: CollaborationParticipant = {
  clientId: "guest",
  displayName: "Surveyor B",
  color: "#16a34a",
  role: "guest",
  editOverride: null,
};
const host: CollaborationParticipant = {
  clientId: "host",
  displayName: "Surveyor A",
  color: "#2563eb",
  role: "host",
  editOverride: null,
};
function active() {
  act(() =>
    useAppStore.setState((s) => ({
      collaboration: {
        ...s.collaboration,
        isActive: true,
        clientId: "host",
        role: "host",
        sessionId: "ABCD2345",
        participants: [host, guest],
        mode: "co-edit",
        connecting: false,
      },
    })),
  );
}
afterEach(() => window.history.replaceState({}, "", "/"));

it("drives guest permissions, following and moderation from the participant row", () => {
  const actions: unknown[][] = [];
  const props = {
    participant: guest,
    mode: "co-edit" as const,
    isSelf: false,
    canManage: true,
    onSetParticipantMode: (id: string, edit: boolean) => actions.push(["mode", id, edit]),
    onFollow: (id: string | null) => actions.push(["follow", id]),
    onKickParticipant: (id: string) => actions.push(["kick", id]),
    onBlockParticipant: (id: string) => actions.push(["block", id]),
    hasView: true,
  };
  const result = render(
    createElement("ul", null, createElement(CollaborationParticipantRow, props)),
  );
  assert.equal(screen.getByRole("switch").getAttribute("aria-checked"), "true");
  fireEvent.click(screen.getByRole("switch"));
  fireEvent.click(
    screen.getByRole("button", {
      name: t("collaborate.followScreen", { name: guest.displayName }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.kick") }));
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.block") }));
  assert.deepEqual(actions, [
    ["mode", "guest", false],
    ["follow", "guest"],
    ["kick", "guest"],
    ["block", "guest"],
  ]);
  result.rerender(
    createElement(
      "ul",
      null,
      createElement(CollaborationParticipantRow, { ...props, following: true, canManage: false }),
    ),
  );
  assert.equal(screen.queryByRole("switch"), null);
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.stopFollowing") }));
  assert.deepEqual(actions.at(-1), ["follow", null]);
});

it("allows only the local row to claim and stop presenting", () => {
  const requests: boolean[] = [];
  const props = {
    participant: host,
    mode: "co-edit" as const,
    isSelf: true,
    canManage: true,
    onSetParticipantMode() {},
    onPresent: (value: boolean) => requests.push(value),
  };
  const result = render(
    createElement("ul", null, createElement(CollaborationParticipantRow, props)),
  );
  assert.equal(screen.queryByRole("switch"), null);
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.presentToEveryone") }));
  result.rerender(
    createElement(
      "ul",
      null,
      createElement(CollaborationParticipantRow, { ...props, presenting: true }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.stopPresenting") }));
  assert.deepEqual(requests, [true, false]);
});

it("shows follow chrome only for a live followed participant and stops following on click", () => {
  const follows: (string | null)[] = [];
  const api = collaborationApi({
    setFollow(id) {
      follows.push(id);
      act(() =>
        useAppStore.setState((s) => ({
          collaboration: { ...s.collaboration, followClientId: id },
        })),
      );
    },
  });
  render(createElement(CollaborationFollowChrome, { api }));
  assert.equal(screen.queryByRole("status"), null);
  active();
  act(() =>
    useAppStore.setState((s) => ({
      collaboration: { ...s.collaboration, followClientId: "guest" },
    })),
  );
  assert.ok(
    screen.getByRole("status", {
      name: t("collaborate.followingName", { name: guest.displayName }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.followStop") }));
  assert.deepEqual(follows, [null]);
  assert.equal(screen.queryByRole("status"), null);
});

it("announces cloud saving states and keeps errors visible with their detail", () => {
  const result = render(
    createElement(CloudWorkspaceStatus, { state: { status: "disabled", error: null } }),
  );
  for (const status of ["disabled", "ready"] as const) {
    result.rerender(createElement(CloudWorkspaceStatus, { state: { status, error: null } }));
    assert.equal(screen.queryByTestId("cloud-workspace-status"), null);
  }
  for (const status of ["loading", "saving", "saved", "error"] as const) {
    result.rerender(
      createElement(CloudWorkspaceStatus, {
        state: { status, error: status === "error" ? "Network unavailable" : null },
      }),
    );
    const node = screen.getByRole(status === "error" ? "alert" : "status");
    assert.equal(node.textContent, t(`cloudWorkspace.${status}`));
    assert.equal(
      node.title,
      status === "error" ? "Network unavailable" : t(`cloudWorkspace.${status}`),
    );
  }
});

it("opens the live roster, sends chat and opens the full collaboration dialog", async () => {
  const sent: unknown[][] = [];
  const api = collaborationApi({
    sendChat(text, coordinate) {
      sent.push([text, coordinate]);
      return true;
    },
  });
  const result = render(
    createElement(CollaborationStatusBadge, { api, mapControllerRef: { current: null } }),
  );
  assert.equal(screen.queryByRole("button"), null);
  active();
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.sessionStatusTooltip") }));
  assert.ok(screen.getByText(guest.displayName));
  fireEvent.change(screen.getByRole("textbox", { name: t("collaborate.chatCompose") }), {
    target: { value: "  Check pier M1  " },
  });
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.chatSend") }));
  assert.deepEqual(sent, [["Check pier M1", null]]);
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(screen.queryByRole("textbox", { name: t("collaborate.chatCompose") }), null);
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.sessionStatusTooltip") }));
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.manageSession") }));
  assert.equal(useAppStore.getState().ui.collaborateDialogOpen, true);
  result.unmount();
});

it("starts an anonymous session with the chosen name, color and mode", async () => {
  const starts: unknown[][] = [];
  mockFetch(async () => Response.json({ ok: true, identitySupported: true }));
  render(
    createElement(CollaborateDialog, {
      open: true,
      onOpenChange() {},
      api: collaborationApi({
        async start(...args) {
          starts.push(args);
          return "ABCD2345";
        },
      }),
    }),
  );
  fireEvent.change(screen.getByLabelText(t("collaborate.displayName")), {
    target: { value: " Surveyor A " },
  });
  fireEvent.click(screen.getByRole("button", { name: "red" }));
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.start") }));
  await waitFor(() => assert.equal(starts.length, 1));
  assert.deepEqual(starts[0].slice(0, 3), ["Surveyor A", "#dc2626", "co-edit"]);
});

it("consumes an invite URL and passes its code to join while keeping failures visible", async () => {
  window.history.replaceState({}, "", "/?collab=ABCD2345");
  mockFetch(async () => Response.json({ ok: true, identitySupported: false }));
  const joins: unknown[][] = [];
  render(
    createElement(CollaborateDialog, {
      open: true,
      onOpenChange() {},
      api: collaborationApi({
        async join(...args) {
          joins.push(args);
          throw new Error("Session unavailable");
        },
      }),
    }),
  );
  assert.equal(window.location.search, "");
  fireEvent.change(screen.getByLabelText(t("collaborate.displayName")), {
    target: { value: "Guest" },
  });
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.joinSession") }));
  await screen.findByText("Session unavailable");
  assert.deepEqual(joins[0].slice(0, 2), ["ABCD2345", "Guest"]);
  assert.ok(
    within(screen.getByRole("dialog")).getByRole("button", { name: t("collaborate.start") }),
  );
});
