import { act, fireEvent, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
const { NetworkDashboardScreen } =
  await import("../apps/geolibre-desktop/src/components/network/NetworkDashboardScreen");
const { openNetworkDashboard, closeNetworkDashboard, isNetworkDashboardOpen } =
  await import("../apps/geolibre-desktop/src/lib/network-dashboard-screen");

const report = (goi: string, date = "2026-11-19", rate = 0.7) => ({
  goi,
  date,
  mui: [
    { id: "M01", name: "Mũi 01", km0: 148000, km1: 149000 },
    { id: "M02", name: "Mũi 02", km0: 149000, km1: 150000 },
  ],
  muiRows: [{ mui: "M01", rateFile: rate }],
  work: [
    {
      part: "D",
      grp: "Km148+200 – Km148+800",
      name: "Road work",
      mui: "M01",
      bvtk: 100,
      lk: 70,
      today: "20 m",
    },
    { part: "C", grp: "CVN Km149+300", name: "Footing", mui: "M02" },
  ],
});
function installReports() {
  const docs: Record<string, unknown> = {
    "bcn/meta": { idx: { XL01: ["2026-11-18", "2026-11-19"], XL02: ["2026-11-19"] } },
    "bcn_XL01/2026-11-19": report("XL01"),
    "bcn_XL01/2026-11-18": report("XL01", "2026-11-18", 0.3),
    "bcn_XL02/2026-11-19": report("XL02"),
  };
  const previous = window.indexedDB;
  Object.defineProperty(window, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const request: Record<string, unknown> = {};
        setTimeout(() => {
          request.result = {
            objectStoreNames: { contains: () => true },
            close() {},
            transaction(_store: string, mode: string) {
              assert.equal(mode, "readonly");
              const transaction: Record<string, unknown> = {
                objectStore: () => ({ get: (key: string) => ({ result: docs[key] }) }),
              };
              setTimeout(() => (transaction.oncomplete as () => void)?.(), 0);
              return transaction;
            },
          };
          (request.onsuccess as () => void)?.();
        }, 0);
        return request;
      },
    },
  });
  return () => Object.defineProperty(window, "indexedDB", { configurable: true, value: previous });
}
function routes(): GeoLibreLayer[] {
  const line = (name: string) => ({
    type: "Feature",
    properties: { Ten: name },
    geometry: {
      type: "LineString",
      coordinates: [
        [106, 10],
        [106, 10.01],
      ],
    },
  });
  const base = {
    name: "Route",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
  };
  return [
    {
      ...base,
      id: "route",
      geojson: {
        type: "FeatureCollection",
        features: [
          line("XL01 · Mũi 01"),
          line("XL02 · Mũi 02"),
          line("Unmatched"),
          line("XL02 · Mũi 01"),
        ],
      },
    },
    {
      ...base,
      id: "structures",
      geojson: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { Ten: "CVN Km149+300", Goi_thau: "XL02" },
            geometry: { type: "Point", coordinates: [106, 10] },
          },
        ],
      },
    },
  ] as unknown as GeoLibreLayer[];
}
const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

describe("report/map selection wiring", () => {
  it("map line and point clicks select/scroll report groups, hover restores selection, locate uses the controller, and clear leaves project/history intact", async (test) => {
    test.after(installReports());
    const layers = routes();
    useAppStore.setState({ layers, isDirty: false });
    const history = useAppStore.temporal.getState();
    const before = { past: history.pastStates.length, future: history.futureStates.length };
    const saved = JSON.stringify(layers);
    const events = new Map<string, Set<(event: unknown) => void>>();
    let hits: unknown[] = [],
      fits = 0,
      highlights = 0;
    let lastHighlight: unknown;
    const map = {
      on(name: string, handler: (event: unknown) => void) {
        const handlers = events.get(name) ?? new Set();
        handlers.add(handler);
        events.set(name, handlers);
      },
      off(name: string, handler: (event: unknown) => void) {
        events.get(name)?.delete(handler);
      },
      queryRenderedFeatures() {
        return hits;
      },
      resize() {},
      fitBounds() {
        fits++;
      },
      flyTo() {
        fits++;
      },
    };
    const camera = {
      fitBounds() {
        fits++;
      },
      getMap: () => map,
      setTransientHighlight(value: unknown) {
        lastHighlight = value;
        if (value) highlights++;
      },
    } as unknown as NonNullable<Parameters<typeof NetworkDashboardScreen>[0]["camera"]>;
    render(createElement(NetworkDashboardScreen, { camera }));
    act(() => openNetworkDashboard());
    await waitFor(() => assert.ok(screen.getByText("Road work")));
    await flush();
    const click = (next: unknown[]) =>
      act(() => {
        hits = next;
        for (const fn of events.get("click") ?? []) fn({ point: { x: 50, y: 50 } });
      });
    click([
      {
        source: "source-route",
        properties: { __geolibre_progress_index: 1 },
        geometry: { type: "LineString" },
      },
    ]);
    await flush();
    assert.equal(screen.getByRole("button", { name: "XL02" }).getAttribute("aria-pressed"), "true");
    assert.equal(
      document.querySelector('[data-front="M02"]')?.getAttribute("aria-current"),
      "true",
    );
    const selected = useAppStore.getState().layers[0].progressDashboard!.colorExpression;
    const header = screen.getByRole("button", { name: "Select Mũi 01 and show on map" });
    fireEvent.mouseEnter(header);
    assert.notEqual(useAppStore.getState().layers[0].progressDashboard!.colorExpression, selected);
    fireEvent.mouseLeave(header);
    assert.equal(useAppStore.getState().layers[0].progressDashboard!.colorExpression, selected);
    click([
      {
        source: "source-structures",
        properties: { Ten: "CVN Km149+300", Goi_thau: "XL02" },
        geometry: { type: "Point" },
      },
    ]);
    assert.equal(document.querySelectorAll('[data-selected-work="true"]').length, 1);
    click([
      {
        source: "source-route",
        properties: { __geolibre_progress_index: 2 },
        geometry: { type: "LineString" },
      },
    ]);
    assert.equal(
      document.querySelector('[data-front="M02"]')?.getAttribute("aria-current"),
      "true",
      "unmatched lines do nothing",
    );
    // Package XL01 has a matching line for the ranged road work.
    fireEvent.click(screen.getByRole("button", { name: "XL01" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Locate Road work on map" }));
    assert.equal(highlights, 1);
    assert.ok(lastHighlight);
    assert.ok(fits > 0);
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(isNetworkDashboardOpen(), true);
    assert.equal(lastHighlight, null);
    assert.equal(document.querySelector('[aria-current="true"]'), null);
    fireEvent.click(screen.getByRole("button", { name: "Select Mũi 01 and show on map" }));
    click([]);
    assert.equal(document.querySelector('[aria-current="true"]'), null);
    const latest = useAppStore.getState().layers[0].progressDashboard!.colorExpression;
    fireEvent.click(screen.getByRole("button", { name: "Earlier report" }));
    await flush();
    assert.notEqual(useAppStore.getState().layers[0].progressDashboard!.colorExpression, latest);
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, before.past);
    assert.equal(useAppStore.temporal.getState().futureStates.length, before.future);
    fireEvent.click(screen.getByRole("button", { name: "Map only" }));
    assert.equal(screen.queryByRole("radio", { name: "By report" }), null);
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(isNetworkDashboardOpen(), false);
    assert.equal(JSON.stringify(useAppStore.getState().layers), saved);
    assert.equal(events.get("click")?.size, 0);
    act(() => closeNetworkDashboard());
  });
});
