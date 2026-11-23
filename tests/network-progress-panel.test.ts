import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NetworkSegment } from "../apps/geolibre-desktop/src/lib/network-dashboard";
import { progressGroups } from "../apps/geolibre-desktop/src/lib/network-progress-panel";

function line(name: string, type: string, km: number, progress: number | null): NetworkSegment {
  return {
    layerId: "mui",
    index: 0,
    name,
    status: "Đang thi công",
    type,
    year: null,
    progress,
    plan: null,
    km,
  };
}

describe("road network progress panel", () => {
  const segments = [
    line("Chưa có báo cáo · Km161+750 – Km171+600", "Chưa có báo cáo", 9.8, null),
    line("XL05 · Mũi 02", "Gói XL05", 5.5, 74),
    line("XL02 · Mũi 10", "Gói XL02", 1, 10),
    line("XL02 · Mũi 2", "Gói XL02", 3, 50),
    line("Tuyến phụ", "", 2, null),
    line("XL05 · Mũi 01", "Gói XL05", 1.9, null),
  ];

  it("groups by type, real groups first, no-data and unclassified last", () => {
    const groups = progressGroups(segments, null);
    assert.deepEqual(
      groups.map((group) => group.key),
      ["Gói XL02", "Gói XL05", "Chưa có báo cáo", ""],
    );
    assert.equal(
      groups.every((group) => !group.active),
      true,
    );
  });

  it("orders rows naturally and drops the package prefix from their labels", () => {
    const [xl02] = progressGroups(segments, null);
    assert.deepEqual(
      xl02.rows.map((row) => row.label),
      ["Mũi 2", "Mũi 10"],
    );
    assert.equal(xl02.rows[0].segment.name, "XL02 · Mũi 2");
  });

  it("weights the group percent by length over the lines that report one", () => {
    const groups = progressGroups(segments, null);
    const xl02 = groups.find((group) => group.key === "Gói XL02")!;
    assert.equal(xl02.progress, (50 * 3 + 10 * 1) / 4);
    assert.equal(xl02.km, 4);
    // Only Mũi 02 reports a percent in XL05; Mũi 01's length does not dilute it.
    assert.equal(groups.find((group) => group.key === "Gói XL05")!.progress, 74);
    assert.equal(groups.find((group) => group.key === "Chưa có báo cáo")!.progress, null);
  });

  it("marks the package the report board is showing, by whole code", () => {
    const groups = progressGroups(segments, "XL05");
    assert.deepEqual(
      groups.filter((group) => group.active).map((group) => group.key),
      ["Gói XL05"],
    );
    assert.equal(
      progressGroups([line("A", "Gói XL050", 1, 1)], "XL05")[0].active,
      false,
      "XL05 must not match XL050",
    );
    assert.equal(progressGroups([line("A", "gói xl05", 1, 1)], "XL05")[0].active, true);
  });

  it("is empty without lines", () => {
    assert.deepEqual(progressGroups([], "XL01"), []);
  });
});
