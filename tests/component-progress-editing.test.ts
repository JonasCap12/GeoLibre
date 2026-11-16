import { act, fireEvent, i18n, render, screen, useAppStore, within } from "./helpers/dom";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createElement } from "react";
import { clearHistory, undo } from "@geolibre/core";
import { geojsonLayer } from "./helpers/layer-fixtures";
import {
  normalizeProgressV2,
  computeProgressV2,
  type ProgressV2,
} from "../apps/geolibre-desktop/src/lib/progress-v2";
import {
  PROGRESS_METADATA_KEY,
  todayIso,
} from "../apps/geolibre-desktop/src/lib/construction-progress";

const { ConstructionProgressScreen } =
  await import("../apps/geolibre-desktop/src/components/progress/ConstructionProgressScreen");
const { openProgressScreen, closeProgressScreen } =
  await import("../apps/geolibre-desktop/src/lib/progress-screen");
const { ProgressV2Update } =
  await import("../apps/geolibre-desktop/src/components/progress/ProgressV2Update");
const { progressV2LayerPatch } = await import("../apps/geolibre-desktop/src/lib/progress-colors");
import type { ProgressFeatureTarget } from "../apps/geolibre-desktop/src/lib/progress-colors";
afterEach(() => closeProgressScreen());

function initial() {
  return normalizeProgressV2({
    version: 2,
    meta: { title: "Bridge works", reportDate: "2026-11-16" },
    packages: [{ id: "p", name: "Package A", fromStation: 0, toStation: 1000 }],
    weights: { coc: 1, be: 1, dc: 1, bmc: 1, nen: 1 },
    plan: { p: { coc: 100, be: 50, dc: 100 } },
    bridges: [
      {
        id: "b",
        name: "Bridge A",
        station: 100,
        yard: { beds: 2, curingDays: 7 },
        supports: [
          { id: "M1", coc: { t: 2, D: 1, L: 20 }, piles: [0, 0], inc: true, be: 0, than: 0, xm: 0 },
          { id: "M2", coc: { t: 1 }, piles: [2], inc: true, be: 100, than: 100, xm: 100 },
        ],
        spans: [
          {
            id: "N1",
            L: 30,
            bmc: 0,
            ht: 0,
            girders: [
              { t: "I30", st: 0, dob: "", bed: 1 },
              { t: "I30", st: 4, dob: "2026-11-01", bed: 0 },
            ],
          },
        ],
      },
    ],
    road: { km: [{ id: "Km0", from: 0, to: 1000, pct: { nen: 0 } }] },
    underpasses: [{ id: "H1", station: 500, pct: { tuong: 0, nap: 0 } }],
  })!;
}
function layer() {
  return useAppStore.getState().layers[0];
}
function state() {
  return layer().metadata[PROGRESS_METADATA_KEY] as ProgressV2;
}
function seed() {
  const config = initial();
  act(() => {
    useAppStore.setState({
      layers: [
        geojsonLayer({
          id: "progress",
          metadata: { [PROGRESS_METADATA_KEY]: config },
          geojson: {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { bridge_id: "b", support_id: "M1" },
                geometry: { type: "Point", coordinates: [106, 10] },
              },
            ],
          },
        }),
      ],
    });
    clearHistory();
  });
  return config;
}
function mount() {
  seed();
  act(() => openProgressScreen("progress"));
  render(createElement(ConstructionProgressScreen));
}
const text = (key: Parameters<typeof i18n.t>[0]) => String(i18n.t(key));

it("saves settings as a normalized metadata/color patch in exactly one undo step", () => {
  mount();
  const before = structuredClone(layer());
  fireEvent.click(screen.getByRole("button", { name: text("progress.settings") }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText(text("progress.field.title")), {
    target: { value: "Updated report" },
  });
  fireEvent.change(dialog.getByLabelText(text("progress.field.subtitle")), {
    target: { value: "Team A" },
  });
  fireEvent.click(dialog.getByRole("button", { name: text("common.save"), exact: true }));
  assert.equal(state().meta.title, "Updated report");
  assert.equal(state().meta.subtitle, "Team A");
  assert.equal(screen.queryByRole("dialog"), null);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 1);
  act(() => undo());
  assert.deepEqual(layer().metadata, before.metadata);
  assert.deepEqual(layer().geojson, before.geojson);
});

