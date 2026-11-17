/**
 * The four theme palettes.
 *
 * Colour is the only thing that varies across the 2x2 grid (see `scales.ts`);
 * everything else is shared. Each palette below satisfies the same accessibility
 * contract, which is what makes the grid meaningful rather than four unrelated
 * skins:
 *
 * - `neutral-1` (primary text) >= 4.5:1 on every surface
 * - `neutral-2` (secondary text, icons) >= 4.5:1 on every surface
 * - `neutral-3` (borders, dividers, icon strokes) >= 3:1 on every surface, the
 *   WCAG non-text threshold -- which is why it is darker than a border usually
 *   looks in a design file
 * - `accent-1` >= 4.5:1 on `surface-1`, and the static foreground reaches 4.5:1
 *   against it so a filled button label is readable in every combination
 * - each status foreground >= 4.5:1 on both `surface-1` and its own subtle
 *   background
 * - each of the eight normal ANSI colours >= 4.5:1 on `code-bg`, and each of the
 *   eight bright ones >= 3:1 there, because a terminal program decides which of
 *   the sixteen it paints without asking us
 *
 * The ANSI sixteen are their own namespace (`--ui-terminal-ansi-*`) because the
 * names are fixed by the terminal protocol rather than by our semantic families.
 * They are solved the same way as everything else here: a fixed hue and
 * saturation per family in all four themes, and a lightness picked so the ratio
 * lands on the threshold. The bright step is systematically the lighter one, so
 * `\e[91m` reads as emphasis instead of as a second body colour.
 *
 * The values are measured by `tokens/contrast.ts` and enforced by the token gate
 * and by `contrast.test.ts`. They were chosen against those ratios, not judged by
 * eye, because "looks readable" and "is 4.5:1" disagree more often than not.
 *
 * `high` contrast does not change hue: it widens the luminance gap. That keeps a
 * brand colour recognisable while raising every pair well past the minimum.
 */

import type { ColorFamily } from "./slots.js";

/** The colour slots of one theme. Values are opaque hex. */
export interface Palette {
  "--ui-color-surface-1": string;
  "--ui-color-surface-2": string;
  "--ui-color-surface-3": string;
  "--ui-color-neutral-1": string;
  "--ui-color-neutral-2": string;
  "--ui-color-neutral-3": string;
  "--ui-color-static-1": string;
  "--ui-color-static-2": string;
  "--ui-color-scrim": string;
  "--ui-color-shadow": string;
  "--ui-color-accent-1": string;
  "--ui-color-accent-2": string;
  "--ui-color-accent-3": string;
  "--ui-color-danger-1": string;
  "--ui-color-danger-2": string;
  "--ui-color-warning-1": string;
  "--ui-color-warning-2": string;
  "--ui-color-success-1": string;
  "--ui-color-success-2": string;
  "--ui-color-info-1": string;
  "--ui-color-info-2": string;
  "--ui-code-fg": string;
  "--ui-code-bg": string;
  "--ui-code-lineNumber": string;
  "--ui-code-selection": string;
  "--ui-code-border": string;
  "--ui-math-fg": string;
  "--ui-math-error": string;
  "--ui-math-bg": string;
  "--ui-diff-add": string;
  "--ui-diff-remove": string;
  "--ui-diff-unchanged": string;
  "--ui-diff-inlineAdd": string;
  "--ui-diff-inlineRemove": string;
  "--ui-diff-bg": string;
  "--ui-terminal-ansi-black": string;
  "--ui-terminal-ansi-red": string;
  "--ui-terminal-ansi-green": string;
  "--ui-terminal-ansi-yellow": string;
  "--ui-terminal-ansi-blue": string;
  "--ui-terminal-ansi-magenta": string;
  "--ui-terminal-ansi-cyan": string;
  "--ui-terminal-ansi-white": string;
  "--ui-terminal-ansi-brightBlack": string;
  "--ui-terminal-ansi-brightRed": string;
  "--ui-terminal-ansi-brightGreen": string;
  "--ui-terminal-ansi-brightYellow": string;
  "--ui-terminal-ansi-brightBlue": string;
  "--ui-terminal-ansi-brightMagenta": string;
  "--ui-terminal-ansi-brightCyan": string;
  "--ui-terminal-ansi-brightWhite": string;
}

