import { act } from "./helpers/dom";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  hasDailyReportSource,
  readDailyReportSource,
  attachDailyReportAdapter,
  NO_REPORT_SOURCE_TOAST,
  dismissSourceHint,
  sourceHintDismissed,
} from "../apps/geolibre-desktop/src/lib/daily-report-board";
import {
  dashboardView,
  dashboardRatio,
  dashboardPointerRatio,
  clampDashboardRatio,
} from "../apps/geolibre-desktop/src/lib/network-dashboard-layout";

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("daily report configured sources", () => {
  it("distinguishes uploaded reports from a saved sync source", () => {
    for (const value of [
      null,
      {},
      { files: {} },
      { files: { XL01: null } },
      { files: [] },
      { files: { other: { kind: "file" } } },
    ]) {
      assert.equal(hasDailyReportSource(value, null), false);
    }
    assert.equal(
      hasDailyReportSource({ files: { XL01: { kind: "file", name: "daily.xlsx" } } }, null),
      true,
    );
    assert.equal(
      hasDailyReportSource({ files: { XL05: { kind: "file" } } }, null),
      true,
      "EC05 is stored under XL05",
    );
    assert.equal(hasDailyReportSource({ reports: [{ goi: "XL01" }] }, null), false);
  });
  it("accepts configured HTTP links, rejects invalid JSON, unknown slots and empty values", () => {
    for (const links of [
      null,
      "",
      "not JSON",
      "[]",
      "{}",
      '{"XL01":"  "}',
      { XL01: "file://a.xlsx" },
      { other: "https://example.test/a.xlsx" },
    ]) {
      assert.equal(hasDailyReportSource(null, links), false);
    }
    assert.equal(hasDailyReportSource(null, '{"XL01":"https://drive.google.com/file"}'), true);
    assert.equal(
      hasDailyReportSource(null, { XL04: " https://example.sharepoint.com/report.xlsx " }),
      true,
    );
  });
  it("leaves sync alone if storage cannot be inspected", async () => {
    const host = {
      localStorage: {
        getItem() {
          throw new Error("denied");
        },
      },
    } as unknown as Window;
    assert.equal(await readDailyReportSource(host), null);
    assert.equal(
      await readDailyReportSource({ localStorage: { getItem: () => null } } as unknown as Window),
      null,
    );
  });
  it("recognizes links without opening IndexedDB", async () => {
    const host = {
      localStorage: { getItem: () => '{"XL02":"https://example.test/report.xlsx"}' },
    } as unknown as Window;
    assert.equal(await readDailyReportSource(host), true);
  });
  it("reads the handle doc in a readonly transaction and closes its connection", async () => {
    let closed = 0;
    const transaction = {
      oncomplete: null as (() => void) | null,
      objectStore(name: string) {
        assert.equal(name, "docs");
        return {
          get(key: string) {
            assert.equal(key, "bcn/fh");
            queueMicrotask(() => transaction.oncomplete?.());
            return { result: { files: { XL05: { kind: "file" } } } };
          },
        };
      },
    };
    const request = {
      onsuccess: null as (() => void) | null,
      result: {
        objectStoreNames: { contains: (name: string) => name === "docs" },
        close() {
          closed++;
        },
        transaction(name: string, mode: string) {
          assert.equal(name, "docs");
          assert.equal(mode, "readonly");
          return transaction;
        },
      },
    };
    const host = {
      localStorage: { getItem: () => null },
      indexedDB: {
        open(name: string) {
          assert.equal(name, "bcn-bangdien");
          queueMicrotask(() => request.onsuccess?.());
          return request;
        },
      },
    } as unknown as Window;
    assert.equal(await readDailyReportSource(host), true);
    assert.equal(closed, 1);
  });
});

