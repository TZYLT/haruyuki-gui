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
 * The eight normal ANSI colours, in SGR index order.
 *
 * A terminal program paints any of these as foreground text -- `ls --color`,
 * `git diff`, a compiler diagnostic -- so each one is body text on the terminal
 * background and takes the body-text threshold.
 */
const ANSI_NORMAL = [
  "--ui-terminal-ansi-black",
  "--ui-terminal-ansi-red",
  "--ui-terminal-ansi-green",
  "--ui-terminal-ansi-yellow",
  "--ui-terminal-ansi-blue",
  "--ui-terminal-ansi-magenta",
  "--ui-terminal-ansi-cyan",
  "--ui-terminal-ansi-white",
] as const;

/**
 * The eight bright ANSI colours, the SGR 90-97 range.
 *
 * Bright is the bold/high-intensity variant a program reaches for to add
 * emphasis, which is a non-text-level distinction rather than a second body
 * colour, so it takes the large-text threshold. It is asserted rather than
 * assumed: the values are ours, and a bright slot that sinks into the terminal
 * background is still a program whose bold text is invisible.
 */
const ANSI_BRIGHT = [
  "--ui-terminal-ansi-brightBlack",
  "--ui-terminal-ansi-brightRed",
  "--ui-terminal-ansi-brightGreen",
  "--ui-terminal-ansi-brightYellow",
  "--ui-terminal-ansi-brightBlue",
  "--ui-terminal-ansi-brightMagenta",
  "--ui-terminal-ansi-brightCyan",
  "--ui-terminal-ansi-brightWhite",
] as const;

/**
 * The background the ANSI colours are measured against.
 *
 * `--ui-code-bg` is the surface closest to a terminal background that already
 * exists, and it is the one a code block and a terminal panel actually share, so
 * measuring against it measures the pair that renders instead of a pair nothing
 * puts a colour on.
 */
const TERMINAL_BACKGROUND = "--ui-code-bg";

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

  it("keeps a label readable on a filled control in every theme", () => {
    // `static-1` is what a filled control puts its label in: the primary button
    // (on `accent-1`), its hover state (on `accent-2`) and the danger button (on
    // `danger-1`). It is asserted **as used**, not as "whichever of static-1 and
    // static-2 happens to pass": the previous version took
    // `Math.max(ratio(static-1), ratio(static-2))`, which cannot fail for any
    // palette, and it therefore reported green while the dark themes rendered
    // white label on light blue at 2.33:1.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);
      const label = tokens["--ui-color-static-1"] as string;

      for (const fill of ["--ui-color-accent-1", "--ui-color-accent-2", "--ui-color-danger-1"]) {
        const ratio = contrastRatio(label, tokens[fill] as string);

        expect(ratio, `static-1 on ${fill} in ${key}`).toBeGreaterThanOrEqual(MIN_RATIO_BODY_TEXT);
      }
    }
  });

  it("keeps the switch thumb visible against both of its tracks", () => {
    // The thumb is `static-1`; the track is `neutral-3` when off and `accent-1`
    // when on. A thumb that matches its track is a switch that does not show its
    // state, so this is the non-text threshold rather than a text one for the
    // off state -- but the on state has to beat the text threshold too, because
    // the same colour is the label of a filled button.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);
      const thumb = tokens["--ui-color-static-1"] as string;

      expect(
        contrastRatio(thumb, tokens["--ui-color-neutral-3"] as string),
        `thumb on the off track in ${key}`,
      ).toBeGreaterThanOrEqual(MIN_RATIO_LARGE_TEXT_OR_ICON);

      expect(
        contrastRatio(thumb, tokens["--ui-color-accent-1"] as string),
        `thumb on the on track in ${key}`,
      ).toBeGreaterThanOrEqual(MIN_RATIO_LARGE_TEXT_OR_ICON);
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

  it("keeps every normal ANSI colour readable as terminal text", () => {
    // A terminal does not choose its colours; the program inside does, by index.
    // Any of the eight may therefore end up as the foreground of ordinary text on
    // the terminal background, so each one has to clear the body-text threshold
    // there rather than only in a designer's preview.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const slot of ANSI_NORMAL) {
        const ratio = contrastRatio(tokens[slot] as string, tokens[TERMINAL_BACKGROUND] as string);

        expect(ratio, `${slot} on ${TERMINAL_BACKGROUND} in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_BODY_TEXT,
        );
      }
    }
  });

  it("keeps every bright ANSI colour above the non-text threshold", () => {
    // Bright is the high-intensity variant a program uses for emphasis. It is the
    // same text, so leaving it unmeasured would leave the emphasis case to
    // chance; the threshold is the non-text one because bright is a distinction
    // on top of readable, not a second body colour.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (const slot of ANSI_BRIGHT) {
        const ratio = contrastRatio(tokens[slot] as string, tokens[TERMINAL_BACKGROUND] as string);

        expect(ratio, `${slot} on ${TERMINAL_BACKGROUND} in ${key}`).toBeGreaterThanOrEqual(
          MIN_RATIO_LARGE_TEXT_OR_ICON,
        );
      }
    }
  });

  it("keeps each ANSI colour apart from its bright variant", () => {
    // `\e[31m` and `\e[91m` are two different instructions for the same meaning.
    // If the two values are equal the program cannot express emphasis at all; if
    // bright is not the lighter of the pair it renders as de-emphasis, which is
    // the opposite of what a program asking for bright means.
    for (const key of Object.keys(THEMES)) {
      const tokens = paletteOf(key);

      for (let index = 0; index < ANSI_NORMAL.length; index += 1) {
        const normal = tokens[ANSI_NORMAL[index] as string] as string;
        const bright = tokens[ANSI_BRIGHT[index] as string] as string;

        expect(
          relativeLuminance(bright),
          `${ANSI_BRIGHT[index]} is not lighter than ${ANSI_NORMAL[index]} in ${key}`,
        ).toBeGreaterThan(relativeLuminance(normal));
      }
    }
  });

  it("uses opaque hex for every colour slot", () => {
    // The two overlay slots are the documented exception: they are translucent
    // *by definition* -- a scrim that is opaque is a black rectangle, and a
    // shadow that is opaque is a drop of paint. Every other colour slot has to
    // be an opaque hex so the contrast maths can measure it at all.
    const TRANSLUCENT = new Set(["--ui-color-scrim", "--ui-color-shadow"]);

    for (const attrs of THEME_COMBINATIONS) {
      const tokens = paletteOf(themeKey(attrs));

      for (const [name, value] of Object.entries(tokens)) {
        if (
          !name.startsWith("--ui-color-") &&
          !name.startsWith("--ui-code-") &&
          !name.startsWith("--ui-math-") &&
          !name.startsWith("--ui-diff-") &&
          !name.startsWith("--ui-terminal-")
        ) {
          continue;
        }

        if (TRANSLUCENT.has(name)) {
          // An overlay still has to be *parseable*: `rgb(r g b / a)` with a
          // percentage alpha, so a theme cannot quietly set it to `none`.
          expect(value, `${name} in ${themeKey(attrs)} must be a translucent rgb()`).toMatch(
            /^rgb\(\d+ \d+ \d+ \/ \d{1,3}%\)$/,
          );
          continue;
        }

        expect(isHexColor(value), `${name} in ${themeKey(attrs)} is ${value}`).toBe(true);
        expect(value.length, `${name} must be opaque`).not.toBe(9);
      }
    }
  });
});