/** Light, normal contrast: the default theme. */
export const LIGHT_NORMAL: Palette = {
  "--ui-color-surface-1": "#ffffff",
  "--ui-color-surface-2": "#f7f8fa",
  "--ui-color-surface-3": "#ffffff",
  "--ui-color-neutral-1": "#1c1f23",
  "--ui-color-neutral-2": "#5a6572",
  "--ui-color-neutral-3": "#868e99",
  "--ui-color-static-1": "#ffffff",
  "--ui-color-static-2": "#1c1f23",
  "--ui-color-scrim": "rgb(0 0 0 / 40%)",
  "--ui-color-shadow": "rgb(0 0 0 / 12%)",
  "--ui-color-accent-1": "#1a5fd0",
  "--ui-color-accent-2": "#1550b0",
  "--ui-color-accent-3": "#e8f0fd",
  "--ui-color-danger-1": "#b3261e",
  "--ui-color-danger-2": "#fdeceb",
  "--ui-color-warning-1": "#8a5300",
  "--ui-color-warning-2": "#fdf3e2",
  "--ui-color-success-1": "#17623c",
  "--ui-color-success-2": "#e7f5ec",
  "--ui-color-info-1": "#0f5b8a",
  "--ui-color-info-2": "#e6f2f9",
  "--ui-code-fg": "#1c1f23",
  "--ui-code-bg": "#f7f8fa",
  "--ui-code-lineNumber": "#5a6572",
  "--ui-code-selection": "#dbe7fb",
  "--ui-code-border": "#dfe3e9",
  "--ui-math-fg": "#1c1f23",
  "--ui-math-error": "#b3261e",
  "--ui-math-bg": "#fbfbfc",
  "--ui-diff-add": "#e6f4ea",
  "--ui-diff-remove": "#fdecea",
  "--ui-diff-unchanged": "#f7f8fa",
  "--ui-diff-inlineAdd": "#c6e7d0",
  "--ui-diff-inlineRemove": "#f8c9c4",
  "--ui-diff-bg": "#ffffff",
  "--ui-terminal-ansi-black": "#101213",
  "--ui-terminal-ansi-red": "#992a24",
  "--ui-terminal-ansi-green": "#1f5e39",
  "--ui-terminal-ansi-yellow": "#704c0c",
  "--ui-terminal-ansi-blue": "#274f9d",
  "--ui-terminal-ansi-magenta": "#8f2b6a",
  "--ui-terminal-ansi-cyan": "#1d5a67",
  "--ui-terminal-ansi-white": "#656d79",
  "--ui-terminal-ansi-brightBlack": "#606873",
  "--ui-terminal-ansi-brightRed": "#d6564f",
  "--ui-terminal-ansi-brightGreen": "#309159",
  "--ui-terminal-ansi-brightYellow": "#ac7413",
  "--ui-terminal-ansi-brightBlue": "#547ed4",
  "--ui-terminal-ansi-brightMagenta": "#cc54a0",
  "--ui-terminal-ansi-brightCyan": "#2d8a9f",
  "--ui-terminal-ansi-brightWhite": "#858d99",
};

