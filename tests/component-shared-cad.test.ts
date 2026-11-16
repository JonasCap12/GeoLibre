import {
  act,
  fireEvent,
  i18n,
  mockFetch,
  render,
  screen,
  useDesktopSettingsStore,
  waitFor,
} from "./helpers/dom";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it, type TestContext } from "node:test";
import { createElement, useState, type ReactNode } from "react";
import type { GeoLibreLayer } from "@geolibre/core";
import type { AddDataShellContextValue } from "../apps/geolibre-desktop/src/components/layout/add-data/context";
import type { SharedDataset } from "../apps/geolibre-desktop/src/lib/shared-datasets";

const { AddDataShellProvider } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/context");
const { SharedDataSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/SharedDataSource");
const { CadSource } =
  await import("../apps/geolibre-desktop/src/components/layout/add-data/sources/CadSource");
const t = i18n.t.bind(i18n);
const bytes = new Uint8Array(readFileSync(new URL("./fixtures/fork-small.dxf", import.meta.url)));
const dataset: SharedDataset = {
  id: "dataset-id",
  name: "Bridge drawing",
  description: "",
  filename: "bridge.dxf",
  contentType: "application/octet-stream",
  sizeBytes: bytes.length,
  visibility: "team",
  downloads: 3,
  owner: "surveyor",
  createdAt: "2026-11-16T00:00:00Z",
  updatedAt: "2026-11-16T00:00:00Z",
  tags: ["bridge"],
  contentUrl: "https://example.com/content",
};
function setToken(shareToken: string) {
  act(() => {
    const store = useDesktopSettingsStore.getState();
    store.setDesktopSettings({ ...store.desktopSettings, shareToken });
  });
}
function mount(children: ReactNode) {
  const layers: GeoLibreLayer[] = [];
  let closed = 0;
  function Shell() {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const value: AddDataShellContextValue = {
      mapControllerRef: { current: null },
      existingLayers: [],
      isSubmitting,
      setIsSubmitting,
      addLayer(layer) {
        layers.push(layer);
      },
      closeDialog() {
        closed++;
      },
      targetGroupId: null,
      martin: {} as AddDataShellContextValue["martin"],
    };
    return createElement(AddDataShellProvider, { value, children });
  }
  const result = render(createElement(Shell));
  return {
    ...result,
    layers,
    get closed() {
      return closed;
    },
  };
}
function picker(ctx: TestContext, filename: string, data: Uint8Array) {
  ctx.mock.method(HTMLInputElement.prototype, "click", function (this: HTMLInputElement) {
    Object.defineProperty(this, "files", {
      configurable: true,
      value: [
        {
          name: filename,
          size: data.length,
          async arrayBuffer() {
            return data.slice().buffer;
          },
        },
      ],
    });
    this.dispatchEvent(new Event("change"));
  });
}

it("adds a shared DXF through the real reader with its dataset identity and features", async () => {
  setToken("shared-reader-token");
  mockFetch(async (input, init) => {
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer shared-reader-token");
    return String(input).endsWith("/content")
      ? new Response(bytes)
      : Response.json({ datasets: [dataset] });
  });
  const result = mount(createElement(SharedDataSource));
  await screen.findByRole("option", { name: /Bridge drawing/ });
  fireEvent.click(screen.getByRole("button", { name: t("addData.shared.addLayer") }));
  await waitFor(() => assert.equal(result.layers.length, 1));
  assert.equal(result.layers[0].geojson?.features.length, 2);
  assert.equal(result.layers[0].metadata.sharedDatasetId, dataset.id);
  assert.equal(result.layers[0].metadata.sharedDatasetFilename, dataset.filename);
  assert.equal(result.closed, 1);
});

it("filters shared datasets by tag and search and removes the selected dataset", async () => {
  setToken("shared-filter-token");
  const requests: { method: string; url: URL }[] = [];
  let deleted = false;
  mockFetch(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ method, url });
    if (method === "DELETE") {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ datasets: deleted ? [] : [dataset] });
  });
  mount(createElement(SharedDataSource));
  await screen.findByRole("option", { name: /Bridge drawing/ });
  fireEvent.click(screen.getByTitle(t("addData.sharedData.filterByTag", { tag: "bridge" })));
  await waitFor(() => assert.ok(requests.some((r) => r.url.searchParams.get("tag") === "bridge")));
  fireEvent.change(screen.getByRole("textbox", { name: t("addData.sharedData.search") }), {
    target: { value: "pier" },
  });
  await waitFor(() => assert.ok(requests.some((r) => r.url.searchParams.get("q") === "pier")));
  fireEvent.click(screen.getByRole("button", { name: t("addData.sharedData.delete") }));
  await waitFor(() =>
    assert.ok(
      requests.some(
        (r) => r.method === "DELETE" && r.url.pathname.endsWith(`/datasets/${dataset.id}`),
      ),
    ),
  );
  await screen.findByRole("option", { name: t("addData.sharedData.emptyLibrary") });
});

