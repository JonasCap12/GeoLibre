import { act, fireEvent, i18n, render, screen, useAppStore, waitFor } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { geojsonLayer } from "./helpers/layer-fixtures";
import type { MapEngine } from "@geolibre/map";
import type { HazardSummary } from "../apps/geolibre-desktop/src/lib/hazard-zones";
import {
  createHazardCollectionLayer,
  hazardZoneEntries,
} from "../apps/geolibre-desktop/src/lib/hazard-zone-picker";

const support = await import("../apps/geolibre-desktop/src/components/layout/hazard-alert-support");
const { HazardZonePicker } =
  await import("../apps/geolibre-desktop/src/components/layout/hazard-zone-picker");
const { HazardAlertDialog } =
  await import("../apps/geolibre-desktop/src/components/layout/HazardAlertDialog");
const t = i18n.t.bind(i18n);

it("persists hazard settings and validates corrupt, negative, nonnumeric and missing values", () => {
  assert.deepEqual(support.loadHazardSettings(), support.DEFAULT_HAZARD_UI);
  const settings = { nearDistanceM: 30, silenceMinutes: 5, sound: false, voice: true };
  support.storeHazardSettings(settings);
  assert.deepEqual(support.loadHazardSettings(), settings);
  for (const raw of ["not JSON", "null", "0"]) {
    localStorage.setItem("geolibre.hazard-alert", raw);
    assert.deepEqual(support.loadHazardSettings(), support.DEFAULT_HAZARD_UI);
  }
  localStorage.setItem(
    "geolibre.hazard-alert",
    JSON.stringify({ nearDistanceM: -10, silenceMinutes: "5", sound: false, voice: "true" }),
  );
  assert.deepEqual(support.loadHazardSettings(), { ...support.DEFAULT_HAZARD_UI, sound: false });
});

it("maps every hazard status to its translated label and visible severity", () => {
  const rows: [HazardSummary, string, string][] = [
    ["inside", "hazard.statusInside", "bg-red-600 text-white"],
    ["near", "hazard.statusNear", "bg-amber-400 text-black"],
    ["safe", "hazard.statusSafe", "bg-green-600 text-white"],
    ["lost", "hazard.statusLost", "bg-neutral-800 text-white"],
    ["poor", "hazard.statusPoor", "bg-neutral-800 text-white"],
    ["waiting", "hazard.statusWaiting", "bg-muted text-foreground"],
  ];
  for (const [summary, key, css] of rows) {
    assert.equal(support.hazardStatusKey(summary), key);
    assert.equal(support.hazardStatusClass(summary), css);
  }
});

it("renders the hazard banner and acknowledges near/inside warnings", () => {
  let acknowledged = 0;
  const onAck = () => {
    acknowledged++;
  };
  const banner = render(
    createElement(support.HazardBanner, {
      testId: "banner",
      className: "bg-red-600",
      title: "Danger",
      onAck,
      ackLabel: "Acknowledge",
    }),
  );
  assert.equal(screen.getByTestId("banner").textContent, "DangerAcknowledge");
  fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
  banner.unmount();
  const result = render(
    createElement(support.HazardScreenAlerts, {
      t,
      summary: "near",
      monitoring: true,
      insideNames: "",
      nearNames: "Trench A",
      onAck,
    }),
  );
  assert.ok(screen.getByTestId("hazard-near").textContent?.includes("Trench A"));
  fireEvent.click(screen.getByRole("button", { name: t("hazard.acknowledge") }));
  result.rerender(
    createElement(support.HazardScreenAlerts, {
      t,
      summary: "inside",
      monitoring: true,
      insideNames: "Trench A",
      nearNames: "",
      onAck,
    }),
  );
  assert.ok(screen.getByTestId("hazard-overlay").textContent?.includes("Trench A"));
  fireEvent.click(screen.getByRole("button", { name: t("hazard.acknowledge") }));
  assert.equal(acknowledged, 3);
  for (const summary of ["lost", "poor"] as const) {
    result.rerender(
      createElement(support.HazardScreenAlerts, {
        t,
        summary,
        monitoring: true,
        insideNames: "",
        nearNames: "",
        onAck,
      }),
    );
    assert.ok(screen.getByTestId(`hazard-${summary}`).textContent);
    result.rerender(
      createElement(support.HazardScreenAlerts, {
        t,
        summary,
        monitoring: false,
        insideNames: "",
        nearNames: "",
        onAck,
      }),
    );
    assert.equal(screen.queryByTestId(`hazard-${summary}`), null);
  }
});