/** Light, high contrast: black text, wider gaps, same hues. */
export const LIGHT_HIGH: Palette = {
  "--ui-color-surface-1": "#ffffff",
  "--ui-color-surface-2": "#f2f4f6",
  "--ui-color-surface-3": "#ffffff",
  "--ui-color-neutral-1": "#000000",
  "--ui-color-neutral-2": "#333a42",
  "--ui-color-neutral-3": "#5c646e",
  "--ui-color-static-1": "#ffffff",
  "--ui-color-static-2": "#000000",
  "--ui-color-scrim": "rgb(0 0 0 / 60%)",
  "--ui-color-shadow": "rgb(0 0 0 / 28%)",
  "--ui-color-accent-1": "#0b3ea8",
  "--ui-color-accent-2": "#082f80",
  "--ui-color-accent-3": "#dbe8fb",
  "--ui-color-danger-1": "#8c0f0a",
  "--ui-color-danger-2": "#fbe4e2",
  "--ui-color-warning-1": "#5c3400",
  "--ui-color-warning-2": "#fbeacd",
  "--ui-color-success-1": "#0a4429",
  "--ui-color-success-2": "#d9f0e2",
  "--ui-color-info-1": "#083f63",
  "--ui-color-info-2": "#d5eaf5",
  "--ui-code-fg": "#000000",
  "--ui-code-bg": "#f2f4f6",
  "--ui-code-lineNumber": "#333a42",
  "--ui-code-selection": "#cfe0fa",
  "--ui-code-border": "#5c646e",
  "--ui-math-fg": "#000000",
  "--ui-math-error": "#8c0f0a",
  "--ui-math-bg": "#ffffff",
  "--ui-diff-add": "#d9f0e2",
  "--ui-diff-remove": "#fbe4e2",
  "--ui-diff-unchanged": "#f2f4f6",
  "--ui-diff-inlineAdd": "#a9dcbc",
  "--ui-diff-inlineRemove": "#f6bdb7",
  "--ui-diff-bg": "#ffffff",
  "--ui-terminal-ansi-black": "#060607",
  "--ui-terminal-ansi-red": "#74201b",
  "--ui-terminal-ansi-green": "#18472b",
  "--ui-terminal-ansi-yellow": "#553909",
  "--ui-terminal-ansi-blue": "#1e3c78",
  "--ui-terminal-ansi-magenta": "#6c2050",
  "--ui-terminal-ansi-cyan": "#16434e",
  "--ui-terminal-ansi-white": "#59616b",
  "--ui-terminal-ansi-brightBlack": "#515861",
  "--ui-terminal-ansi-brightRed": "#d03c35",
  "--ui-terminal-ansi-brightGreen": "#2b824f",
  "--ui-terminal-ansi-brightYellow": "#9a6811",
  "--ui-terminal-ansi-brightBlue": "#3f6fcf",
  "--ui-terminal-ansi-brightMagenta": "#c43b92",
  "--ui-terminal-ansi-brightCyan": "#287c8f",
  "--ui-terminal-ansi-brightWhite": "#757f8c",
};

/** Dark, normal contrast. */
export const DARK_NORMAL: Palette = {
  "--ui-color-surface-1": "#16181c",
  "--ui-color-surface-2": "#1e2127",
  "--ui-color-surface-3": "#262a31",
  "--ui-color-neutral-1": "#eef1f5",
  "--ui-color-neutral-2": "#a7b0bc",
  "--ui-color-neutral-3": "#6c7684",
  "--ui-color-static-1": "#121417",
  "--ui-color-static-2": "#16181c",
  "--ui-color-scrim": "rgb(0 0 0 / 55%)",
  "--ui-color-shadow": "rgb(0 0 0 / 45%)",
  "--ui-color-accent-1": "#79aaff",
  "--ui-color-accent-2": "#9dbeff",
  "--ui-color-accent-3": "#1c2c47",
  "--ui-color-danger-1": "#ff9a92",
  "--ui-color-danger-2": "#3a2020",
  "--ui-color-warning-1": "#f0bb63",
  "--ui-color-warning-2": "#352a17",
  "--ui-color-success-1": "#7fd7a3",
  "--ui-color-success-2": "#1a2f24",
  "--ui-color-info-1": "#86c8ee",
  "--ui-color-info-2": "#172a35",
  "--ui-code-fg": "#eef1f5",
  "--ui-code-bg": "#1e2127",
  "--ui-code-lineNumber": "#a7b0bc",
  "--ui-code-selection": "#2b3d5c",
  "--ui-code-border": "#3a4048",
  "--ui-math-fg": "#eef1f5",
  "--ui-math-error": "#ff9a92",
  "--ui-math-bg": "#1a1d22",
  "--ui-diff-add": "#1a2f24",
  "--ui-diff-remove": "#3a2020",
  "--ui-diff-unchanged": "#1e2127",
  "--ui-diff-inlineAdd": "#28472f",
  "--ui-diff-inlineRemove": "#4d2a28",
  "--ui-diff-bg": "#16181c",
  "--ui-terminal-ansi-black": "#818995",
  "--ui-terminal-ansi-red": "#e28a85",
  "--ui-terminal-ansi-green": "#3db66f",
  "--ui-terminal-ansi-yellow": "#da9318",
  "--ui-terminal-ansi-blue": "#83a2e0",
  "--ui-terminal-ansi-magenta": "#db87bc",
  "--ui-terminal-ansi-cyan": "#3eafc9",
  "--ui-terminal-ansi-white": "#dbdde1",
  "--ui-terminal-ansi-brightBlack": "#9097a2",
  "--ui-terminal-ansi-brightRed": "#eeb9b7",
  "--ui-terminal-ansi-brightGreen": "#85d6a7",
  "--ui-terminal-ansi-brightYellow": "#eebe6a",
  "--ui-terminal-ansi-brightBlue": "#b4c6ec",
  "--ui-terminal-ansi-brightMagenta": "#e9b6d7",
  "--ui-terminal-ansi-brightCyan": "#8ed0df",
  "--ui-terminal-ansi-brightWhite": "#ecedef",
};

