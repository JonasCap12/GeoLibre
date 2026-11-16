import { act, fireEvent, i18n, render, screen, useAppStore } from "./helpers/dom";
import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { collaborationApi } from "./helpers/collaboration-api";

const { TopToolbar } = await import("../apps/geolibre-desktop/src/components/layout/TopToolbar");
const { useProjectFileActions } =
  await import("../apps/geolibre-desktop/src/hooks/useProjectFileActions");
const t = i18n.t.bind(i18n);

it("opens the hoisted collaboration dialog from the project menu and keeps the project title visible", async () => {
  const ref = { current: null };
  const api = collaborationApi();
  function Harness() {
    const projectFiles = useProjectFileActions(ref);
    return createElement(TopToolbar, {
      diagnosticsErrorCount: 0,
      mapControllerRef: ref,
      mapReadyGeneration: 0,
      themeMode: "light",
      collaboration: api,
      projectFiles,
      onOpenDiagnostics() {},
      onOpenProjectHistory() {},
      onToggleThemeMode() {},
      onOpenBasemapExtract() {},
      onAddComment() {},
    });
  }
  act(() => useAppStore.setState({ projectName: "Bridge survey" }));
  render(createElement(Harness));
  const title = screen.getByRole("textbox", {
    name: t("toolbar.item.projectName"),
  }) as HTMLInputElement;
  assert.equal(title.value, "Bridge survey");
  fireEvent.pointerDown(screen.getByRole("button", { name: t("toolbar.menu.project") }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(
    await screen.findByRole("menuitem", { name: t("toolbar.item.collaborateEllipsis") }),
  );
  assert.equal(useAppStore.getState().ui.collaborateDialogOpen, true);
});
