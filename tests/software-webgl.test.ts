import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isSoftwareRendererName,
  mapUsesSoftwareWebGL,
  webglRendererName,
} from "../packages/map/src/software-webgl";

const UNMASKED_RENDERER_WEBGL = 0x9246;
const RENDERER = 0x1f01;

/** A WebGL context stub reporting `renderer`, with or without the debug extension. */
function fakeGl(renderer: string, withDebugInfo = true) {
  return {
    RENDERER,
    getExtension: (name: string) =>
      withDebugInfo && name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL } : null,
    getParameter: (parameter: number) =>
      parameter === UNMASKED_RENDERER_WEBGL
        ? renderer
        : parameter === RENDERER
        ? "WebKit WebGL"
        : null,
  };
}

function fakeMap(gl: unknown, kind: "webgl2" | "webgl" = "webgl2") {
  return {
    getCanvas: () => ({
      getContext: (type: string) => (type === kind ? gl : null),
    }),
  };
}

describe("software WebGL detection", () => {
  it("recognises the software rasterisers", () => {
    for (const name of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "Mesa softpipe",
      "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)",
    ]) {
      assert.equal(isSoftwareRendererName(name), true, name);
    }
  });

  it("does not mistake a GPU for software", () => {
    for (const name of [
      "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      "Apple M2",
      "",
    ]) {
      assert.equal(isSoftwareRendererName(name), false, name);
    }
  });

  it("reads the unmasked renderer, falling back to RENDERER without the extension", () => {
    assert.equal(webglRendererName(fakeGl("llvmpipe")), "llvmpipe");
    assert.equal(webglRendererName(fakeGl("llvmpipe", false)), "WebKit WebGL");
  });

  it("finds the map's existing context, WebGL 2 or 1", () => {
    assert.equal(mapUsesSoftwareWebGL(fakeMap(fakeGl("SwiftShader driver"))), true);
    assert.equal(mapUsesSoftwareWebGL(fakeMap(fakeGl("SwiftShader driver"), "webgl")), true);
    assert.equal(mapUsesSoftwareWebGL(fakeMap(fakeGl("NVIDIA GeForce"))), false);
  });

  it("assumes a GPU when it cannot tell", () => {
    assert.equal(mapUsesSoftwareWebGL(null), false);
    assert.equal(mapUsesSoftwareWebGL({}), false);
    assert.equal(mapUsesSoftwareWebGL(fakeMap(null)), false);
    const throwing = {
      getCanvas: () => ({
        getContext: () => {
          throw new Error("context lost");
        },
      }),
    };
    assert.equal(mapUsesSoftwareWebGL(throwing), false);
  });
});