/** Dark, high contrast: white text, wider gaps, same hues. */
export const DARK_HIGH: Palette = {
  "--ui-color-surface-1": "#0b0d10",
  "--ui-color-surface-2": "#14171b",
  "--ui-color-surface-3": "#1c2026",
  "--ui-color-neutral-1": "#ffffff",
  "--ui-color-neutral-2": "#c9d1da",
  "--ui-color-neutral-3": "#8b95a2",
  "--ui-color-static-1": "#0b0d10",
  "--ui-color-static-2": "#000000",
  "--ui-color-scrim": "rgb(0 0 0 / 72%)",
  "--ui-color-shadow": "rgb(0 0 0 / 60%)",
  "--ui-color-accent-1": "#a8c8ff",
  "--ui-color-accent-2": "#c7dbff",
  "--ui-color-accent-3": "#17233a",
  "--ui-color-danger-1": "#ffc0ba",
  "--ui-color-danger-2": "#2e1413",
  "--ui-color-warning-1": "#ffd79a",
  "--ui-color-warning-2": "#2b2010",
  "--ui-color-success-1": "#aae8c4",
  "--ui-color-success-2": "#12251a",
  "--ui-color-info-1": "#b3dbf5",
  "--ui-color-info-2": "#101f29",
  "--ui-code-fg": "#ffffff",
  "--ui-code-bg": "#14171b",
  "--ui-code-lineNumber": "#c9d1da",
  "--ui-code-selection": "#25395c",
  "--ui-code-border": "#8b95a2",
  "--ui-math-fg": "#ffffff",
  "--ui-math-error": "#ffc0ba",
  "--ui-math-bg": "#0b0d10",
  "--ui-diff-add": "#12251a",
  "--ui-diff-remove": "#2e1413",
  "--ui-diff-unchanged": "#14171b",
  "--ui-diff-inlineAdd": "#1e4030",
  "--ui-diff-inlineRemove": "#4a1f1d",
  "--ui-diff-bg": "#0b0d10",
  "--ui-terminal-ansi-black": "#8a929e",
  "--ui-terminal-ansi-red": "#e69a96",
  "--ui-terminal-ansi-green": "#4bc37d",
  "--ui-terminal-ansi-yellow": "#e79f23",
  "--ui-terminal-ansi-blue": "#93aee4",
  "--ui-terminal-ansi-magenta": "#e097c5",
  "--ui-terminal-ansi-cyan": "#58bad0",
  "--ui-terminal-ansi-white": "#e3e5e8",
  "--ui-terminal-ansi-brightBlack": "#9ca3ad",
  "--ui-terminal-ansi-brightRed": "#f1c5c3",
  "--ui-terminal-ansi-brightGreen": "#9addb6",
  "--ui-terminal-ansi-brightYellow": "#f1c983",
  "--ui-terminal-ansi-brightBlue": "#c0d0ef",
  "--ui-terminal-ansi-brightMagenta": "#edc2dd",
  "--ui-terminal-ansi-brightCyan": "#a0d8e4",
  "--ui-terminal-ansi-brightWhite": "#f2f3f5",
};

/** Colour family helper for gates that want to group slots. */
export const COLOR_FAMILIES: readonly ColorFamily[] = [
  "surface",
  "neutral",
  "static",
  "accent",
  "danger",
  "warning",
  "success",
  "info",
];
