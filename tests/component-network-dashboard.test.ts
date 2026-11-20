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

/** The figure under the "Total length" heading. */
function totalKm(): string | null | undefined {
  return screen.getByText("Total length").nextElementSibling?.textContent;
}

describe("NetworkDashboardScreen", () => {
  it("sums the project lines, filters them and cleans up on close", () => {
    useAppStore.setState({ layers: [routesLayer()], isDirty: false });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    assert.equal(screen.queryByText("Road and bridge projects"), null, "closed at first");

    act(() => openNetworkDashboard());

    assert.ok(screen.getByText("Road and bridge projects"));
    assert.equal(document.documentElement.hasAttribute(NETWORK_DASHBOARD_ATTRIBUTE), true);
    assert.equal(totalKm(), "333.6", "three lines of ~111.2 km");
    assert.ok(screen.getByText("3 lines"));
    const view = useAppStore.getState().layers[0].progressDashboard;
    assert.ok(view, "the map view is applied to the layer");
    assert.equal(
      useAppStore.getState().isDirty,
      false,
      "the view does not mark the project changed",
    );

    // Leave out the finished line.
    fireEvent.click(screen.getByRole("checkbox", { name: /Hoàn thành/ }));
    assert.equal(totalKm(), "222.4");
    assert.ok(screen.getByText("2 lines"));

    act(() => closeNetworkDashboard());
    assert.equal(useAppStore.getState().layers[0].progressDashboard, undefined);
    assert.equal(document.documentElement.hasAttribute(NETWORK_DASHBOARD_ATTRIBUTE), false);
  });

  it("explains what to add when the workspace has no lines", () => {
    useAppStore.setState({ layers: [] });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    assert.ok(screen.getByText("No project lines to show"));
    act(() => closeNetworkDashboard());
  });

  it("shows percent done against plan and the lines behind it", () => {
    const layer = routesLayer();
    const progress = [
      [100, 100],
      [20, 60],
      [70, 80],
    ];
    layer.geojson!.features.forEach((feature, i) => {
      feature.properties = {
        ...feature.properties,
        tien_do_pct: progress[i][0],
        ke_hoach_pct: progress[i][1],
      };
    });
    useAppStore.setState({ layers: [layer] });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());

    // Equal lengths: done (100 + 20 + 70) / 3, planned (100 + 60 + 80) / 3.
    assert.ok(screen.getByText("63.3%"));
    assert.ok(screen.getByText("80%"));
    const behind = screen.getByText("Behind plan", { selector: "h2" }).parentElement!;
    const rows = [...behind.querySelectorAll("tbody tr")].map((row) => row.textContent);
    assert.deepEqual(rows, ["Cầu Đang thi công20/60%-40", "Cao tốc Hoàn thành70/80%-10"]);
    assert.equal(screen.getAllByRole("slider").length, 2, "the percent-done range has two thumbs");
    assert.ok(screen.getByText("Share of length by status"));
    assert.ok(screen.getByText("Done against plan"));
    act(() => closeNetworkDashboard());
  });
});
