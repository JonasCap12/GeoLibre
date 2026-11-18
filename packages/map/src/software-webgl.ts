/**
 * Whether the map's WebGL is drawn in software, without a GPU.
 *
 * Browsers fall back to a CPU rasteriser when there is no usable GPU: a
 * virtual machine, a remote desktop, a blocklisted driver, or a headless test
 * runner. There, 3D terrain keeps the CPU busy enough to stall the page (on a
 * CI runner, ordinary clicks took 17-20 s), so the map shows the terrain
 * toggle but leaves turning it on to the user.
 */

/** Renderer names of the software rasterisers browsers ship or fall back to. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver/i;

/** `WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL`. */
const UNMASKED_RENDERER_WEBGL = 0x9246;

/** The part of a WebGL context this module reads. */
export interface RendererInfoSource {
  readonly RENDERER: number;
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
}

/** Whether a WebGL renderer name is a software rasteriser. */
export function isSoftwareRendererName(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}

/**
 * The GPU (or software rasteriser) behind a WebGL context: the unmasked name
 * when the browser exposes it, otherwise whatever `RENDERER` reports.
 */
export function webglRendererName(gl: RendererInfoSource): string {
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info") as {
    UNMASKED_RENDERER_WEBGL?: number;
  } | null;
  const parameter = debugInfo
    ? debugInfo.UNMASKED_RENDERER_WEBGL ?? UNMASKED_RENDERER_WEBGL
    : gl.RENDERER;
  const name = gl.getParameter(parameter);
  return typeof name === "string" ? name : "";
}

interface CanvasLike {
  getContext(type: string): unknown;
}

/**
 * Whether the map's canvas draws in software. Reads the context the map
 * already holds (asking a canvas for the type it has returns that context, and
 * never creates a second one). Answers false whenever it cannot tell, so an
 * unknown renderer behaves as a GPU.
 */
export function mapUsesSoftwareWebGL(
  map: { getCanvas?: () => CanvasLike | null | undefined } | null | undefined,
): boolean {
  try {
    const canvas = map?.getCanvas?.();
    if (!canvas) return false;
    const gl = (canvas.getContext("webgl2") ??
      canvas.getContext("webgl")) as RendererInfoSource | null;
    if (!gl) return false;
    return isSoftwareRendererName(webglRendererName(gl));
  } catch {
    return false;
  }
}
