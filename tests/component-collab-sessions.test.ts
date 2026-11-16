import {
  act,
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { collaborationApi } from "./helpers/collaboration-api";
import {
  recallHostToken,
  rememberHostToken,
} from "../apps/geolibre-desktop/src/lib/collab-host-tokens";
import type { SavedCollabSession } from "../apps/geolibre-desktop/src/lib/collab-sessions";

const { CollabSessionManager } =
  await import("../apps/geolibre-desktop/src/components/layout/CollabSessionManager");
const { useSignedInAccount } =
  await import("../apps/geolibre-desktop/src/hooks/useSignedInAccount");
const t = i18n.t.bind(i18n);
const fixture: SavedCollabSession = {
  id: "saved",
  code: "ABCD2345",
  name: "Team A",
  mode: "co-edit",
  createdAt: "2026-11-16T00:00:00Z",
  lastOpenedAt: null,
};

it("restores host credentials before opening a saved session, renames it, and ends it before deletion", async (ctx) => {
  Object.assign(window, {
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_COLLAB_URL: "ws://127.0.0.1:9876" },
  });
  ctx.after(() => {
    delete (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: unknown })
      .__GEOLIBRE_DEPLOYMENT_ENV__;
  });
  let row = { ...fixture };
  let removed = false;
  const calls: { method: string; url: string; body: unknown }[] = [];
  const opened: string[] = [];
  mockFetch(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/host-token")) return Response.json({ hostToken: "owner-host-token" });
    if (method === "PATCH") {
      row = { ...row, ...(body.name ? { name: body.name } : {}) };
      return Response.json({ session: row });
    }
    if (method === "DELETE") {
      if (url.includes("/api/collab-sessions/")) removed = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ sessions: removed ? [] : [row] });
  });
  const api = collaborationApi({
    async join(code, name, color) {
      assert.equal(code, fixture.code);
      assert.equal(name, "Owner");
      assert.equal(color, "#2563eb");
      assert.equal(recallHostToken(code), "owner-host-token");
    },
  });
  render(
    createElement(CollabSessionManager, {
      api,
      token: "saved-session-token",
      selfName: "Owner",
      color: "#2563eb",
      onOpened: (name) => opened.push(name),
    }),
  );
  await screen.findByText("Team A");
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.open") }));
  await waitFor(() => assert.deepEqual(opened, ["Team A"]));
  await waitFor(() =>
    assert.ok(calls.some((c) => c.method === "PATCH" && (c.body as { opened?: boolean }).opened)),
  );
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.rename") }));
  const rename = screen
    .getAllByRole("textbox", { name: t("collaborate.saved.nameLabel") })
    .find((el) => (el as HTMLInputElement).value === "Team A")!;
  fireEvent.change(rename, { target: { value: "Team B" } });
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.save") }));
  await screen.findByText("Team B");
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.delete") }));
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 0);
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.confirmDelete") }));
  await screen.findByText(t("collaborate.saved.empty"));
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 2);
  assert.ok(deletes[0].url.endsWith(`/sessions/${fixture.code}`));
  assert.ok(deletes[1].url.endsWith("/api/collab-sessions/saved"));
});

it("creates a persistent session and saves its owner token with the chosen name", async () => {
  const starts: unknown[][] = [];
  const stored: unknown[] = [];
  const opened: string[] = [];
  mockFetch(async (_input, init) => {
    if (init?.method === "POST") {
      stored.push(JSON.parse(String(init.body)));
      return Response.json({ session: fixture }, { status: 201 });
    }
    return Response.json({ sessions: [] });
  });
  const api = collaborationApi({
    async start(...args) {
      starts.push(args);
      rememberHostToken(fixture.code, "new-host-token");
      return fixture.code;
    },
  });
  render(
    createElement(CollabSessionManager, {
      api,
      token: "token",
      selfName: "Owner",
      color: "#16a34a",
      onOpened: (name) => opened.push(name),
    }),
  );
  await screen.findByText(t("collaborate.saved.empty"));
  fireEvent.change(screen.getByRole("textbox", { name: t("collaborate.saved.nameLabel") }), {
    target: { value: "  Bridge team  " },
  });
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.create") }));
  await waitFor(() => assert.equal(stored.length, 1));
  assert.deepEqual(starts, [["Owner", "#16a34a", "co-edit", false, { persistent: true }]]);
  assert.deepEqual(opened, ["Bridge team"]);
  assert.deepEqual(stored, [
    { code: fixture.code, name: "Bridge team", mode: "co-edit", hostToken: "new-host-token" },
  ]);
});

it("keeps a live session open if saving its list entry fails and exposes the failure", async () => {
  const opened: string[] = [];
  mockFetch(async (_input, init) =>
    init?.method === "POST"
      ? Response.json({ error: "storage unavailable" }, { status: 503 })
      : Response.json({ sessions: [] }),
  );
  const api = collaborationApi({
    async start() {
      rememberHostToken(fixture.code, "new-host-token");
      return fixture.code;
    },
  });
  render(
    createElement(CollabSessionManager, {
      api,
      token: "token",
      selfName: "Owner",
      color: "#16a34a",
      onOpened: (name) => opened.push(name),
    }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: t("collaborate.saved.nameLabel") }), {
    target: { value: "Team" },
  });
  fireEvent.click(screen.getByRole("button", { name: t("collaborate.saved.create") }));
  await screen.findByText(/storage unavailable/);
  assert.deepEqual(opened, ["Team"]);
});

function AccountProbe() {
  const { account, loading } = useSignedInAccount();
  return createElement("output", null, loading ? "loading" : (account?.username ?? "anonymous"));
}
function token(value: string) {
  act(() => {
    const store = useDesktopSettingsStore.getState();
    store.setDesktopSettings({ ...store.desktopSettings, shareToken: value });
  });
}
it("shares one account request per token across consumers and clears the display on sign-out", async () => {
  let reads = 0;
  mockFetch(async () => {
    reads++;
    return Response.json({ account: { id: "account", username: "Owner" } });
  });
  token("dedup-account-token");
  render(createElement("div", null, createElement(AccountProbe), createElement(AccountProbe)));
  await waitFor(() => assert.equal(screen.getAllByText("Owner").length, 2));
  assert.equal(reads, 1);
  token("");
  assert.equal(screen.getAllByText("anonymous").length, 2);
});

it("ignores an obsolete account response when the saved token changes", async () => {
  let first: ((response: Response) => void) | undefined;
  mockFetch(async (_input, init) => {
    if (new Headers(init?.headers).get("Authorization") === "Bearer old-account-token")
      return new Promise<Response>((resolve) => {
        first = resolve;
      });
    return Response.json({ account: { id: "new", username: "New owner" } });
  });
  token("old-account-token");
  render(createElement(AccountProbe));
  await waitFor(() => assert.ok(first));
  token("new-account-token");
  await screen.findByText("New owner");
  await act(async () => {
    first!(Response.json({ account: { id: "old", username: "Old owner" } }));
  });
  assert.equal(screen.queryByText("Old owner"), null);
  assert.ok(screen.getByText("New owner"));
});
