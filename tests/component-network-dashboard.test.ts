import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { NetworkDashboardScreen } =
  await import("../apps/geolibre-desktop/src/components/network/NetworkDashboardScreen");
const { openNetworkDashboard, closeNetworkDashboard, NETWORK_DASHBOARD_ATTRIBUTE } =
  await import("../apps/geolibre-desktop/src/lib/network-dashboard-screen");

/** One degree of latitude: ~111.2 km. */
const ONE_DEGREE = [
  [106, 10],
  [106, 11],
];

function routesLayer(): GeoLibreLayer {
  const line = (status: string, type: string) => ({
    type: "Feature" as const,
    geometry: { type: "LineString" as const, coordinates: ONE_DEGREE },
    properties: { ten: `${type} ${status}`, trang_thai: status, loai: type },
  });
  return {
    id: "routes",
    name: "Tuyến dự án",
    type: "geojson",
    visible: true,
    opacity: 1,
    source: { type: "geojson" },
    style: {},
    geojson: {
      type: "FeatureCollection",
      features: [
        line("Đang thi công", "Cao tốc"),
        line("Đang thi công", "Cầu"),
        line("Hoàn thành", "Cao tốc"),
      ],
    },
  } as unknown as GeoLibreLayer;
}

describe("NetworkDashboardScreen", () => {
  it("embeds the board only while open, applies real map views and cleans up", () => {
    useAppStore.setState({ layers: [routesLayer()], isDirty: false });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    assert.equal(document.querySelector("iframe"), null);
    act(() => openNetworkDashboard());
    const frame = screen.getByTitle("Daily construction report board");
    assert.equal(frame.getAttribute("src"), "/daily-report/index.html");
    assert.equal(frame.getAttribute("allow"), "fullscreen");
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "split");
    assert.ok(screen.getByRole("region", { name: "Lines by status" }));
    assert.equal(screen.queryByText("Total length"), null);
    assert.ok(useAppStore.getState().layers[0].progressDashboard);
    assert.equal(useAppStore.getState().isDirty, false);
    const statusView = useAppStore.getState().layers[0].progressDashboard!.colorExpression;
    fireEvent.click(screen.getByRole("radio", { name: "Type" }));
    assert.notEqual(
      useAppStore.getState().layers[0].progressDashboard!.colorExpression,
      statusView,
    );
    act(() => closeNetworkDashboard());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(useAppStore.getState().layers[0].progressDashboard, undefined);
    assert.equal(document.documentElement.hasAttribute(NETWORK_DASHBOARD_ATTRIBUTE), false);
  });

  it("persists the selected view across closing and reopening", () => {
    useAppStore.setState({ layers: [routesLayer()] });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    fireEvent.click(screen.getByRole("button", { name: "Report only" }));
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "report");
    assert.equal(screen.queryByRole("region", { name: "Lines by status" }), null);
    act(() => closeNetworkDashboard());
    act(() => openNetworkDashboard());
    assert.equal(
      screen.getByRole("button", { name: "Report only" }).getAttribute("aria-pressed"),
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Map only" }));
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "map");
    assert.equal(document.querySelector(".network-dashboard-board")?.hasAttribute("hidden"), true);
    act(() => closeNetworkDashboard());
  });

  it("keeps the board available without lines, including the field setup action", () => {
    useAppStore.setState({ layers: [] });
    localStorage.setItem("geolibre-network-dashboard-view", "invalid");
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "split");
    assert.ok(screen.getByText("No project lines to show"));
    assert.ok(screen.getByTitle("Daily construction report board"));
    assert.equal(screen.getByRole("button", { name: "Show all" }).hasAttribute("disabled"), true);
    fireEvent.click(screen.getAllByRole("button", { name: "Layers and fields…" })[1]);
    assert.ok(screen.getByRole("dialog"));
    act(() => closeNetworkDashboard());
  });

  it("fits the network using the existing camera", () => {
    useAppStore.setState({ layers: [routesLayer()] });
    let fitted: unknown;
    render(
      createElement(NetworkDashboardScreen, {
        camera: {
          fitBounds(bounds) {
            fitted = bounds;
          },
        },
      }),
    );
    act(() => openNetworkDashboard());
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    assert.deepEqual(fitted, [106, 10, 106, 11]);
    act(() => closeNetworkDashboard());
  });

  it("frames once after transient views replace the layer objects", async () => {
    useAppStore.setState({ layers: [routesLayer()] });
    const fitted: number[][] = [];
    render(
      createElement(NetworkDashboardScreen, {
        camera: {
          fitBounds(bounds) {
            fitted.push(bounds);
          },
        },
      }),
    );
    act(() => openNetworkDashboard());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.deepEqual(fitted, [[106, 10, 106, 11]]);
    act(() => closeNetworkDashboard());
  });

  it("hides the board exit and follows the app theme on load and later changes", async () => {
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const frame = screen.getByTitle("Daily construction report board") as HTMLIFrameElement;
    const doc = document.implementation.createHTMLDocument("board");
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: doc });
    fireEvent.load(frame);
    assert.ok(doc.head.textContent?.includes("#bX { display: none !important; }"));
    assert.equal(doc.documentElement.getAttribute("data-theme"), "light");
    await act(async () => {
      document.documentElement.classList.add("dark");
    });
    assert.equal(doc.documentElement.getAttribute("data-theme"), "dark");
    await act(async () => {
      document.documentElement.classList.remove("dark");
    });
    assert.equal(doc.documentElement.getAttribute("data-theme"), "light");
    act(() => closeNetworkDashboard());
  });
});
