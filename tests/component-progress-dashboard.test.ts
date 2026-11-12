import { act, fireEvent, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";
import { clearHistory, projectFromStore, serializeProject } from "@geolibre/core";
import { todayIso } from "../apps/geolibre-desktop/src/lib/construction-progress";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  normalizeProgressV2,
  PROGRESS_V2_ITEM_KEYS,
  type ProgressV2,
} from "../apps/geolibre-desktop/src/lib/progress-v2";

const { ConstructionProgressScreen } =
  await import("../apps/geolibre-desktop/src/components/progress/ConstructionProgressScreen");
const { ProgressV2Profile } =
  await import("../apps/geolibre-desktop/src/components/progress/ProgressV2Profile");
const { closeProgressScreen, openProgressScreen } =
  await import("../apps/geolibre-desktop/src/lib/progress-screen");
const { PROGRESS_METADATA_KEY } =
  await import("../apps/geolibre-desktop/src/lib/construction-progress");
function config(): ProgressV2 {
  return normalizeProgressV2({
    version: 2,
    meta: { title: "Dashboard route", reportDate: "2020-01-01" },
    packages: [{ id: "p", name: "Package A", fromStation: 0, toStation: 1000 }],
    weights: Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, 1])),
    plan: { p: { coc: 100, be: 100 } },
    bridges: [
      {
        id: "b",
        name: "Bridge A",
        station: 100,
        supports: [{ id: "M1", inc: true, coc: { t: 1 }, piles: [0], be: 100, than: 0, xm: 0 }],
        spans: [],
      },
    ],
    road: { km: [{ id: "Km0", from: 0, to: 1000, pct: { nen: 100 } }] },
  })!;
}
function mount() {
  const state = config();
  const layer = geojsonLayer({
    id: "progress",
    metadata: { [PROGRESS_METADATA_KEY]: state },
    filterExpression: ["==", ["get", "keep"], true],
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [106, 10] },
          properties: { keep: true, bridge_id: "b", support_id: "M1", pile_index: 0 },
        },
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [106.1, 10.1] },
          properties: { keep: true, km_id: "Km0", progress_item: "nen" },
        },
      ],
    },
  });
  act(() => {
    useAppStore.setState({ layers: [layer], isDirty: false });
    openProgressScreen(layer.id);
  });
  const fits: number[][] = [];
  const result = render(
    createElement(ConstructionProgressScreen, {
      camera: { fitBounds: (bounds) => fits.push(bounds) },
    }),
  );
  return { ...result, state, layer, fits };
}
function current() {
  return useAppStore.getState().layers.find((layer) => layer.id === "progress")!;
}
afterEach(() => closeProgressScreen());

