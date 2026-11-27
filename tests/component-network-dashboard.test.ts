import { act, fireEvent, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { NetworkDashboardScreen } =
  await import("../apps/geolibre-desktop/src/components/network/NetworkDashboardScreen");
const {
  openNetworkDashboard,
  closeNetworkDashboard,
  isNetworkDashboardOpen,
  NETWORK_DASHBOARD_ATTRIBUTE,
} = await import("../apps/geolibre-desktop/src/lib/network-dashboard-screen");

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

function fakeBoard() {
  const frame = screen.getByTitle("Daily construction report board") as HTMLIFrameElement;
  const doc = document.implementation.createHTMLDocument("board");
  doc.body.innerHTML = '<input id="fileIn" type="file" multiple hidden>';
  Object.defineProperty(frame, "contentDocument", { configurable: true, value: doc });
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: window });
  let picks = 0;
  doc.getElementById("fileIn")!.onclick = () => {
    picks++;
  };
  fireEvent.load(frame);
  return { doc, picks: () => picks };
}

const settleReview = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

const currentView = () => document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE);

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
    assert.ok(screen.getByRole("region", { name: "By report" }));
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

  it("opens the empty-state picker synchronously and restores split after either review close", async () => {
    useAppStore.setState({ layers: [routesLayer()] });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "split");
    assert.equal(
      document.querySelector(".network-dashboard-board")?.hasAttribute("hidden"),
      true,
      "the original board stays mounted but hidden around the map",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    assert.ok(screen.getByText(/No daily reports in this browser yet/));
    fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
    assert.equal(board.picks(), 1, "picker opens before the click handler returns");
    assert.equal(currentView(), "split", "cancelling the picker leaves the view alone");
    await settleReview();
    assert.equal(currentView(), "split");
    for (const close of ["apply", "cancel"]) {
      if (close === "cancel") fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
      const dialog = board.doc.createElement("div");
      dialog.id = "upOv";
      board.doc.body.appendChild(dialog);
      await settleReview();
      assert.equal(currentView(), "report");
      assert.equal(
        document.querySelector(".network-dashboard-board")?.hasAttribute("hidden"),
        false,
      );
      assert.notEqual(localStorage.getItem("geolibre-network-dashboard-view"), "report");
      dialog.remove();
      await settleReview();
      assert.equal(currentView(), "split", close);
    }
    act(() => closeNetworkDashboard());
  });

  it("keeps a manually chosen report view when the board's own review closes", async () => {
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    fireEvent.click(screen.getByRole("button", { name: "Report only" }));
    const dialog = board.doc.createElement("div");
    dialog.id = "upOv";
    board.doc.body.appendChild(dialog);
    await settleReview();
    dialog.remove();
    await settleReview();
    assert.equal(currentView(), "report");
    act(() => closeNetworkDashboard());
  });

  it("honours an explicit view choice during a panel-requested review", async () => {
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
    const dialog = board.doc.createElement("div");
    dialog.id = "upOv";
    board.doc.body.appendChild(dialog);
    await settleReview();
    assert.equal(currentView(), "report");
    fireEvent.click(screen.getByRole("button", { name: "Report only" }));
    dialog.remove();
    await settleReview();
    assert.equal(currentView(), "report");
    act(() => closeNetworkDashboard());
  });

  it("hands focus and Escape to the board's review instead of closing the dashboard", async () => {
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
    const review = board.doc.createElement("div");
    review.id = "upOv";
    review.innerHTML = '<div role="dialog"><button data-x>Đóng</button></div>';
    let focused = 0;
    review.querySelector("button")!.focus = () => {
      focused++;
    };
    board.doc.body.appendChild(review);
    await settleReview();
    assert.equal(currentView(), "report");
    assert.equal(focused, 1, "keyboard focus moves into the review");
    // Focus can still be in the dashboard (a click outside the frame): Escape must not close it.
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(isNetworkDashboardOpen(), true);
    assert.equal(currentView(), "report");
    review.remove();
    await settleReview();
    assert.equal(currentView(), "split");
    fireEvent.keyDown(window, { key: "Escape" });
    assert.equal(isNetworkDashboardOpen(), false, "with no dialog open, Escape closes as before");
  });

  it("forgets a cancelled picker, so a later board dialog does not take over the view", async () => {
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
    board.doc.getElementById("fileIn")!.dispatchEvent(new Event("cancel"));
    const dialog = board.doc.createElement("div");
    dialog.id = "upOv";
    board.doc.body.appendChild(dialog);
    await settleReview();
    assert.equal(currentView(), "split");
    act(() => closeNetworkDashboard());
  });

  it("uses the picker with a synced source and ignores review changes after unmount", async () => {
    localStorage.setItem("bcn-links", '{"XL01":"https://example.sharepoint.com/report.xlsx"}');
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    const board = fakeBoard();
    fireEvent.click(screen.getByRole("button", { name: "Load reports" }));
    assert.equal(board.picks(), 1);
    assert.equal(currentView(), "split");
    act(() => closeNetworkDashboard());
    const dialog = board.doc.createElement("div");
    dialog.id = "upOv";
    board.doc.body.appendChild(dialog);
    await settleReview();
    assert.equal(currentView(), null);
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
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: window });
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

  it("refits a changed layout until a user input moves the map", async () => {
    useAppStore.setState({ layers: [routesLayer()] });
    const events = new Map<string, (event: { originalEvent?: Event }) => void>();
    let fits = 0;
    const map = {
      resize() {},
      fitBounds() {
        fits++;
      },
      on(name: string, callback: (event: { originalEvent?: Event }) => void) {
        events.set(name, callback);
      },
      off(name: string) {
        events.delete(name);
      },
    };
    const camera = { fitBounds() {}, getMap: () => map } as unknown as NonNullable<
      Parameters<typeof NetworkDashboardScreen>[0]["camera"]
    >;
    render(createElement(NetworkDashboardScreen, { camera }));
    act(() => openNetworkDashboard());
    const waitForFit = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
    await waitForFit();
    assert.equal(fits, 1);
    fireEvent.click(screen.getByRole("button", { name: "Map only" }));
    await waitForFit();
    assert.equal(fits, 2);
    fireEvent.click(screen.getByRole("button", { name: "Report only" }));
    await waitForFit();
    assert.equal(fits, 2);
    fireEvent.click(screen.getByRole("button", { name: "Map only" }));
    await waitForFit();
    assert.equal(fits, 3, "returning from the report refits even to the same earlier map view");
    act(() => events.get("movestart")?.({ originalEvent: new Event("wheel") }));
    fireEvent.click(screen.getByRole("button", { name: "Report + map" }));
    await waitForFit();
    assert.equal(fits, 3, "a user move keeps the camera across layout changes");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    assert.equal(fits, 4);
    fireEvent.click(screen.getByRole("button", { name: "Map only" }));
    await waitForFit();
    assert.equal(fits, 5, "after Show all, a layout change refits again");
    act(() => closeNetworkDashboard());
    assert.equal(events.size, 0);
  });

  it("shows two phone views, defaults to map and honors a saved report choice", (t) => {
    const previous = window.matchMedia;
    window.matchMedia = (query: string) =>
      ({
        matches: query.includes("max-width: 899"),
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList;
    t.after(() => {
      window.matchMedia = previous;
    });
    render(createElement(NetworkDashboardScreen, { camera: null }));
    act(() => openNetworkDashboard());
    assert.equal(screen.queryByRole("button", { name: "Report + map" }), null);
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "map");
    fireEvent.click(screen.getByRole("button", { name: "Report only" }));
    act(() => closeNetworkDashboard());
    act(() => openNetworkDashboard());
    assert.equal(document.documentElement.getAttribute(NETWORK_DASHBOARD_ATTRIBUTE), "report");
    act(() => closeNetworkDashboard());
  });
});
