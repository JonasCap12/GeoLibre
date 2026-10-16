import { act, fireEvent, render, screen, stubLayout, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Feature } from "geojson";

// Loaded after the harness so its CSS imports and Vite globals are handled.
const { ConstructionProgressScreen } =
  await import("../apps/geolibre-desktop/src/components/progress/ConstructionProgressScreen");
const { closeProgressScreen, openProgressScreen, PROGRESS_SCREEN_ATTRIBUTE } =
  await import("../apps/geolibre-desktop/src/lib/progress-screen");
const { PROGRESS_METADATA_KEY, PROGRESS_STATUS_PROPERTY, readProgressConfig } =
  await import("../apps/geolibre-desktop/src/lib/construction-progress");

function pile(x: number, status?: string): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [x, 10] },
    properties: { Layer: "COC", ...(status ? { [PROGRESS_STATUS_PROPERTY]: status } : {}) },
  };
}

const DRAWING = {
  id: "drawing",
  name: "Cầu Hồng Hà",
  type: "geojson",
  visible: true,
  opacity: 1,
  source: { type: "geojson" },
  style: {},
  metadata: {
    [PROGRESS_METADATA_KEY]: {
      title: "Cầu Hồng Hà",
      items: [
        {
          key: "coc",
          name: "Cọc",
          weight: 1,
          cadLayers: ["COC"],
          measure: "count",
          plannedPct: 60,
        },
        { key: "be", name: "Bệ", weight: 1, cadLayers: ["BE"], measure: "count", plannedPct: 40 },
        { key: "dam", name: "Dầm", weight: 2, cadLayers: ["DAM"], measure: "count" },
      ],
      notes: "Thiếu bản vẽ bệ P053\nChờ TVTK xác nhận P057",
    },
  },
  geojson: {
    type: "FeatureCollection",
    features: [pile(106, "done"), pile(106.1, "done"), pile(106.2, "wip"), pile(106.3)],
  },
} as unknown as GeoLibreLayer;

function storedConfig() {
  const layer = useAppStore.getState().layers.find((l) => l.id === DRAWING.id)!;
  return readProgressConfig(layer)!;
}

/** Render the screen over a store holding the drawing, opened on it. */
function renderScreen() {
  const fits: unknown[] = [];
  const camera = { fitBounds: (bounds: [number, number, number, number]) => fits.push(bounds) };
  act(() => {
    useAppStore.setState({ layers: [DRAWING] });
    openProgressScreen(DRAWING.id);
  });
  render(createElement(ConstructionProgressScreen, { camera }));
  return { fits };
}

function itemButton(name: string): HTMLElement {
  return screen.getByRole("button", { name: new RegExp(`^${name}`) });
}

afterEach(() => closeProgressScreen());

describe("ConstructionProgressScreen", () => {
  it("renders nothing until a drawing is opened", () => {
    render(createElement(ConstructionProgressScreen, { camera: null }));
    assert.equal(screen.queryByRole("banner"), null);
    assert.equal(document.documentElement.hasAttribute(PROGRESS_SCREEN_ATTRIBUTE), false);
  });

  it("shows the figures from the drawing and pins the map while open", () => {
    stubLayout(400, 600);
    renderScreen();
    assert.equal(document.documentElement.hasAttribute(PROGRESS_SCREEN_ATTRIBUTE), true);
    const header = screen.getByRole("banner", { name: "Construction progress" });
    // Cọc: 2 done + ½ of 1 in progress of 4 = 62.5 %; the other items read 0.
    assert.match(header.textContent ?? "", /Cầu Hồng Hà/);
    assert.match(header.textContent ?? "", /Actual15\.6%/);
    assert.match(header.textContent ?? "", /Planned25%/);
    assert.match(header.textContent ?? "", /Deviation-9\.4/);
    assert.match(itemButton("Cọc").textContent ?? "", /62\.5%/);
    assert.match(itemButton("Dầm").textContent ?? "", /0%/);
    assert.ok(screen.getByText("Thiếu bản vẽ bệ P053"));

    act(() => fireEvent.click(screen.getByRole("button", { name: "Close" })));
    assert.equal(screen.queryByRole("banner"), null);
    assert.equal(document.documentElement.hasAttribute(PROGRESS_SCREEN_ATTRIBUTE), false);
  });

  it("folds the items that do not fit into a +N line", () => {
    // 70 px less the list padding holds two 30 px rows: one item and "+2 more".
    stubLayout(400, 70);
    renderScreen();
    assert.ok(itemButton("Cọc"));
    assert.equal(screen.queryByRole("button", { name: /^Bệ/ }), null);
    assert.ok(screen.getByText("+2 more"));
  });

  it("selects a work item's features and fits the map to them", () => {
    stubLayout(400, 600);
    const { fits } = renderScreen();
    act(() => fireEvent.click(itemButton("Cọc")));
    const state = useAppStore.getState();
    assert.equal(state.selectedLayerId, DRAWING.id);
    assert.deepEqual(state.selectedFeatureIds, ["0", "1", "2", "3"]);
    assert.deepEqual(fits, [[106, 10, 106.3, 10]]);
    // The selection is now a mark target.
    assert.equal(
      (screen.getByRole("radio", { name: "Selection (4)" }) as HTMLButtonElement).disabled,
      false,
    );
  });

  it("marks the selected features done", () => {
    stubLayout(400, 600);
    renderScreen();
    act(() => {
      useAppStore.getState().selectLayer(DRAWING.id);
      useAppStore.getState().selectFeatures(["3"]);
    });
    act(() => fireEvent.click(screen.getByRole("radio", { name: "Selection (1)" })));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Done" })));
    const features = useAppStore.getState().layers[0].geojson!.features;
    assert.equal(features[3].properties?.[PROGRESS_STATUS_PROPERTY], "done");
    assert.match(itemButton("Cọc").textContent ?? "", /87\.5%/);
  });

  it("records the week in the drawing's setup", () => {
    stubLayout(400, 600);
    renderScreen();
    assert.ok(screen.getByText("Record a week to start the chart."));
    act(() => fireEvent.click(screen.getByRole("button", { name: "Record week" })));
    const weekly = storedConfig().weekly;
    assert.equal(weekly.length, 1);
    assert.equal(weekly[0].actualPct, 15.6);
    assert.equal(weekly[0].plannedPct, 25);
    assert.equal(screen.queryByText("Record a week to start the chart."), null);
  });

  it("saves a manual percent from the settings dialog", () => {
    stubLayout(400, 600);
    renderScreen();
    act(() => fireEvent.click(screen.getByRole("button", { name: "Settings" })));
    const dialog = screen.getByRole("dialog", { name: "Progress settings" });
    const manual = within(dialog).getAllByRole("textbox", { name: "Manual %" });
    act(() => fireEvent.change(manual[2], { target: { value: "40" } }));
    act(() => fireEvent.click(within(dialog).getByRole("button", { name: "Save" })));
    assert.equal(screen.queryByRole("dialog"), null);
    assert.equal(storedConfig().items[2].overridePct, 40);
    assert.match(itemButton("Dầm").textContent ?? "", /manual\s*40%/);
  });

  it("closes when the drawing is removed", () => {
    stubLayout(400, 600);
    renderScreen();
    act(() => useAppStore.setState({ layers: [] }));
    assert.equal(screen.queryByRole("banner"), null);
    assert.equal(document.documentElement.hasAttribute(PROGRESS_SCREEN_ATTRIBUTE), false);
  });
});
