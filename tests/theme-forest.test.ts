import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DEFAULT_THEME_SCHEME } from "../apps/geolibre-desktop/src/lib/theme-schemes";

const css = readFileSync(new URL("../packages/ui/src/theme.css", import.meta.url), "utf8");

type Hsl = [number, number, number];

function tokenBlock(selector: string): Record<string, Hsl> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `missing ${selector} token block`);
  return Object.fromEntries(
    [...match[1].matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)].map(
      ([, name, hue, saturation, lightness]) => [
        name,
        [Number(hue), Number(saturation), Number(lightness)] as Hsl,
      ],
    ),
  );
}

function luminance([hue, saturationValue, lightnessValue]: Hsl): number {
  const saturation = saturationValue / 100;
  const lightness = lightnessValue / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const offset = lightness - chroma / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [chroma, x, 0];
  else if (hue < 120) rgb = [x, chroma, 0];
  else if (hue < 180) rgb = [0, chroma, x];
  else if (hue < 240) rgb = [0, x, chroma];
  else if (hue < 300) rgb = [x, 0, chroma];
  else rgb = [chroma, 0, x];
  const linear = rgb.map((channel) => {
    const value = channel + offset;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: Hsl, second: Hsl): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function assertContrast(
  tokens: Record<string, Hsl>,
  foreground: string,
  background: string,
  minimum: number,
): void {
  assert.ok(tokens[foreground], `missing --${foreground}`);
  assert.ok(tokens[background], `missing --${background}`);
  const ratio = contrast(tokens[foreground], tokens[background]);
  assert.ok(ratio >= minimum, `${foreground}/${background} is ${ratio.toFixed(2)}:1`);
}

const light = { ...tokenBlock(":root"), ...tokenBlock('[data-theme="forest"]') };
const dark = {
  ...tokenBlock(".dark"),
  ...tokenBlock('[data-theme="forest"].dark'),
};

describe("forest theme contrast", () => {
  for (const [mode, tokens] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`${mode} tokens meet the required contrast floors`, () => {
      assertContrast(tokens, "primary-foreground", "primary", 4.5);
      for (const surface of ["background", "card", "popover"]) {
        assertContrast(tokens, "ring", surface, 3);
      }
      assertContrast(tokens, "header-foreground", "header", 4.5);
      assertContrast(tokens, "muted-foreground", "muted", 4.5);
    });
  }

  it("is the default while blue remains selectable", () => {
    assert.equal(DEFAULT_THEME_SCHEME, "forest");
    assert.match(css, /\[data-theme="blue"\]\s*\{/);
  });
});
