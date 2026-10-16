import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { dropGeoJson, layerRow, waitForMap, waitForRenderedFeature } from "./helpers";

/**
 * The construction progress screen over a drawing: it opens from the layer
 * menu with work items suggested from the CAD layers, a sweep marks features
 * done and moves the figures, and at every viewport size the whole screen fits
 * without a scrollbar and the map sits in its own cell.
 */

/** A small bridge drawing: six piles (squares), three girders, one label. */
function drawing() {
  const features: unknown[] = [];
  for (let i = 0; i < 6; i += 1) {
    const x = 106 + i * 0.02;
    features.push({
      type: "Feature",
      properties: { Layer: "COC", name: `pile-${i}` },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [x, 10],
            [x + 0.004, 10],
            [x + 0.004, 10.004],
            [x, 10.004],
            [x, 10],
          ],
        ],
      },
    });
  }
  for (let i = 0; i < 3; i += 1) {
    features.push({
      type: "Feature",
      properties: { Layer: "DAM", name: `girder-${i}` },
      geometry: {
        type: "LineString",
        coordinates: [
          [106 + i * 0.04, 10.01],
          [106.04 + i * 0.04, 10.01],
        ],
      },
    });
  }
  features.push({
    type: "Feature",
    properties: { Layer: "TEXT", name: "P054" },
    geometry: { type: "Point", coordinates: [106.05, 10.02] },
  });
  return JSON.stringify({ type: "FeatureCollection", features });
}

/** Everything fits: no page scroll, no block taller than its box, map in its cell. */
async function expectFits(page: Page) {
  const report = await page.evaluate(() => {
    const root = document.documentElement;
    const header = document.querySelector(".progress-screen-header")!.getBoundingClientRect();
    const side = document.querySelector(".progress-screen-side")!.getBoundingClientRect();
    const map = document.querySelector("main.isolate")!.getBoundingClientRect();
    const overflowing = [
      ...document.querySelectorAll(".progress-screen-side section, .progress-screen-header"),
    ]
      .filter((el) => el.scrollHeight > el.clientHeight + 1)
      .map((el) => el.querySelector("h2")?.textContent ?? el.className);
    return {
      pageScrolls: root.scrollHeight > window.innerHeight || root.scrollWidth > window.innerWidth,
      overflowing,
      headerBottom: Math.round(header.bottom),
      mapTop: Math.round(map.top),
      mapRight: Math.round(map.right),
      mapBottom: Math.round(map.bottom),
      side: {
        left: Math.round(side.left),
        top: Math.round(side.top),
        bottom: Math.round(side.bottom),
      },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  });
  expect(report.pageScrolls).toBe(false);
  expect(report.overflowing).toEqual([]);
  expect(report.mapTop).toBe(report.headerBottom);
  expect(report.side.bottom).toBe(report.viewport.height);
  if (report.viewport.width >= 900) {
    // Side by side: the map ends where the column starts.
    expect(report.mapRight).toBe(report.side.left);
    expect(report.mapBottom).toBe(report.viewport.height);
  } else {
    // Stacked: the map ends where the strip starts.
    expect(report.mapRight).toBe(report.viewport.width);
    expect(report.mapBottom).toBe(report.side.top);
  }
}

test("shows drawing progress on one screen without scrolling", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await waitForMap(page);
  await dropGeoJson(page, "cau", drawing());
  const row = layerRow(page, "cau");
  await expect(row).toBeVisible();
  await waitForRenderedFeature(page, "girder-1");

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Construction progress screen" }).click();

  const header = page.locator(".progress-screen-header");
  const side = page.locator(".progress-screen-side");
  await expect(header).toBeVisible();
  await expect(side.getByRole("button", { name: /^COC/ })).toBeVisible();
  await expect(side.getByRole("button", { name: /^DAM/ })).toBeVisible();
  await expect(header).toContainText("0%");
  await expectFits(page);

  // Sweep the left part of the map cell: some piles and girders become done.
  await side.getByRole("button", { name: "Done" }).click();
  const box = (await page.locator("main.isolate .maplibregl-canvas").boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height - 4, { steps: 6 });
  await page.mouse.up();
  await expect(header).not.toContainText(/Actual\s*0%/);

  // A work item selects its features, which then become a mark target.
  await side.getByRole("button", { name: /^COC/ }).click();
  await expect(side.getByRole("radio", { name: "Selection (6)" })).toBeEnabled();

  // A manual percent replaces the drawing's for that item.
  await header.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Progress settings" });
  await dialog.getByRole("textbox", { name: "Manual %" }).nth(1).fill("50");
  // More issues than any viewport has room for, so the "+N" fold is exercised.
  await dialog
    .getByRole("textbox", { name: "Issues to watch" })
    .fill(Array.from({ length: 8 }, (_, i) => `Issue ${i + 1}`).join("\n"));
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(side).toContainText("Issue 1");
  await expect(side).toContainText(/\+\d+ more/);
  await expect(dialog).toBeHidden();
  await expect(side.getByRole("button", { name: /^DAM/ })).toContainText("manual");
  await expect(side.getByRole("button", { name: /^DAM/ })).toContainText("50%");

  await header.getByRole("button", { name: "Record week" }).click();
  await expect(side).not.toContainText("Record a week to start the chart.");

  for (const size of [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 1280, height: 620 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(header).toBeVisible();
    await expectFits(page);
    // MapLibre follows its container, so the canvas comes to fill the cell.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const cell = document.querySelector("main.isolate")!.getBoundingClientRect();
          const canvas = document
            .querySelector("main.isolate .maplibregl-canvas")!
            .getBoundingClientRect();
          return (
            Math.abs(cell.width - canvas.width) <= 2 && Math.abs(cell.height - canvas.height) <= 2
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`progress-${size.width}x${size.height}.png`),
    });
  }

  await header.getByRole("button", { name: "Close" }).click();
  await expect(header).toBeHidden();
  expect(
    await page.evaluate(() => document.documentElement.hasAttribute("data-progress-screen")),
  ).toBe(false);
});
