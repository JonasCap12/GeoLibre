import { expect, test } from "./test";
import { dropGeoJson, layerRow, readFixture, waitForMap, waitForRenderedFeature } from "./helpers";

const FIXTURE_TEXT = readFixture("smoke.geojson");

/**
 * Painting a selection: the selected features take the chosen color as their
 * own simplestyle properties, the selection clears so the paint is visible, and
 * Remove color takes it off again. The table is the readout because the paint
 * is attribute data, which is also what a saved project carries.
 */
test("colors the selected features and removes the color again", async ({ page }) => {
  await waitForMap(page);
  await dropGeoJson(page, "progress", FIXTURE_TEXT);

  const row = layerRow(page, "progress");
  await expect(row).toBeVisible();
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  const table = page.getByTestId("attribute-table");
  await expect(table).toBeVisible();

  const status = page.getByTestId("attribute-table-status");
  await table.locator("tbody tr").first().click();
  await expect(status).toContainText("1 selected");

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Color selected features" }).click();
  await page.getByRole("menuitem", { name: "Green" }).click();

  await expect(status).toContainText("0 selected");
  await expect(table.locator("thead")).toContainText("marker-color");
  await expect(table.locator("tbody")).toContainText("#16a34a");
  await expect(table.locator("tbody tr").filter({ hasText: "#16a34a" })).toHaveCount(1);

  await table.locator("tbody tr").filter({ hasText: "#16a34a" }).click();
  await expect(status).toContainText("1 selected");
  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Color selected features" }).click();
  await page.getByRole("menuitem", { name: "Remove color" }).click();

  await expect(table.locator("tbody")).not.toContainText("#16a34a");
});

/**
 * Painting by area: a sweep across the middle of a long line recolours only
 * that stretch. The line is split at the sweep's edges into an unpainted
 * outside part and a painted inside part, so the table gains one row.
 */
test("colors only the swept part of a line", async ({ page }) => {
  await waitForMap(page);
  const line = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "road" },
        geometry: {
          type: "LineString",
          coordinates: [
            [106.0, 10.0],
            [106.2, 10.0],
          ],
        },
      },
    ],
  };
  await dropGeoJson(page, "drawing", JSON.stringify(line));
  const row = layerRow(page, "drawing");
  await expect(row).toBeVisible();
  await waitForRenderedFeature(page, "road");

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Color by swept area" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Sweep a rectangle" }).click();
  await page.getByRole("menuitem", { name: "Green" }).click();

  const box = (await page.locator(".maplibregl-canvas").boundingBox())!;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.4, centerY - 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, centerY + 40, { steps: 5 });
  await page.mouse.up();

  await row.locator('button[aria-label="Layer actions"]').click();
  await page.getByRole("menuitem", { name: "Open attribute table" }).click();
  const table = page.getByTestId("attribute-table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").filter({ hasText: "#16a34a" })).toHaveCount(1);
});
