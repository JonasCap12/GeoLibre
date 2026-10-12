import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateLegacyDefaultTheme } from "../apps/geolibre-desktop/src/hooks/useDesktopSettings";

function migrate(scheme: string, complete?: boolean): Record<string, unknown> {
  return migrateLegacyDefaultTheme({
    ...(complete === undefined ? {} : { forestThemeMigrationComplete: complete }),
    theme: { scheme, customColor: "#0ea5e9" },
  }) as Record<string, unknown>;
}

describe("former default theme migration", () => {
  it("moves an unmarked persisted blue scheme to forest", () => {
    const settings = migrate("blue");
    assert.equal((settings.theme as { scheme: string }).scheme, "forest");
    assert.equal(settings.forestThemeMigrationComplete, true);
  });

  it("preserves blue after the one-time migration has run", () => {
    const settings = migrate("blue", true);
    assert.equal((settings.theme as { scheme: string }).scheme, "blue");
  });

  it("never changes a non-default scheme", () => {
    const settings = migrate("violet");
    assert.equal((settings.theme as { scheme: string }).scheme, "violet");
    assert.equal(settings.forestThemeMigrationComplete, true);
  });
});
