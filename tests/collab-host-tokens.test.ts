import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_REMEMBERED_HOST_TOKENS,
  recallHostToken,
  rememberHostToken,
} from "../apps/geolibre-desktop/src/lib/collab-host-tokens";

/**
 * A host who left their own session and rejoined by code came back as a guest,
 * with no way to regain control of a session they created. The relay was never
 * the problem: it compares the token on every join and never rotates it, so it
 * has always been willing to hand host back. The client discarded the token
 * after `start()`, so there was nothing to present.
 *
 * These cases pin the part that was missing — the token surviving a leave — and
 * the storage failures that must not take the join path down with them.
 */
function withStorage(run: (control: { break: () => void }) => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let stored: string | null = null;
  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
    });
    run({
      break: () => {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          get() {
            throw new Error("blocked");
          },
        });
      },
    });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

describe("collaboration host tokens", () => {
  it("hands the token back when the host rejoins their own session", () => {
    withStorage(() => {
      rememberHostToken("K7P2QX99", "host-token-1");
      // Leaving does not clear it: coming back as host is the point.
      assert.equal(recallHostToken("K7P2QX99"), "host-token-1");
    });
  });

  it("matches the code however the user typed it", () => {
    withStorage(() => {
      // `join()` upper-cases whatever was typed before connecting, so a lookup
      // that did not normalize the same way would never find the token.
      rememberHostToken("k7p2qx99", "host-token-1");
      assert.equal(recallHostToken("  K7p2Qx99  "), "host-token-1");
    });
  });

  it("returns nothing for a session this device did not create", () => {
    withStorage(() => {
      rememberHostToken("K7P2QX99", "host-token-1");
      // A guest joining someone else's session must stay a guest.
      assert.equal(recallHostToken("ZZZZZZZZ"), undefined);
    });
  });

  it("keeps tokens for several sessions at once", () => {
    withStorage(() => {
      rememberHostToken("AAAAAAAA", "token-a");
      rememberHostToken("BBBBBBBB", "token-b");
      assert.equal(recallHostToken("AAAAAAAA"), "token-a");
      assert.equal(recallHostToken("BBBBBBBB"), "token-b");
    });
  });

  it("replaces the token when the same code is hosted again", () => {
    withStorage(() => {
      rememberHostToken("AAAAAAAA", "token-old");
      rememberHostToken("AAAAAAAA", "token-new");
      assert.equal(recallHostToken("AAAAAAAA"), "token-new");
    });
  });

  it("bounds what it stores so a long-lived profile cannot grow without limit", () => {
    withStorage(() => {
      for (let index = 0; index < MAX_REMEMBERED_HOST_TOKENS + 5; index += 1) {
        rememberHostToken(`S${String(index).padStart(7, "0")}`, `token-${index}`);
      }
      // The most recent survives; the oldest falls off.
      const newest = `S${String(MAX_REMEMBERED_HOST_TOKENS + 4).padStart(7, "0")}`;
      assert.equal(recallHostToken(newest), `token-${MAX_REMEMBERED_HOST_TOKENS + 4}`);
      assert.equal(recallHostToken("S0000000"), undefined);
    });
  });

  it("joins as a guest rather than throwing when storage is unavailable", () => {
    withStorage((control) => {
      control.break();
      // A private window must still be able to join; only the host handback is
      // lost, and that must not surface as a crash on the join path.
      assert.doesNotThrow(() => rememberHostToken("K7P2QX99", "host-token-1"));
      assert.equal(recallHostToken("K7P2QX99"), undefined);
    });
  });

  it("starts over on a corrupt stored value instead of failing every join", () => {
    withStorage(() => {
      globalThis.localStorage.setItem("geolibre:collab-host-tokens", "not json");
      assert.equal(recallHostToken("K7P2QX99"), undefined);
      rememberHostToken("K7P2QX99", "host-token-1");
      assert.equal(recallHostToken("K7P2QX99"), "host-token-1");
    });
  });

  it("ignores entries that are not shaped like a remembered token", () => {
    withStorage(() => {
      globalThis.localStorage.setItem(
        "geolibre:collab-host-tokens",
        JSON.stringify([{ sessionId: "K7P2QX99" }, null, 42, { token: "orphan" }]),
      );
      assert.equal(recallHostToken("K7P2QX99"), undefined);
    });
  });
});
