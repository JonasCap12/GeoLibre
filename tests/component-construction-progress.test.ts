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

/** A bridge and a road, each split into components, for the structure view. */
const STRUCTURED = {
  ...DRAWING,
  id: "structured",
  metadata: {
    [PROGRESS_METADATA_KEY]: {
      title: "Tuyến",
      items: [
        { key: "coc", name: "Cọc khoan nhồi", cadLayers: ["COC"], measure: "count" },
        { key: "be", name: "Bệ trụ", cadLayers: ["BE"], measure: "count" },
        { key: "mat", name: "Mặt đường", cadLayers: ["MAT"], measure: "count" },
      ],
    },
  },
  geojson: {
    type: "FeatureCollection",
    features: [
      ["MAT", "Đường Km1", "Đoạn 1", 1, "done"],
      ["MAT", "Đường Km1", "Đoạn 2", 2, undefined],
      ["COC", "Cầu A", "M1", 10, "done"],
      ["COC", "Cầu A", "T1", 11, undefined],
      ["BE", "Cầu A", "T1", 11, undefined],
    ].map(([layer, structure, component, order, status], i) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [106 + i * 0.01, 10] },
      properties: {
        Layer: layer,
        cong_trinh: structure,
        cau_kien: component,
        thu_tu: order,
        ...(status ? { [PROGRESS_STATUS_PROPERTY]: status } : {}),
      },
    })),
  },
} as unknown as GeoLibreLayer;

function renderStructured() {
  const fits: unknown[] = [];
  act(() => {
    useAppStore.setState({ layers: [STRUCTURED] });
    openProgressScreen(STRUCTURED.id);
  });
  render(
    createElement(ConstructionProgressScreen, {
      camera: { fitBounds: (b: [number, number, number, number]) => fits.push(b) },
    }),
  );
  return { fits };
}

function statuses() {
  return useAppStore
    .getState()
    .layers[0].geojson!.features.map((f) => f.properties?.[PROGRESS_STATUS_PROPERTY] ?? null);
}

describe("ConstructionProgressScreen structures", () => {
  it("lists the structures in route order with their own percents", () => {
    stubLayout(400, 600);
    renderStructured();
    const list = screen.getByRole("list", { name: "Structures" });
    const rows = within(list)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    assert.equal(rows.length, 3);
    assert.match(rows[0] ?? "", /^Whole project/);
    // The road: 1 of 2 segments done = 50 %, its only item.
    assert.match(rows[1] ?? "", /^Đường Km1.*50%$/);
    // The bridge: piles 1 of 2 (50 %), caps 0 of 1, equal weights = 25 %.
    assert.match(rows[2] ?? "", /^Cầu A.*25%$/);
  });

  it("opens a structure's components by items and marks a cell from its menu", async () => {
    stubLayout(400, 600);
    const { fits } = renderStructured();
    act(() => fireEvent.click(screen.getByRole("listitem", { name: /Cầu A/ })));
    assert.equal(fits.length, 1);
    const grid = screen.getByRole("grid", { name: "Cầu A" });
    assert.deepEqual(
      within(grid)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
      ["M1", "T1"],
    );
    assert.deepEqual(
      within(grid)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
      ["Cọc khoan nhồi50%", "Bệ trụ0%"],
    );
    const cell = within(grid).getByRole("gridcell", {
      name: "T1 · Cọc khoan nhồi: 0 done, 0 in progress, 1 not started",
    });
    // Radix opens its menu on pointer down.
    act(() => fireEvent.pointerDown(cell, { button: 0, pointerType: "mouse" }));
    const done = await screen.findByRole("menuitem", { name: "Done" });
    act(() => fireEvent.click(done));
    assert.deepEqual(statuses(), ["done", null, "done", "done", null]);
  });

  it("marks features clicked on the map while the brush is on", () => {
    stubLayout(400, 600);
    renderStructured();
    act(() => fireEvent.click(screen.getByRole("radio", { name: "Click features" })));
    act(() => fireEvent.click(screen.getByRole("button", { name: /^In progress/ })));
    assert.ok(screen.getByText("Click features on the map to mark them: In progress"));
    // A click on the map lands as a selection of the feature under it.
    act(() => {
      useAppStore.getState().selectLayer(STRUCTURED.id);
      useAppStore.getState().selectFeatures(["4"]);
    });
    assert.equal(statuses()[4], "wip");
    assert.deepEqual(useAppStore.getState().selectedFeatureIds, []);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Stop" })));
    act(() => {
      useAppStore.getState().selectLayer(STRUCTURED.id);
      useAppStore.getState().selectFeatures(["1"]);
    });
    assert.equal(statuses()[1], null);
  });
});

describe("ConstructionProgressScreen folded structures", () => {
  it("keeps the structures that do not fit one click away", async () => {
    // 60 px less padding holds two 24 px rows: the project and "+2 more".
    stubLayout(400, 60);
    renderStructured();
    const list = screen.getByRole("list", { name: "Structures" });
    assert.equal(within(list).getAllByRole("listitem").length, 1);
    const more = within(list).getByRole("button", { name: "+2 more" });
    act(() => fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" }));
    const bridge = await screen.findByRole("menuitem", { name: /Cầu A/ });
    act(() => fireEvent.click(bridge));
    assert.ok(screen.getByRole("grid", { name: "Cầu A" }));
  });
});

describe("ConstructionProgressScreen folded items", () => {
  it("lists the items that do not fit in a menu that selects them", async () => {
    stubLayout(400, 70);
    const { fits } = renderScreen();
    act(() =>
      fireEvent.pointerDown(screen.getByRole("button", { name: "+2 more" }), {
        button: 0,
        pointerType: "mouse",
      }),
    );
    const hidden = await screen.findAllByRole("menuitem");
    assert.deepEqual(
      hidden.map((m) => m.textContent?.replace(/[\d.]+%$/, "")),
      ["Bệ", "Dầm"],
    );
    act(() => fireEvent.click(hidden[0]));
    // Bệ has no features in the drawing: it selects nothing and leaves the camera.
    assert.equal(fits.length, 0);
    assert.equal(useAppStore.getState().selectedLayerId, DRAWING.id);
  });
});
