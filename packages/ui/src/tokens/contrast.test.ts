/**
 * Contrast tests for the palette itself.
 *
 * This is the palette's own check, not the gate's. The gate (`tokens:check`)
 * exists to catch a future edit that breaks the contract; this test exists so the
 * contract is verified while the palette is being written, before any component
 * consumes it.
 *
 * Every pair asserted here is a pair a component will actually render. Measuring
 * a colour against a background nothing puts it on would be cargo-cult
 * compliance: the ratio would pass and the screen would still be unreadable.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_RATIO_BODY_TEXT,
  MIN_RATIO_LARGE_TEXT_OR_ICON,
  THEMES,
  THEME_COMBINATIONS,
  contrastRatio,
  isHexColor,
  parseHex,
  relativeLuminance,
  themeKey,
} from "./index.js";
import type { Palette } from "./palettes.js";

/** The three surface steps a foreground can land on. */
const SURFACES = ["--ui-color-surface-1", "--ui-color-surface-2", "--ui-color-surface-3"] as const;

/** Status families that pair a foreground with a subtle background. */
const STATUS_FAMILIES = ["danger", "warning", "success", "info"] as const;

/**
 * @param key theme key
 * @returns the theme's tokens narrowed to palette entries
 */
function paletteOf(key: string): Record<string, string> {
  const theme = THEMES[key];

  if (theme === undefined) throw new Error(`no theme ${key}`);

  return theme.tokens as unknown as Record<string, string>;
}

describe("contrast primitives", () => {
  it("computes the documented extremes", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#1a5fd0", "#ffffff")).toBeCloseTo(
      contrastRatio("#ffffff", "#1a5fd0"),
      10,
    );
  });

  it("expands three-digit shorthand to the same colour", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("#0a0")).toEqual(parseHex("#00aa00"));
    expect(relativeLuminance("#fff")).toBeCloseTo(1, 10);
  });

  it("ignores the alpha channel of an eight-digit value", () => {
    expect(parseHex("#1a5fd080")).toEqual(parseHex("#1a5fd0"));
  });

  it("rejects a value that is not a hex colour", () => {
    expect(isHexColor("red")).toBe(false);
    expect(isHexColor("rgb(0 0 0)")).toBe(false);
    expect(() => parseHex("#12345")).toThrow();
  });
});

describe("palette contrast", () => {
  it("keeps primary text readable on every surface, in every theme", () => {
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const surface of SURFACES) {
        const ratio = contrastRatio(
          tokens["--ui-color-neutral-1"] as string,
          tokens[surface] as string,
        );

        expect(ratio, `neutral-1 on ${surface} in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_BODY_TEXT,
        );
      }
    }
  });

  it("keeps secondary text readable on every surface, in every theme", () => {
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const surface of SURFACES) {
        const ratio = contrastRatio(
          tokens["--ui-color-neutral-2"] as string,
          tokens[surface] as string,
        );

        expect(ratio, `neutral-2 on ${surface} in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_BODY_TEXT,
        );
      }
    }
  });

  it("keeps borders and icon strokes at the non-text threshold", () => {
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const surface of SURFACES) {
        const ratio = contrastRatio(
          tokens["--ui-color-neutral-3"] as string,
          tokens[surface] as string,
        );

        expect(ratio, `neutral-3 on ${surface} in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_LARGE_TEXT_OR_ICON,
        );
      }
    }
  });

  it("keeps the accent readable on the base surface", () => {
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);
      const ratio = contrastRatio(
        tokens["--ui-color-accent-1"] as string,
        tokens["--ui-color-surface-1"] as string,
      );

      expect(ratio, `accent-1 in ${key}`).toBeGreaterThanOrEqual(MIN_RATIO_BODY_TEXT);
    }
  });

  it("keeps a label readable on an accent fill in every theme", () => {
    // static-1 is the light label and static-2 the dark one; which one is used
    // depends on the theme, so both are checked and the better pair wins.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);
      const accent = tokens["--ui-color-accent-1"] as string;
      const best = Math.max(
        contrastRatio(tokens["--ui-color-static-1"] as string, accent),
        contrastRatio(tokens["--ui-color-static-2"] as string, accent),
      );

      expect(best, `static foreground on accent in ${key}`).toBeGreaterThanOrEqual(
        MIN_RATIO_BODY_TEXT,
      );
    }
  });

  it("keeps every status foreground readable on its own subtle background", () => {
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const family of STATUS_FAMILIES) {
        const ratio = contrastRatio(
          tokens[`--ui-color-${family}-1`] as string,
          tokens[`--ui-color-${family}-2`] as string,
        );

        expect(ratio, `${family}-1 on ${family}-2 in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_BODY_TEXT,
        );
      }
    }
  });

  it("keeps every status foreground readable on the base surface too", () => {
    // A status colour appears as inline text at least as often as on its own
    // background, so it needs both.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const family of STATUS_FAMILIES) {
        const ratio = contrastRatio(
          tokens[`--ui-color-${family}-1`] as string,
          tokens["--ui-color-surface-1"] as string,
        );

        expect(ratio, `${family}-1 on surface-1 in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_BODY_TEXT,
        );
      }
    }
  });

  it("raises contrast in the high variants rather than changing hue", () => {
    // high contrast must be a strictly better or equal read on the pairs it is
    // meant to improve; otherwise it is just a different palette.
    const pairs: ReadonlyArray<[keyof Palette, keyof Palette]> = [
      ["--ui-color-neutral-1", "--ui-color-surface-1"],
      ["--ui-color-neutral-2", "--ui-color-surface-1"],
      ["--ui-color-neutral-3", "--ui-color-surface-1"],
      ["--ui-color-accent-1", "--ui-color-surface-1"],
    ];

    for (const mode of ["light", "dark"] as const) {
      const normal = paletteOf(`${mode}/normal`);
      const high = paletteOf(`${mode}/high`);

      for (const [foreground, background] of pairs) {
        const normalRatio = contrastRatio(
          normal[foreground] as string,
          normal[background] as string,
        );
        const highRatio = contrastRatio(high[foreground] as string, high[background] as string);

        expect(highRatio, `${mode}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(
          normalRatio,
        );
      }
    }
  });

  it("uses opaque hex for every colour slot", () => {
    for (const attrs of THEME_COMBINATIONS) {
      const tokens = paletteOf(themeKey(attrs));

      for (const [name, value] of Object.entries(tokens)) {
        if (
          !name.startsWith("--ui-color-") &&
          !name.startsWith("--ui-code-") &&
          !name.startsWith("--ui-math-") &&
          !name.startsWith("--ui-diff-")
        ) {
          continue;
        }

        expect(isHexColor(value), `${name} in ${themeKey(attrs)} is ${value}`).toBe(true);
        expect(value.length, `${name} must be opaque`).not.toBe(9);
      }
    }
  });
});
