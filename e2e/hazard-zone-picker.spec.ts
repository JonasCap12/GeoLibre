import { expect, test } from "./test";
import { dropGeoJson, layerRow, waitForMap } from "./helpers";

// One polygon covering almost the whole Web Mercator world, so a click at the
// centre of the map canvas lands on it whatever view the drop leaves behind.
const SKETCH = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { ten: "Pit" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-179, -80],
            [179, -80],
            [179, 80],
            [-179, 80],
            [-179, -80],
          ],
        ],
      },
    },
  ],
});

test("picking a danger zone closes the dialog, takes a map click, and reopens", async ({
  page,
}) => {
  await waitForMap(page, "/?lang=en");
  await dropGeoJson(page, "sketch", SKETCH);
  await expect(layerRow(page, "sketch")).toBeVisible();

  await page.getByRole("button", { name: "Controls", exact: true }).click();
  await page.getByRole("menuitem", { name: "Danger-zone alert..." }).click();
  const dialog = page.getByRole("dialog", { name: "Danger-zone alert" });
  await expect(dialog).toBeVisible();

  // The modal overlay covers the map, so picking must close the dialog first.
  await dialog.getByRole("button", { name: "Pick a zone on the map", exact: true }).click();
  await expect(dialog).toBeHidden();
  const banner = page.getByTestId("hazard-pick-banner");
  await expect(banner).toBeVisible();

  await page.locator(".maplibregl-canvas").click();
  await expect(banner).toContainText("Added a zone from layer sketch.");
  await expect(layerRow(page, "Vùng nguy hiểm")).toBeVisible();

  await banner.getByRole("button", { name: "Done", exact: true }).click();
  await expect(banner).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("1 picked zone");
});
