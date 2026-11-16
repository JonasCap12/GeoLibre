import assert from "node:assert/strict";
import { once } from "node:events";
import { it } from "node:test";
import { WebSocket } from "ws";
import { createRelay } from "../workers/collab-node/src/server";
import type {
  ClientMessage,
  ServerMessage,
  WelcomeMessage,
} from "../packages/collab-core/src/protocol";

it("exchanges presenter protocol messages, ignores invalid/no-op claims, and releases on leave", async (t) => {
  const relay = createRelay({ dbPath: ":memory:" });
  t.after(() => relay.close());
  relay.server.listen(0, "127.0.0.1");
  await once(relay.server, "listening");
  const address = relay.server.address();
  assert.ok(address && typeof address === "object");
  const http = `http://127.0.0.1:${address.port}`;
  const created = (await (await fetch(`${http}/sessions`, { method: "POST" })).json()) as {
    sessionId: string;
    hostToken: string;
  };

  async function peer(hostToken?: string) {
    const socket = new WebSocket(`${http.replace("http", "ws")}/sessions/${created.sessionId}/ws`);
    t.after(() => socket.terminate());
    const messages: ServerMessage[] = [];
    socket.on("message", (raw) => {
      messages.push(JSON.parse(raw.toString()) as ServerMessage);
    });
    await once(socket, "open");
    const send = (message: ClientMessage) => socket.send(JSON.stringify(message));
    async function next<K extends ServerMessage["type"]>(type: K) {
      const deadline = AbortSignal.timeout(3000);
      for (;;) {
        const index = messages.findIndex((m) => m.type === type);
        if (index >= 0) return messages.splice(index, 1)[0] as Extract<ServerMessage, { type: K }>;
        await once(socket, "message", { signal: deadline });
      }
    }
    send({
      type: "join",
      clientId: "ignored",
      displayName: hostToken ? "Host" : "Guest",
      color: "#123456",
      hostToken,
    });
    const welcome: WelcomeMessage = await next("welcome");
    return { socket, send, next, messages, welcome };
  }

  const host = await peer(created.hostToken);
  const guest = await peer();
  assert.equal(host.welcome.presenter, null);
  host.send({ type: "present", active: true });
  assert.equal((await guest.next("presenter")).clientId, host.welcome.clientId);
  await host.next("presenter");

  // A following presence frame is a deterministic fence for the three no-ops.
  host.socket.send(JSON.stringify({ type: "present", active: "yes" }));
  host.send({ type: "present", active: true });
  guest.send({ type: "present", active: false });
  host.send({ type: "presence", cursor: { lng: 106, lat: 10 } });
  await guest.next("presence");
  guest.send({ type: "presence", cursor: { lng: 107, lat: 11 } });
  await host.next("presence");
  assert.equal(guest.messages.filter((m) => m.type === "presenter").length, 0);
  assert.equal(host.messages.filter((m) => m.type === "presenter").length, 0);

  host.send({ type: "present", active: false });
  assert.equal((await guest.next("presenter")).clientId, null);
  guest.send({ type: "present", active: true });
  assert.equal((await host.next("presenter")).clientId, null); // host's release acknowledgement
  assert.equal((await host.next("presenter")).clientId, guest.welcome.clientId);
  const late = await peer();
  assert.equal(late.welcome.presenter, guest.welcome.clientId);
  guest.socket.close();
  assert.equal((await host.next("presenter")).clientId, null);
});
