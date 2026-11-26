import { act, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
const { NetworkDashboardScreen } =
  await import("../apps/geolibre-desktop/src/components/network/NetworkDashboardScreen");
const { openNetworkDashboard, closeNetworkDashboard } =
  await import("../apps/geolibre-desktop/src/lib/network-dashboard-screen");

// Hand-made numbers, never an extract/copy of a private workbook.
const report = (date: string, piles: number, extra: Record<string, unknown> = {}) => ({
  goi: "XL02",
  date,
  mui: [
    { id: "M01", name: "Mũi 01", km0: 148000, km1: 149000 },
    { id: "M02", name: "Mũi 02", km0: 149000, km1: 150000 },
  ],
  work: [
    {
      part: "C",
      grp: "CVN Km149+300",
      name: "Bored piles",
      mui: "M02",
      unit: "piles",
      bvtk: 12,
      lk: piles,
      today: "Pile C3",
      tomorrow: "Pile C4",
    },
    { part: "C", grp: "CVN Km149+300", name: "Abutment footing", mui: "M02" },
    { part: "C", grp: "CVN Km149+300", name: "Pier cap", mui: "M02", unit: "caps", bvtk: 2 },
  ],
  ...extra,
});

function installBoard() {
  const stores: Record<string, Record<string, unknown>> = {
    docs: {
      "bcn/meta": {
        idx: { XL02: ["2026-11-13", "2026-11-17", "2026-11-19", "2026-11-20"] },
      },
      "bcn_XL02/2026-11-13": report("2026-11-13", 4),
      "bcn_XL02/2026-11-17": report("2026-11-17", 6),
      "bcn_XL02/2026-11-19": report("2026-11-19", 6),
      "bcn_XL02/2026-11-20": report("2026-11-20", 6, {
        issues: ["Site of abutment M2 at CVN Km149+300 not handed over", "Unrelated Km148+100"],
        photos: [{ caption: "Pile C3 at Km149+300", ref: { id: "p1" } }],
      }),
    },
    imgs: { p1: new Blob(["jpeg"], { type: "image/jpeg" }) },
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
            transaction(store: string, mode: string) {
              assert.equal(mode, "readonly");
              const transaction: Record<string, unknown> = {
                objectStore: () => ({ get: (key: string) => ({ result: stores[store][key] }) }),
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
  const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => "blob:photo";
  URL.revokeObjectURL = () => {};
  return () => {
    Object.defineProperty(window, "indexedDB", { configurable: true, value: previous });
    URL.createObjectURL = urls.create;
    URL.revokeObjectURL = urls.revoke;
  };
}

const layers = [
  {
    id: "route",
    name: "Route",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { Ten: "XL02 · Mũi 02" },
          geometry: {
            type: "LineString",
            coordinates: [
              [106, 10],
              [106, 10.01],
            ],
          },
        },
      ],
    },
  },
  {
    id: "structures",
    name: "Structures",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { Ten: "CVN Km149+300", Goi_thau: "XL02", Loai: "Overpass" },
          geometry: { type: "Point", coordinates: [106, 10.003] },
        },
      ],
    },
  },
] as unknown as GeoLibreLayer[];

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

describe("structure hover card", () => {
  it("shows the structure's report work, week, stall, issues and photo, and hides the line tooltip", async (test) => {
    test.after(installBoard());
    useAppStore.setState({ layers, isDirty: false });
    const history = useAppStore.temporal.getState().pastStates.length;
    const events = new Map<string, Set<(event: unknown) => void>>();
    let hits: unknown[] = [];
    const map = {
      on(name: string, handler: (event: unknown) => void) {
        events.set(name, (events.get(name) ?? new Set()).add(handler));
      },
      off(name: string, handler: (event: unknown) => void) {
        events.get(name)?.delete(handler);
      },
      queryRenderedFeatures: () => hits,
      getCanvas: () => ({ getBoundingClientRect: () => ({ x: 10, y: 20 }) }),
      resize() {},
      fitBounds() {},
      flyTo() {},
    };
    const camera = {
      fitBounds() {},
      getMap: () => map,
      setTransientHighlight() {},
    } as unknown as NonNullable<Parameters<typeof NetworkDashboardScreen>[0]["camera"]>;
    render(createElement(NetworkDashboardScreen, { camera }));
    act(() => openNetworkDashboard());
    await waitFor(() => assert.ok(screen.getByText("Abutment footing")));
    await flush();

    const move = (next: unknown[]) =>
      act(() => {
        hits = next;
        for (const fn of events.get("mousemove") ?? []) fn({ point: { x: 50, y: 60 } });
      });
    // A point drawn over its front's line: the structure wins.
    move([
      {
        source: "source-structures",
        properties: { Ten: "CVN Km149+300", Goi_thau: "XL02", Loai: "Overpass" },
        geometry: { type: "Point" },
      },
      {
        source: "source-route",
        properties: { __geolibre_progress_index: 0 },
        geometry: { type: "LineString" },
      },
    ]);
    await flush();

    const tooltips = screen.getAllByRole("tooltip");
    assert.equal(tooltips.length, 1, "the line tooltip gives way to the structure card");
    const card = tooltips[0];
    const text = card.textContent ?? "";
    assert.match(text, /CVN Km149\+300/);
    assert.match(text, /In progress/);
    assert.match(text, /Overpass · Package XL02 · Mũi 02/);
    assert.match(text, /Report 11\/20\/2026/);
    assert.match(text, /From 1 of 3 items with figures/);
    assert.match(text, /Pier capno done quantity yet/);
    assert.match(text, /Bored piles6\/12 piles50%/);
    assert.match(text, /Abutment footingno design quantity/);
    assert.match(text, /Past week: Bored piles \+2 piles \(\+16\.7%\)/);
    assert.match(text, /Done quantity unchanged for 3 days/);
    assert.match(text, /Today: Pile C3/);
    assert.match(text, /Tomorrow: Pile C4/);
    assert.match(text, /Issues: Site of abutment M2/);
    assert.doesNotMatch(text, /Unrelated/);
    assert.match(text, /Click to see it in the report/);
    await waitFor(() =>
      assert.equal(card.querySelector("img")?.getAttribute("alt"), "Pile C3 at Km149+300"),
    );

    move([]);
    assert.equal(screen.queryByRole("tooltip"), null);
    assert.equal(useAppStore.getState().isDirty, false);
    assert.equal(useAppStore.temporal.getState().pastStates.length, history);
    act(() => closeNetworkDashboard());
    assert.equal(events.get("mousemove")?.size ?? 0, 0);
  });
});
