import { act, fireEvent, i18n, render, screen, waitFor, useAppStore, within } from "./helpers/dom";
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
const { ProgressV2Dashboard } =
  await import("../apps/geolibre-desktop/src/components/progress/ProgressV2Dashboard");
import type { ProgressFeatureTarget } from "../apps/geolibre-desktop/src/lib/progress-colors";
const { closeProgressScreen, openProgressScreen } =
  await import("../apps/geolibre-desktop/src/lib/progress-screen");
const { PROGRESS_METADATA_KEY } =
  await import("../apps/geolibre-desktop/src/lib/construction-progress");
const { usePercentFormat } =
  await import("../apps/geolibre-desktop/src/components/progress/ProgressScreenBlocks");

it("formats percentages in the app language and reacts to language changes", async () => {
  function PercentProbe() {
    const fmt = usePercentFormat();
    return createElement("output", null, `${fmt(1234.56)}%`);
  }
  render(createElement(PercentProbe));
  try {
    for (const [language, expected] of [
      ["en", "1,234.6%"],
      ["vi", "1.234,6%"],
      ["en", "1,234.6%"],
    ]) {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
      assert.equal(screen.getByRole("status").textContent, expected);
    }
  } finally {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});

it("uses the app locale for Items percentages and stations", async () => {
  const { state } = mount();
  const edited = structuredClone(state);
  edited.bridges[0].supports[0].be = 12.5;
  edited.underpasses = [{ id: "station", station: 1234.5, pct: { tuong: 12.5, nap: 0 } }];
  act(() =>
    useAppStore.getState().updateLayer("progress", {
      metadata: { [PROGRESS_METADATA_KEY]: edited },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Work items" }));
  const select = document.getElementById("progress-v2-item")!;
  try {
    for (const [language, percent, station] of [
      ["en", "12.5%", "1,234.5"],
      ["vi", "12,5%", "1.234,5"],
    ]) {
      await act(async () => {
        await i18n.changeLanguage(language);
      });
      fireEvent.change(select, { target: { value: "be" } });
      assert.ok(screen.getAllByText(percent).length >= 2);
      fireEvent.change(select, { target: { value: "ham_tuong" } });
      assert.ok(screen.getByText(station));
    }
  } finally {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});
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

it("opens dashboard, cross-filters charts and map, zooms alerts, and restores the editing view", async () => {
  const { fits, layer, unmount } = mount();
  clearHistory();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  assert.ok(document.documentElement.hasAttribute("data-progress-dashboard"));
  assert.ok(current().progressDashboard);
  assert.equal(useAppStore.getState().isDirty, false);
  const filters = screen.getByText("Filters").closest("aside")!;
  fireEvent.click(within(filters).getByText("Structure type"));
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
  fireEvent.click(within(filters).getByText("Work items"));
  assert.equal(
    within(filters).getByRole("checkbox", { name: "Piles" }).getAttribute("type"),
    "checkbox",
  );
  assert.ok(JSON.stringify(current().progressDashboard!.filter).includes("[0]"));
  const delays = screen.getByText("Largest delays and alerts").closest("section")!;
  const before = fits.length;
  fireEvent.click(within(delays).getAllByRole("button")[0]);
  await waitFor(() => assert.ok(fits.length > before));
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
  fireEvent.click(within(filters).getByText("Structure / section"));
  fireEvent.click(within(filters).getByRole("checkbox", { name: "Bridge A" }));
  fireEvent.change(screen.getByRole("slider", { name: "To" }), {
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

it("exports the current week through the dashboard download button", async () => {
  mount();
  const urls: string[] = [];
  const originalCreate = URL.createObjectURL,
    originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = () => "blob:weekly-report";
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {
    urls.push(this.download);
  };
  try {
    fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Export week (.xlsx)" }));
    await waitFor(() => assert.equal(urls.length, 1), { timeout: 10000 });
    assert.equal(urls[0], "progress-all-2020-01-01.xlsx");
    assert.equal(screen.queryByRole("alert"), null);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

it("opens the correct target from delay summaries and expanded entries, and restores package bars", async () => {
  const { layer, state, unmount } = mount();
  unmount();
  const opened: ProgressFeatureTarget[] = [];
  const packages: (string | null)[] = [];
  render(
    createElement(ProgressV2Dashboard, {
      layer,
      state,
      packageId: null,
      throughDate: "",
      onPackage: (id) => packages.push(id),
      onOpen: (target) => opened.push(target),
      onFit: () => {},
    }),
  );
  const delays = screen.getByText("Largest delays and alerts").closest("section")!;
  fireEvent.click(
    within(delays.querySelector("summary")!).getByRole("button", { name: "Open M1" }),
  );
  assert.deepEqual(opened, [{ kind: "support", bridgeId: "b", id: "M1" }]);
  const details = delays.querySelector("details")!;
  fireEvent.click(details.querySelector("summary")!);
  fireEvent.click(
    within(details.querySelector(".dashboard-alert-entries")!).getAllByRole("button", {
      name: "Open M1",
    })[0],
  );
  assert.deepEqual(opened[1], opened[0]);
  const chart = screen.getByRole("region", { name: "Progress by package" });
  fireEvent.click(within(chart).getByRole("button", { name: /Package A/ }));
  assert.deepEqual(packages, ["p"]);
});

it("lands in the Update editor when a delayed component is opened", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  fireEvent.click(
    within(document.querySelector(".dashboard-alert-groups summary")!).getByRole("button", {
      name: "Open M1",
    }),
  );
  assert.equal(document.documentElement.hasAttribute("data-progress-dashboard"), false);
  assert.equal(screen.getByRole("button", { name: "Update" }).getAttribute("aria-pressed"), "true");
  assert.ok(screen.getByRole("heading", { name: "M1 · Bridge A" }));
  assert.equal(current().progressDashboard, undefined);
});

it("formats SPI with two decimals while retaining one decimal percentages in each app language", async () => {
  const { state } = mount();
  act(() =>
    useAppStore.getState().updateLayer("progress", {
      metadata: {
        [PROGRESS_METADATA_KEY]: {
          ...state,
          history: [
            { week: "2020-W01", date: "2020-01-01", packageId: null, actual: 38.3, planned: 39.7 },
          ],
        },
      },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Reporting week" }), {
    target: { value: "2020-01-01" },
  });
  try {
    assert.ok(screen.getByText("0.96"));
    assert.ok(screen.getByText("38.3%"));
    await act(async () => {
      await i18n.changeLanguage("vi");
    });
    assert.ok(screen.getByText("0,96"));
    assert.ok(screen.getByText("38,3%"));
  } finally {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
  }
});

it("initially frames the worst structure and keeps the full extent available", async () => {
  const { fits } = mount();
  fireEvent.click(screen.getByRole("button", { name: "Dashboard" }));
  await waitFor(() =>
    assert.match(
      document.querySelector(".dashboard-map-viewing")?.textContent ?? "",
      /Viewing: Bridge A/,
    ),
  );
  assert.deepEqual(fits.at(-1), [106, 10, 106, 10]);
  const strip = document.querySelector(".dashboard-chainage svg")!;
  assert.equal(strip.querySelectorAll("text").length, 0);
  fireEvent.click(screen.getByRole("button", { name: "View full route" }));
  assert.deepEqual(fits.at(-1), [106, 10, 106.1, 10.1]);
  assert.equal(document.querySelector(".dashboard-map-viewing"), null);
});
