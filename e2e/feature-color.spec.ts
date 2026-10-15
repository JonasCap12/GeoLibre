import { expect, test } from "./test";
import { dropGeoJson, layerRow, readFixture, waitForMap } from "./helpers";

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