it("edits, zooms to and removes a hazard polygon without changing its source drawing", (ctx) => {
  const feature = {
    type: "Feature" as const,
    id: "zone-1",
    properties: { ten: "Trench A", muc: "nguy_hiem" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [106, 10],
          [107, 10],
          [107, 11],
          [106, 11],
          [106, 10],
        ],
      ],
    },
  };
  const source = geojsonLayer({
    id: "source",
    geojson: { type: "FeatureCollection", features: [structuredClone(feature)] },
  });
  act(() =>
    useAppStore.setState({ layers: [source, createHazardCollectionLayer("hazards", [feature])] }),
  );
  const fits: number[][] = [];
  const map = { fitBounds: (bounds: number[]) => fits.push(bounds) } as unknown as MapEngine;
  let picking = 0;
  render(
    createElement(HazardZonePicker, {
      t,
      mapControllerRef: { current: map },
      notice: "",
      onNotice() {},
      onStartPicking() {
        picking++;
      },
    }),
  );
  fireEvent.change(screen.getByLabelText(t("hazard.zoneName")), {
    target: { value: "Excavation B" },
  });
  fireEvent.change(screen.getByLabelText(t("hazard.zoneLevel")), { target: { value: "canh_bao" } });
  assert.equal(hazardZoneEntries(useAppStore.getState().layers)[0].name, "Excavation B");
  assert.equal(hazardZoneEntries(useAppStore.getState().layers)[0].level, "canh_bao");
  fireEvent.click(screen.getByRole("button", { name: t("hazard.viewZone") }));
  assert.deepEqual(fits, [[106, 10, 107, 11]]);
  fireEvent.click(screen.getByRole("button", { name: t("hazard.pickOnMap") }));
  assert.equal(picking, 1);
  const originalConfirm = window.confirm;
  ctx.after(() => {
    window.confirm = originalConfirm;
  });
  window.confirm = () => false;
  fireEvent.click(screen.getByRole("button", { name: t("hazard.removeZone") }));
  assert.equal(hazardZoneEntries(useAppStore.getState().layers).length, 1);
  window.confirm = () => true;
  fireEvent.click(screen.getByRole("button", { name: t("hazard.removeZone") }));
  assert.equal(hazardZoneEntries(useAppStore.getState().layers).length, 0);
  assert.deepEqual(useAppStore.getState().layers[0].geojson, source.geojson);
});

it("starts and stops GPS monitoring from the hazard dialog and saves monitoring settings", async (ctx) => {
  let watches = 0;
  const stopped: number[] = [];
  const previous = Object.getOwnPropertyDescriptor(navigator, "geolocation");
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition() {
        watches++;
        return 42;
      },
      clearWatch(id: number) {
        stopped.push(id);
      },
    },
  });
  ctx.after(() => {
    if (previous) Object.defineProperty(navigator, "geolocation", previous);
    else Reflect.deleteProperty(navigator, "geolocation");
  });
  render(
    createElement(HazardAlertDialog, {
      open: true,
      onOpenChange() {},
      mapControllerRef: { current: null },
    }),
  );
  fireEvent.change(screen.getByLabelText(t("hazard.nearDistance")), { target: { value: "35" } });
  assert.equal(support.loadHazardSettings().nearDistanceM, 35);
  fireEvent.click(screen.getByRole("button", { name: t("hazard.start") }));
  assert.equal(watches, 0);
  fireEvent.click(screen.getByRole("button", { name: t("hazard.acceptAndStart") }));
  await waitFor(() => assert.equal(watches, 1));
  assert.ok(screen.getByTestId("hazard-status").textContent);
  fireEvent.click(screen.getByRole("button", { name: t("hazard.stop") }));
  await waitFor(() => assert.deepEqual(stopped, [42]));
});