it("opens dashboard, cross-filters charts and map, zooms alerts, and restores the editing view", () => {
  const { fits, layer, unmount } = mount();
  clearHistory();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  assert.ok(document.documentElement.hasAttribute("data-progress-dashboard"));
  assert.ok(current().progressDashboard);
  assert.equal(useAppStore.getState().isDirty, false);
  const filters = screen.getByText("Filters").closest("aside")!;
  fireEvent.click(within(filters).getByRole("checkbox", { name: "Road" }));
  assert.ok(JSON.stringify(current().progressDashboard!.filter).includes("[1]"));
  assert.ok(!JSON.stringify(current().progressDashboard!.filter).includes("[0]"));
  assert.equal(current().geojson, layer.geojson);
  assert.deepEqual(current().filterExpression, layer.filterExpression);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
  assert.ok(
    !serializeProject(projectFromStore(useAppStore.getState())).includes('"progressDashboard"'),
  );
  act(() => useAppStore.getState().updateLayer("progress", { progressDashboard: undefined }));
  assert.ok(current().progressDashboard);
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  const itemsChart = screen.getByText("Work items · largest delays first").closest("section")!;
  fireEvent.click(within(itemsChart).getByRole("button", { name: /Piles/ }));
  assert.equal(
    within(filters).getByRole("checkbox", { name: "Piles" }).getAttribute("type"),
    "checkbox",
  );
  assert.ok(JSON.stringify(current().progressDashboard!.filter).includes("[0]"));
  const delays = screen.getByText("Largest delays and alerts").closest("section")!;
  const before = fits.length;
  fireEvent.click(within(delays).getAllByRole("button")[0]);
  assert.ok(fits.length > before);
  fireEvent.click(screen.getByRole("button", { name: "Edit progress" }));
  assert.equal(document.documentElement.hasAttribute("data-progress-dashboard"), false);
  assert.equal(current().progressDashboard, undefined);
  assert.ok(screen.getByRole("button", { name: "Update" }));
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  unmount();
  assert.equal(current().progressDashboard, undefined);
});
it("resets a removed package and closes weeks using today's date", () => {
  const { state } = mount();
  const packageSelect = screen.getByRole("combobox", { name: "Package" }) as HTMLSelectElement;
  fireEvent.change(packageSelect, { target: { value: "p" } });
  assert.equal(packageSelect.value, "p");
  act(() =>
    useAppStore.getState().updateLayer("progress", {
      metadata: { [PROGRESS_METADATA_KEY]: { ...state, packages: [] } },
    }),
  );
  assert.equal(packageSelect.value, "");
  fireEvent.click(screen.getByRole("button", { name: "Record week" }));
  const history = (current().metadata[PROGRESS_METADATA_KEY] as ProgressV2).history;
  assert.equal(history.length, 1);
  assert.equal(history[0].date, todayIso());
  assert.notEqual(history[0].date, state.meta.reportDate);
  assert.equal(
    (current().metadata[PROGRESS_METADATA_KEY] as ProgressV2).meta.reportDate,
    history[0].date,
  );
});
it("colors profile piles by pile completion and uses weighted road percentages", () => {
  const state = config();
  const props = {
    state,
    packageId: null,
    bridges: state.bridges,
    bridge: state.bridges[0],
    onBridge: () => {},
    onOpen: () => {},
  };
  const result = render(createElement(ProgressV2Profile, props));
  const support = result.container.querySelector('g[role="button"]')!;
  assert.equal(support.querySelector("rect")!.getAttribute("fill"), "#edf1ef");
  result.unmount();
  Object.assign(
    state.weights,
    Object.fromEntries(PROGRESS_V2_ITEM_KEYS.map((key) => [key, key === "nen" ? 1 : 0])),
  );
  render(createElement(ProgressV2Profile, { ...props, bridge: null, bridges: [] }));
  assert.ok(screen.getByRole("button", { name: /Km0 100%/ }));
});

it("renders a missing underpass station as unknown rather than NaN", () => {
  const { state } = mount();
  act(() =>
    useAppStore.getState().updateLayer("progress", {
      metadata: {
        [PROGRESS_METADATA_KEY]: {
          ...state,
          underpasses: [{ id: "unknown", pct: { tuong: 0, nap: 0 } }],
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Work items" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Work items" }), {
    target: { value: "ham_tuong" },
  });
  assert.ok(screen.getByText("—"));
  assert.equal(screen.queryByText("NaN"), null);
});

it("clears bridge and station selections that belong to the previous package", () => {
  const { state } = mount();
  const second = {
    ...structuredClone(state.bridges[0]),
    id: "b2",
    name: "Bridge B",
    station: 2000,
  };
  act(() =>
    useAppStore.getState().updateLayer("progress", {
      metadata: {
        [PROGRESS_METADATA_KEY]: {
          ...state,
          packages: [
            ...state.packages,
            { id: "p2", name: "Package B", fromStation: 1000, toStation: 3000 },
          ],
          bridges: [...state.bridges, second],
          road: {
            km: [...state.road.km, { ...state.road.km[0], id: "Km1", from: 1000, to: 3000 }],
          },
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  const packages = screen.getByRole("combobox", { name: "Package" });
  fireEvent.change(packages, { target: { value: "p" } });
  const filters = screen.getByText("Filters").closest("aside")!;
  fireEvent.click(within(filters).getByRole("checkbox", { name: "Bridge A" }));
  fireEvent.change(within(filters).getByRole("slider", { name: "To" }), {
    target: { value: "200" },
  });
  fireEvent.change(packages, { target: { value: "p2" } });
  assert.equal(within(filters).queryByRole("checkbox", { name: "Bridge A" }), null);
  assert.equal(
    (within(filters).getByRole("checkbox", { name: "Bridge B" }) as HTMLInputElement).checked,
    false,
  );
  assert.equal(screen.queryByText("No components match these filters."), null);
});