describe("daily report parent adapter", () => {
  it("opens upload only without sources and rechecks configured sources on each click", async (t) => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML =
      '<button id="bUp"><span>Update</span></button><input id="fileIn" type="file">';
    let configured = false,
      sync = 0,
      pick = 0;
    doc.getElementById("bUp")!.addEventListener("click", () => sync++);
    doc.getElementById("fileIn")!.addEventListener("click", (event) => {
      event.preventDefault();
      pick++;
    });
    t.after(
      attachDailyReportAdapter(
        doc,
        async () => configured,
        () => {},
      ),
    );
    await settle();
    doc.querySelector<HTMLElement>("#bUp span")!.click();
    await settle();
    assert.equal(pick, 1);
    assert.equal(sync, 0);
    configured = true;
    doc.getElementById("bUp")!.click();
    await settle();
    assert.equal(pick, 1);
    assert.equal(sync, 1, "native handler replays once");
    configured = false;
    doc.getElementById("bUp")!.click();
    await settle();
    assert.equal(pick, 2);
    assert.equal(sync, 1);
  });
  it("removes exactly the orphan toast and observes a Settings handle change", async (t) => {
    const doc = document.implementation.createHTMLDocument();
    let configured = false;
    const values: (boolean | null)[] = [];
    t.after(
      attachDailyReportAdapter(
        doc,
        async () => configured,
        (value) => values.push(value),
      ),
    );
    await settle();
    for (const text of [NO_REPORT_SOURCE_TOAST, "Đã cập nhật XL01 1 ngày", "Có báo cáo mới…"]) {
      const toast = doc.createElement("div");
      toast.className = "toast";
      toast.textContent = text;
      doc.body.appendChild(toast);
    }
    await settle();
    assert.deepEqual(
      [...doc.querySelectorAll(".toast")].map((node) => node.textContent),
      ["Đã cập nhật XL01 1 ngày", "Có báo cáo mới…"],
    );
    const settings = doc.createElement("div");
    settings.id = "setOv";
    doc.body.appendChild(settings);
    await settle();
    configured = true;
    settings.remove();
    await settle();
    assert.equal(values.at(-1), true);
    const toast = doc.createElement("div");
    toast.className = "toast";
    toast.textContent = NO_REPORT_SOURCE_TOAST;
    doc.body.appendChild(toast);
    await settle();
    assert.ok(toast.isConnected, "configured source retains the board's own toasts");
  });
  it("cleans up document interception when the iframe unloads", async () => {
    const doc = document.implementation.createHTMLDocument();
    doc.body.innerHTML = '<button id="bUp">Update</button>';
    let sync = 0;
    doc.getElementById("bUp")!.onclick = () => {
      sync++;
    };
    const dispose = attachDailyReportAdapter(
      doc,
      async () => false,
      () => {},
    );
    await settle();
    dispose();
    doc.getElementById("bUp")!.click();
    await settle();
    assert.equal(sync, 1);
  });
});

describe("network dashboard responsive preferences", () => {
  it("defaults to the map on phones and never exposes split there", () => {
    assert.equal(dashboardView(null, true), "map");
    assert.equal(dashboardView("split", true), "map");
    assert.equal(dashboardView("report", true), "report");
    assert.equal(dashboardView(null, false), "split");
  });
  it("clamps persisted ratios and mirrors pointer movement in RTL", () => {
    assert.equal(dashboardRatio(null), null);
    assert.equal(dashboardRatio("no"), null);
    assert.equal(dashboardRatio("100"), 80);
    assert.equal(dashboardRatio("10"), 35);
    assert.equal(clampDashboardRatio(55), 55);
    assert.equal(dashboardPointerRatio(650, 1000, false), 65);
    assert.equal(dashboardPointerRatio(350, 1000, true), 65);
    assert.equal(dashboardPointerRatio(-20, 1000, false), 35);
  });
});

describe("daily report source hint", () => {
  it("remembers a dismissal and tolerates missing or throwing storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    assert.equal(sourceHintDismissed(storage), false);
    dismissSourceHint(storage);
    assert.equal(sourceHintDismissed(storage), true);

    const broken = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    assert.doesNotThrow(() => dismissSourceHint(broken));
    assert.equal(sourceHintDismissed(broken), false);
    assert.equal(sourceHintDismissed(null), false);
  });
});