it("uploads file bytes with team visibility by default and with the entered tags", async (ctx) => {
  setToken("shared-upload-token");
  picker(ctx, "new.dxf", bytes);
  const uploads: URL[] = [];
  let uploaded = false;
  mockFetch(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      uploads.push(url);
      uploaded = true;
      assert.deepEqual(new Uint8Array(init.body as ArrayBuffer), bytes);
      return Response.json({ dataset }, { status: 201 });
    }
    return Response.json({ datasets: uploaded ? [dataset] : [] });
  });
  mount(createElement(SharedDataSource));
  await screen.findByRole("option", { name: t("addData.sharedData.emptyLibrary") });
  fireEvent.change(screen.getByLabelText(t("addData.sharedData.uploadTags")), {
    target: { value: "  bridge, team-a  " },
  });
  fireEvent.click(screen.getByRole("button", { name: t("addData.sharedData.upload") }));
  await waitFor(() => assert.equal(uploads.length, 1));
  assert.equal(uploads[0].searchParams.get("visibility"), "team");
  assert.equal(uploads[0].searchParams.get("tags"), "bridge,team-a");
  assert.equal(uploads[0].searchParams.get("filename"), "new.dxf");
});

it("shows a failed shared-library listing and lets the user retry", async () => {
  let failed = true;
  mockFetch(async () =>
    failed
      ? Response.json({ detail: "Library unavailable" }, { status: 503 })
      : Response.json({ datasets: [dataset] }),
  );
  mount(createElement(SharedDataSource));
  await screen.findByText("Library unavailable");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: t("addData.sharedData.refresh") }));
  await screen.findByRole("option", { name: /Bridge drawing/ });
  assert.equal(screen.queryByText("Library unavailable"), null);
});

it("opens a DXF with the fallback reader and adds only the selected CAD layer", async (ctx) => {
  picker(ctx, "drawing.dxf", bytes);
  const result = mount(createElement(CadSource));
  fireEvent.click(screen.getByRole("button", { name: t("addData.common.chooseFile") }));
  await screen.findByText(t("addData.cad.fallbackNotice"));
  const layer = screen.getByLabelText(t("addData.cad.layer"));
  fireEvent.change(layer, { target: { value: "Piers" } });
  fireEvent.click(screen.getByRole("button", { name: t("addData.shared.addLayer") }));
  await waitFor(() => assert.equal(result.layers.length, 1));
  assert.equal(result.layers[0].metadata.cadLayer, "Piers");
  assert.equal(result.layers[0].geojson?.features.length, 1);
  assert.deepEqual(result.layers[0].geojson?.features[0].geometry, {
    type: "LineString",
    coordinates: [
      [106, 10],
      [106.1, 10.1],
    ],
  });
  assert.equal(result.layers[0].style.elevation3dEnabled, true);
  assert.equal(result.closed, 1);
});

for (const [filename, text] of [
  ["unsupported.dwg", "AC1032"],
  ["binary.dxf", "AutoCAD Binary DXF\r\n\u001a\u0000"],
]) {
  it(`refuses ${filename} before adding a broken drawing`, async (ctx) => {
    picker(ctx, filename, new TextEncoder().encode(text));
    const result = mount(createElement(CadSource));
    fireEvent.click(screen.getByRole("button", { name: t("addData.common.chooseFile") }));
    const error = await screen.findByRole("alert");
    assert.ok(error.textContent?.includes(filename.endsWith(".dxf") ? "binary DXF" : "AutoCAD"));
    assert.equal(result.layers.length, 0);
    assert.equal(result.closed, 0);
  });
}
