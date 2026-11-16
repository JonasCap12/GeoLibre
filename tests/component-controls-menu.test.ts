import { fireEvent, render, screen } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import type { ToolbarPanels } from "../apps/geolibre-desktop/src/hooks/useToolbarPanels";

const { ControlsMenu } =
  await import("../apps/geolibre-desktop/src/components/layout/toolbar/ControlsMenu");

const noop = () => {};

/** Every panel hidden, with a toggle that does nothing; the Image panel has no images. */
const panels = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "image"
        ? { visible: false, toggle: noop, images: [], apply: () => null, remove: noop }
        : { visible: false, toggle: noop },
  },
) as ToolbarPanels;

/** Render the Controls menu, open it, and record which tool callback fired. */
function openControlsMenu(calls: string[], viewer = false) {
  render(
    createElement(ControlsMenu, {
      chrome: { buttonClass: "", buttonSize: "sm", iconClassName: "", renderLabel: (l) => l },
      viewer,
      controlsVisible: new Proxy({}, { get: () => false }) as never,
      panels,
      effectsActive: false,
      layerControlActive: false,
      directionsActive: false,
      reverseGeocodeActive: false,
      graticuleActive: false,
      cloudsActive: false,
      precipitationActive: false,
      onToggleMapControl: noop,
      onToggleLayerControl: noop,
      onToggleEffects: noop,
      getEffectsSettings: () => ({}) as never,
      onPreviewEffectsSettings: noop,
      onCommitEffectsSettings: noop,
      onToggleDirections: noop,
      onToggleReverseGeocode: noop,
      onToggleGraticule: noop,
      onTogglePointerElevation: noop,
      onToggleClouds: noop,
      onTogglePrecipitation: noop,
      onOpenFieldCollection: () => calls.push("field"),
      onOpenGpsTracking: () => calls.push("gps"),
      onOpenHazardAlert: () => calls.push("hazard"),
      onOpenRecordTour: () => calls.push("tour"),
      onOpenRecordVideo: () => calls.push("video"),
    }),
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Controls" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("ControlsMenu tools", () => {
  // The fork's danger-zone alert sits between GPS tracking and the recorders
  // (upstream v3.8 renamed those items to sentence case); each item must open
  // its own tool, not a neighbour's.
  for (const [label, call] of [
    ["Field collection…", "field"],
    ["GPS tracking…", "gps"],
    ["Danger-zone alert…", "hazard"],
    ["Record map tour…", "tour"],
    ["Record video…", "video"],
  ] as const) {
    it(`"${label}" opens its own tool`, async () => {
      const calls: string[] = [];
      openControlsMenu(calls);
      fireEvent.click(await screen.findByRole("menuitem", { name: label }));
      assert.deepEqual(calls, [call]);
    });
  }

  it("lists the danger-zone alert right after GPS tracking", async () => {
    openControlsMenu([]);
    await screen.findByRole("menuitem", { name: "GPS tracking…" });
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
    const gps = items.indexOf("GPS tracking…");
    assert.notEqual(gps, -1);
    assert.equal(items[gps + 1], "Danger-zone alert…");
  });
});
