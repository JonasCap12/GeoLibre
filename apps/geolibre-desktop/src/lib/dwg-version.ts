/**
 * Identify which AutoCAD release wrote a DWG, and whether anything here can
 * read it.
 *
 * The bundled GDAL reads DWG through libopencad, which supports exactly one
 * version: DWG R2000. Every later release fails. GDAL says so clearly —
 * "libopencad 0.3.4 does not support this version of CAD file. Supported
 * formats are: DWG R2000 [ACAD1015]" — but only from `ST_Read`. The layer
 * picker lists layers with `ST_Read_Meta`, which returns an empty result and
 * no error at all, so that explanation never reached the user and an
 * unsupported DWG looked like a drawing with no layers in it.
 *
 * A DWG names its own version in the first six bytes, so this needs no parser
 * and no GDAL round-trip: the file can be rejected with a useful message
 * before any of the expensive machinery starts.
 */

/** The only DWG version the bundled GDAL (libopencad) can open. */
export const SUPPORTED_DWG_VERSION = "AC1015";

/**
 * AutoCAD version strings to the release names people actually use. A DWG's
 * "Save as" dialog names the release, not the AC-code, so the message has to
 * speak in releases for the user to act on it.
 */
const DWG_RELEASES: Record<string, string> = {
  "MC0.0": "1.0",
  "AC1.2": "1.2",
  "AC1.4": "1.4",
  "AC1.50": "2.0",
  "AC2.10": "2.10",
  AC1002: "2.5",
  AC1003: "2.6",
  AC1004: "9",
  AC1006: "10",
  AC1009: "11/12",
  AC1012: "13",
  AC1014: "14",
  AC1015: "2000",
  AC1018: "2004",
  AC1021: "2007",
  AC1024: "2010",
  AC1027: "2013",
  AC1032: "2018",
};

/** What a DWG's header says about itself. */
export interface DwgSupport {
  /** The raw six-character signature, e.g. `AC1021`. */
  version: string;
  /** The AutoCAD release, e.g. `2007`, or null for an unrecognised code. */
  release: string | null;
  /** Whether the bundled GDAL can open this version. */
  supported: boolean;
}

/**
 * Read a DWG's version signature.
 *
 * @param bytes - The start of the file; only the first six bytes are read.
 * @returns The signature and what it means, or null when this is not a DWG.
 */
export function readDwgSupport(bytes: Uint8Array): DwgSupport | null {
  if (bytes.byteLength < 6) return null;
  let version = "";
  for (let i = 0; i < 6; i += 1) {
    const code = bytes[i];
    // The signature is plain ASCII. Anything else means this is not a DWG
    // header, so stop rather than invent a version from binary noise.
    if (code < 0x20 || code > 0x7e) return null;
    version += String.fromCharCode(code);
  }
  if (!/^(AC|MC)/.test(version)) return null;
  const trimmed = version.replace(/\0+$/, "");
  return {
    version: trimmed,
    release: DWG_RELEASES[trimmed] ?? null,
    supported: trimmed === SUPPORTED_DWG_VERSION,
  };
}

/**
 * The release name to show for a DWG, falling back to the raw signature.
 *
 * @param support - The parsed header.
 * @returns Something a user can match against their "Save as" dialog.
 */
export function dwgReleaseLabel(support: DwgSupport): string {
  return support.release ? `AutoCAD ${support.release}` : support.version;
}
