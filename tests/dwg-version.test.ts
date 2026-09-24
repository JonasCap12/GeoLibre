import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  SUPPORTED_DWG_VERSION,
  dwgReleaseLabel,
  readDwgSupport,
} from "../apps/geolibre-desktop/src/lib/dwg-version";

/**
 * The bundled GDAL reads DWG through libopencad, which supports exactly one
 * version: R2000. Its refusal is perfectly clear — "libopencad 0.3.4 does not
 * support this version of CAD file. Supported formats are: DWG R2000
 * [ACAD1015]" — but it only comes out of `ST_Read`. The layer picker lists
 * layers with `ST_Read_Meta`, which returns an empty result and raises
 * nothing, so an AutoCAD 2007 drawing looked like a file with no layers in it.
 *
 * Reading the six-byte signature settles it before any of that runs.
 */

const signature = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("readDwgSupport", () => {
  it("accepts the one version the bundled GDAL can open", () => {
    const support = readDwgSupport(signature(`${SUPPORTED_DWG_VERSION}\0\0\0\0`));
    assert.equal(support?.version, "AC1015");
    assert.equal(support?.release, "2000");
    assert.equal(support?.supported, true);
  });

  it("identifies the release that reported this bug", () => {
    // The drawing that prompted the fix: BD TCXD ... ĐổiVềHệMét.dwg
    const support = readDwgSupport(signature("AC1021\0\0\0\0"));
    assert.equal(support?.release, "2007");
    assert.equal(support?.supported, false);
    assert.equal(dwgReleaseLabel(support!), "AutoCAD 2007");
  });

  it("names every modern release a user is likely to have", () => {
    const expected: [string, string][] = [
      ["AC1018", "2004"],
      ["AC1021", "2007"],
      ["AC1024", "2010"],
      ["AC1027", "2013"],
      ["AC1032", "2018"],
    ];
    for (const [version, release] of expected) {
      const support = readDwgSupport(signature(`${version}\0\0\0\0`));
      assert.equal(support?.release, release, version);
      assert.equal(support?.supported, false, version);
    }
  });

  it("falls back to the raw signature for an unknown code", () => {
    // A future release must still produce an actionable message rather than
    // "undefined", so the label degrades to the signature itself.
    const support = readDwgSupport(signature("AC1099\0\0\0\0"));
    assert.equal(support?.release, null);
    assert.equal(support?.supported, false);
    assert.equal(dwgReleaseLabel(support!), "AC1099");
  });

  it("returns null for anything that is not a DWG header", () => {
    // The check runs on whatever the user picked. A DXF, or a file renamed to
    // .dwg, must fall through to the normal path rather than be rejected with
    // a version message about a version it does not have.
    assert.equal(readDwgSupport(signature("  0\nSEC")), null);
    assert.equal(readDwgSupport(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), null, "a zip");
    assert.equal(readDwgSupport(new Uint8Array([0, 1, 2, 3, 4, 5])), null, "binary noise");
    assert.equal(readDwgSupport(new Uint8Array([65, 67])), null, "too short");
    assert.equal(readDwgSupport(new Uint8Array(0)), null, "empty");
  });

  it("reads only the header, not the whole file", () => {
    // A 9 MB drawing must not be scanned to answer this.
    const big = new Uint8Array(1_000_000);
    big.set(signature("AC1021"), 0);
    assert.equal(readDwgSupport(big)?.release, "2007");
  });
});

describe("binary DXF", () => {
  it("is named for what it is, not left to the parser", async () => {
    // Before this guard the user saw "Unexpected end of input: EOF group not
    // read before end of file. Ended on code undefined" — dxf-parser's report
    // of reading binary records as Latin-1 text — plus one console warning per
    // record. Nothing in that says "this variant is not supported".
    const { parseDxfDrawing } = await import("../apps/geolibre-desktop/src/lib/dxf-loader.ts");
    const magic = new TextEncoder().encode("AutoCAD Binary DXF\r\n\u001a\u0000");
    const bytes = new Uint8Array(magic.length + 128);
    bytes.set(magic, 0);
    await assert.rejects(
      () => parseDxfDrawing(bytes),
      (error: Error) => {
        assert.match(error.message, /binary DXF/i);
        assert.match(error.message, /ASCII DXF/i, "must say what to convert it to");
        return true;
      },
    );
  });

  it("lets an ordinary ASCII DXF through", async () => {
    const { parseDxfDrawing, ALL_LAYERS } = await import(
      "../apps/geolibre-desktop/src/lib/dxf-loader.ts"
    );
    const pairs: [number | string, string | number][] = [
      [0, "SECTION"], [2, "HEADER"], [9, "$ACADVER"], [1, "AC1021"], [0, "ENDSEC"],
      [0, "SECTION"], [2, "ENTITIES"],
      [0, "LINE"], [8, "road"], [10, 0], [20, 0], [11, 10], [21, 5],
      [0, "ENDSEC"], [0, "EOF"],
    ];
    const text = pairs.flatMap(([c, v]) => [String(c), String(v)]).join("\n") + "\n";
    const drawing = await parseDxfDrawing(new TextEncoder().encode(text));
    assert.equal(drawing.toFeatureCollection(ALL_LAYERS).features.length, 1);
  });
});

describe("every door gives the same answer", () => {
  it("checks the DWG version in the shared loader, not only the CAD panel", () => {
    // The first fix landed in CadSource alone, so a DWG dropped on the map,
    // opened from the file picker, or pulled from the shared library reached
    // none of it and failed as a DuckDB worker complaint about a file being in
    // use — a message with no mention of versions at all. This is the same
    // mistake the DXF fallback made before it moved here, so it is pinned.
    const loader = readFileSync(
      new URL("../apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts", import.meta.url),
      "utf8",
    );
    const entry = loader.slice(loader.indexOf("export async function loadDuckDbVectorFile"));
    const guard = entry.indexOf("readDwgSupport");
    const gdal = entry.indexOf("readVectorFileWithGdal");
    assert.ok(guard !== -1, "the shared loader no longer checks the DWG version");
    assert.ok(guard < gdal, "the check must run before the file reaches DuckDB");
  });

  it("names the release in the message, not just 'unsupported'", () => {
    const loader = readFileSync(
      new URL("../apps/geolibre-desktop/src/lib/duckdb-vector-loader.ts", import.meta.url),
      "utf8",
    );
    assert.ok(
      loader.includes("dwgReleaseLabel"),
      "the message must say which AutoCAD version wrote the file",
    );
  });
});
