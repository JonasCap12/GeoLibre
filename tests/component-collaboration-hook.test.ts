import { act, mockFetch, render, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { registerHooks } from "node:module";
import { it } from "node:test";
import { createElement } from "react";
import { WebSocket } from "ws";
import { createRelay } from "../workers/collab-node/src/server";
import type { CollaborationApi } from "../apps/geolibre-desktop/src/hooks/useCollaboration";

// Isolate the plugin registry boundary while exercising the actual hook,
// project snapshot builder, HTTP/WebSocket transports and relay.
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/hooks/usePlugins"))
      return {
        url: "data:text/javascript,export function getPluginManager(){return {getProjectState(){return {}}}}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { useCollaboration } = await import("../apps/geolibre-desktop/src/hooks/useCollaboration");

it("starts a real local relay session, sends chat/presenting messages and reclaims host after rejoining", async (t) => {
  t.after(() => hook.deregister());
  const relay = createRelay({ dbPath: ":memory:" });
  t.after(() => relay.close());
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  Object.assign(window, {
    __GEOLIBRE_DEPLOYMENT_ENV__: { VITE_GEOLIBRE_COLLAB_URL: base.replace("http", "ws") },
  });
  t.after(() => {
    delete (window as unknown as { __GEOLIBRE_DEPLOYMENT_ENV__?: unknown })
      .__GEOLIBRE_DEPLOYMENT_ENV__;
  });
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  t.after(() => {
    globalThis.WebSocket = originalSocket;
  });
  mockFetch(
    (input, init) =>
      new Promise<Response>((resolve, reject) => {
        const url = String(input);
        assert.ok(url.startsWith(base), "only the local relay may be contacted");
        const pending = request(
          url,
          {
            method: init?.method,
            headers: Object.fromEntries(new Headers(init?.headers)),
            signal: init?.signal ?? undefined,
          },
          (response) => {
            const parts: Buffer[] = [];
            response.on("data", (part: Buffer) => parts.push(part));
            response.on("end", () =>
              resolve(new Response(Buffer.concat(parts), { status: response.statusCode ?? 500 })),
            );
          },
        );
        pending.on("error", reject);
        if (init?.body) pending.write(String(init.body));
        pending.end();
      }),
  );
  let api: CollaborationApi | undefined;
  const ref = { current: null };
  function Probe() {
    api = useCollaboration(ref, 0);
    return createElement("output", null, "Collaboration hook");
  }
  const result = render(createElement(Probe));
  let code = "";
  await act(async () => {
    code = await api!.start("Owner", "#2563eb", "co-edit");
  });
  assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
  assert.equal(useAppStore.getState().collaboration.role, "host");
  assert.equal(api!.canEdit(), true);
  act(() => {
    assert.equal(api!.sendChat("Check the pier"), true);
    api!.setPresenting(true);
  });
  await waitFor(() =>
    assert.equal(useAppStore.getState().collaboration.chat.at(-1)?.text, "Check the pier"),
  );
  await waitFor(() => {
    const state = useAppStore.getState().collaboration;
    assert.equal(state.presenterClientId, state.clientId);
  });
  act(() => api!.leave());
  assert.equal(useAppStore.getState().collaboration.isActive, false);
  await act(async () => {
    await api!.join(code.toLowerCase(), "Owner again", "#16a34a");
  });
  assert.equal(useAppStore.getState().collaboration.role, "host");
  assert.equal(useAppStore.getState().collaboration.selfName, "Owner again");
  act(() => api!.leave());
  result.unmount();
});
