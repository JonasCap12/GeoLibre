import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createEmptyProject, serializeProject, type GeoLibreProject } from "@geolibre/core";
import type { TFunction } from "i18next";
import {
  prepareCollaborationSnapshot,
  type CollaborationSnapshotDeps,
} from "../apps/geolibre-desktop/src/lib/collaboration-snapshot-send";
import type {
  CollaborationLayerPromotion,
  CollaborationShrinkResult,
} from "../apps/geolibre-desktop/src/lib/collaboration-layer-promotion";

const LIMIT = 4_000;
const small = (name = "small"): GeoLibreProject => createEmptyProject(name);
const big = (): GeoLibreProject => createEmptyProject("x".repeat(LIMIT * 2));
const t = ((key: string, options?: object) => `${key} ${JSON.stringify(options)}`) as TFunction;
const promotion = { layerId: "cad" } as unknown as CollaborationLayerPromotion;

/** Dependencies that record what ran; `builds` is consumed one per build call. */
function deps(
  builds: Array<GeoLibreProject | Error>,
  overrides: Partial<CollaborationSnapshotDeps> = {},
  shrinkResult: CollaborationShrinkResult = { promotions: [promotion], failure: null, bytes: 0 },
) {
  const log: string[] = [];
  const shrinkCalls: Array<{ layers: number; limit: number }> = [];
  const value: CollaborationSnapshotDeps = {
    build: async () => {
      log.push("build");
      const next = builds.shift();
      if (!next) throw new Error("no build scripted");
      if (next instanceof Error) throw next;
      return next;
    },
    isCurrent: () => true,
    learnedLimit: () => LIMIT,
    shrink: async (layers, limit) => {
      log.push("shrink");
      shrinkCalls.push({ layers: layers.length, limit });
      return shrinkResult;
    },
    applyPromotions: (promotions) => log.push(`apply:${promotions.length}`),
    t,
    ...overrides,
  };
  return { value, log, shrinkCalls };
}

describe("prepareCollaborationSnapshot", () => {
  it("sends a snapshot that fits without shrinking it", async () => {
    const project = small();
    const d = deps([project]);
    const outcome = await prepareCollaborationSnapshot(d.value);
    assert.deepEqual(outcome, { kind: "ready", project, content: serializeProject(project) });
    assert.deepEqual(d.log, ["build"]);
  });

  it("shrinks an oversized snapshot at the learned limit, applies the promotions and sends the rebuild", async () => {
    const rebuilt = small("rebuilt");
    const d = deps([big(), rebuilt]);
    const outcome = await prepareCollaborationSnapshot(d.value);
    assert.equal(outcome.kind, "ready");
    assert.equal(outcome.kind === "ready" && outcome.project, rebuilt);
    assert.deepEqual(d.log, ["build", "shrink", "apply:1", "build"]);
    assert.deepEqual(d.shrinkCalls, [{ layers: 0, limit: LIMIT }]);
  });

  it("holds when the rebuild still does not fit, naming the layer that could not move", async () => {
    const d = deps(
      [big(), big()],
      {},
      {
        promotions: [],
        failure: { layerName: "Bridge DXF", reason: "no-token" },
        bytes: LIMIT * 2,
      },
    );
    const outcome = await prepareCollaborationSnapshot(d.value);
    assert.equal(outcome.kind, "held");
    assert.match(
      outcome.kind === "held" ? outcome.message : "",
      /^collaborate\.layerShareNeedsSignIn .*Bridge DXF/,
    );
  });

  it("reports a failed first or second build", async () => {
    assert.deepEqual(await prepareCollaborationSnapshot(deps([new Error("boom")]).value), {
      kind: "build-failed",
    });
    assert.deepEqual(await prepareCollaborationSnapshot(deps([big(), new Error("boom")]).value), {
      kind: "build-failed",
    });
  });

  it("stops without shrinking when a newer request superseded the first build", async () => {
    const d = deps([big()], { isCurrent: () => false });
    assert.deepEqual(await prepareCollaborationSnapshot(d.value), { kind: "superseded" });
    assert.deepEqual(d.log, ["build"]);
  });

  it("does not apply promotions for a request superseded while shrinking", async () => {
    let current = true;
    const d = deps([big(), small()], { isCurrent: () => current });
    const shrink = d.value.shrink;
    d.value.shrink = async (layers, limit) => {
      const result = await shrink(layers, limit);
      current = false;
      return result;
    };
    assert.deepEqual(await prepareCollaborationSnapshot(d.value), { kind: "superseded" });
    assert.deepEqual(d.log, ["build", "shrink"]);
  });

  it("falls back to the client limit when the relay has not taught one", async () => {
    const d = deps([small()], { learnedLimit: () => null });
    assert.equal((await prepareCollaborationSnapshot(d.value)).kind, "ready");
  });
});
