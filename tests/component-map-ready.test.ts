import { act, fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { MapEngine } from "@geolibre/map";
import type { FeatureCollection } from "geojson";
const { useMapReady } = await import("../apps/geolibre-desktop/src/hooks/useMapReady");

describe("the map-ready/highlight bridge", () => {
  it("advances readiness on every load and resolves the live engine even through an older callback", () => {
    const calls: string[] = [];
    const engine = (name: string) =>
      ({ setTransientHighlight: () => calls.push(name) }) as unknown as MapEngine;
    const controller = { current: engine("first") as MapEngine | null };
    const api = (host: typeof controller) => host.current;
    let highlight: ((features: FeatureCollection | null) => void) | undefined;
    let ready: (() => void) | undefined;
    const seen: (MapEngine | null)[] = [];
    const onReady = (
      app: MapEngine | null,
      bridge: (features: FeatureCollection | null) => void,
    ) => {
      seen.push(app);
      highlight = bridge;
    };
    function Probe() {
      const [generation, next] = useMapReady(controller, api, onReady);
      ready = next;
      return createElement("button", { onClick: next }, `Ready ${generation}`);
    }
    render(createElement(Probe));
    const first = ready;
    fireEvent.click(screen.getByRole("button", { name: "Ready 0" }));
    assert.equal(seen[0], controller.current);
    assert.equal(ready, first, "readiness updates keep the callback stable");
    const oldHighlight = highlight!;
    oldHighlight(null);
    controller.current = engine("replacement");
    oldHighlight({ type: "FeatureCollection", features: [] });
    fireEvent.click(screen.getByRole("button", { name: "Ready 1" }));
    assert.ok(screen.getByRole("button", { name: "Ready 2" }));
    assert.equal(seen[1], controller.current);
    assert.deepEqual(calls, ["first", "replacement"]);
    controller.current = null;
    assert.doesNotThrow(() => oldHighlight(null));
  });

  it("still advances without a consumer and does not construct an unused API", () => {
    let constructions = 0;
    const controller = { current: null };
    const api = () => {
      constructions++;
      return {};
    };
    let ready = () => {};
    function Probe() {
      const [generation, next] = useMapReady(controller, api, undefined);
      ready = next;
      return createElement("p", null, `Generation ${generation}`);
    }
    render(createElement(Probe));
    act(() => ready());
    assert.ok(screen.getByText("Generation 1"));
    assert.equal(constructions, 0);
  });
});
