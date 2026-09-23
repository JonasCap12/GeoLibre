import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  shouldUseDxfFallback,
  VectorLoadCancelledError,
} from "../apps/geolibre-desktop/src/lib/duckdb-vector-guard";

/**
 * The bundled GDAL (3.8.5, pinned inside DuckDB Spatial) cannot open some DXF
 * BLOCKS sections. It fails two ways: loudly, with
 * `Invalid Error: osBlockName` out of `DESCRIBE ST_Read(...)`, and silently, by
 * reporting zero features for a drawing full of geometry.
 *
 * `dxf-loader.ts` reads those files. It was wired only into the Add Data → CAD
 * panel, so the same drawing failed when dropped on the map or opened from the
 * file picker. The fallback now lives in the shared loader every entry point
 * goes through; this covers the decision that guards it.
 */

describe("DXF fallback routing", () => {
  it("leaves other formats alone", () => {
    // A broken GeoPackage or shapefile has no in-process reader to fall back
    // to, and retrying would only delay the real error.
    for (const extension of ["gpkg", "shp", "geojson", "parquet", "dwg"]) {
      assert.equal(shouldUseDxfFallback(extension, { error: new Error("boom") }), false, extension);
      assert.equal(shouldUseDxfFallback(extension, { featureCount: 0 }), false, extension);
    }
  });

  it("falls back when GDAL throws on a DXF", () => {
    const gdalError = new Error("Invalid Error: osBlockName");
    assert.equal(shouldUseDxfFallback("dxf", { error: gdalError }), true);
  });

  it("falls back when GDAL reports a DXF as empty", () => {
    assert.equal(shouldUseDxfFallback("dxf", { featureCount: 0 }), true);
  });

  it("keeps a successful read", () => {
    assert.equal(shouldUseDxfFallback("dxf", { featureCount: 1 }), false);
    assert.equal(shouldUseDxfFallback("dxf", { featureCount: 117_200 }), false);
  });

  it("never re-reads a file the user declined", () => {
    // The large-dataset guard asks before materializing a huge drawing. Taking
    // a cancellation as "GDAL failed" would re-read the same file in JS and
    // load it anyway — the one outcome the prompt exists to prevent.
    const declined = new VectorLoadCancelledError("cancelled");
    assert.equal(shouldUseDxfFallback("dxf", { error: declined }), false);
  });
});

describe("the shared loader keeps the bytes the fallback needs", () => {
  it("copies the buffer before handing it to DuckDB", () => {
    // registerVectorFileBuffers transfers the ArrayBuffer to the worker, which
    // detaches it here. Without the copy the fallback receives an empty view
    // and reports a drawing with no geometry — a failure that looks exactly
    // like a genuinely empty file.
    const source = readFileSync(
      new URL("../apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts", import.meta.url),
      "utf8",
    );
    const body = source.slice(source.indexOf("export async function loadDuckDbVectorFile"));
    const copyAt = body.indexOf("file.data.slice()");
    const readAt = body.indexOf("await readVectorFileWithGdal");
    assert.ok(copyAt !== -1, "the DXF byte copy is gone");
    assert.ok(readAt !== -1, "the GDAL read is gone");
    assert.ok(copyAt < readAt, "the copy must happen before DuckDB detaches the buffer");
  });
});