it("cancels a settings draft without changing the store or adding undo history", () => {
  mount();
  const before = structuredClone(state());
  fireEvent.click(screen.getByRole("button", { name: text("progress.settings") }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(dialog.getByLabelText(text("progress.field.title")), {
    target: { value: "Discard" },
  });
  fireEvent.click(dialog.getByRole("button", { name: text("common.cancel"), exact: true }));
  assert.deepEqual(state(), before);
  assert.equal(useAppStore.temporal.getState().pastStates.length, 0);
});

it("updates yard stages, counts, bed/date fields and the whole span", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: text("progress.v2.tabs.yard"), exact: true }));
  fireEvent.click(screen.getByTitle(`N1-D1: ${text("progress.v2.stage.0")}`));
  fireEvent.click(
    screen.getByRole("button", { name: `2. ${text("progress.v2.stage.2")}`, exact: true }),
  );
  assert.equal(state().bridges[0].spans[0].girders[0].st, 2);
  const cast = screen.getByText(text("progress.v2.yard.cast"), { selector: "span" });
  assert.equal(cast.parentElement?.querySelector("b")?.textContent, "2/2");
  fireEvent.change(screen.getByLabelText(text("progress.v2.pourDate")), {
    target: { value: "2026-11-10" },
  });
  fireEvent.change(screen.getByLabelText(text("progress.v2.bed")), { target: { value: "2" } });
  assert.equal(state().bridges[0].spans[0].girders[0].dob, "2026-11-10");
  assert.equal(state().bridges[0].spans[0].girders[0].bed, 2);
  fireEvent.click(
    screen.getByRole("button", { name: `4. ${text("progress.v2.stage.4")}`, exact: true }),
  );
  fireEvent.click(screen.getByRole("button", { name: text("progress.v2.applySpan"), exact: true }));
  assert.deepEqual(
    state().bridges[0].spans[0].girders.map((g) => g.st),
    [4, 4],
  );
});

it("writes component updates and records the week's actual and planned figures", () => {
  mount();
  fireEvent.click(screen.getByRole("button", { name: text("progress.v2.tabs.yard"), exact: true }));
  const girder = screen.getByTitle(`N1-D1: ${text("progress.v2.stage.0")}`);
  fireEvent.click(
    within(girder.parentElement!.parentElement!).getByRole("button", { name: "N1", exact: true }),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: text("progress.v2.items.bmc") }), {
    target: { value: "75" },
  });
  assert.equal(state().bridges[0].spans[0].bmc, 75);
  const summary = computeProgressV2(state());
  fireEvent.click(screen.getByRole("button", { name: text("progress.closeWeek") }));
  const record = state().history.find((r) => r.packageId === null)!;
  assert.equal(record.date, todayIso());
  assert.equal(record.actual, Math.round(summary.overallPct * 10) / 10);
  assert.equal(record.planned, Math.round(summary.plannedPct * 10) / 10);
  fireEvent.click(screen.getByRole("button", { name: text("progress.closeWeek") }));
  assert.equal(state().history.filter((r) => r.packageId === null).length, 1);
});

it("updates supports, road percentages and underpass percentages through the real editor", () => {
  seed();
  function Editor({ target }: { target: ProgressFeatureTarget }) {
    const current = useAppStore((s) => s.layers[0]);
    return createElement(ProgressV2Update, {
      state: current.metadata[PROGRESS_METADATA_KEY] as ProgressV2,
      target,
      onChange: (next) =>
        useAppStore.getState().updateLayer(current.id, progressV2LayerPatch(current, next)),
    });
  }
  const result = render(
    createElement(Editor, { target: { kind: "support", bridgeId: "b", id: "M1" } }),
  );
  fireEvent.click(screen.getByRole("button", { name: "C1", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "C1", exact: true }));
  fireEvent.change(screen.getByRole("spinbutton", { name: text("progress.v2.items.be") }), {
    target: { value: "55" },
  });
  assert.deepEqual(state().bridges[0].supports[0].piles, [2, 0]);
  assert.equal(state().bridges[0].supports[0].be, 55);
  result.rerender(createElement(Editor, { target: { kind: "km", id: "Km0" } }));
  fireEvent.change(screen.getByRole("spinbutton", { name: text("progress.v2.items.nen") }), {
    target: { value: "125" },
  });
  assert.equal(state().road.km[0].pct.nen, 100);
  result.rerender(createElement(Editor, { target: { kind: "underpass", id: "H1" } }));
  fireEvent.change(screen.getByRole("spinbutton", { name: text("progress.v2.items.ham_tuong") }), {
    target: { value: "25" },
  });
  assert.equal(state().underpasses[0].pct.tuong, 25);
});
