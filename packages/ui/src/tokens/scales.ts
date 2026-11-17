/**
 * Theme-independent scales.
 *
 * Spacing, typography metrics, radii, stacking order and motion do not change
 * between light and dark, or between normal and high contrast. Only colour does.
 * Splitting them out means a theme is a palette plus these scales, so a missing
 * colour is the only thing a theme can get wrong.
 *
 * Units are spelled out rather than left implicit: `4px` states the unit at the
 * point of definition, and a consumer that does `calc(var(--x) * 2)` does not
 * have to know whether the token was unitless.
 */

import type { TokenName } from "./slots.js";

/** Values for the slots whose meaning does not depend on the theme. */
export type ScaleTokens = Record<
  Exclude<
    TokenName,
    | `--ui-color-${string}`
    | "--ui-code-fg"
    | "--ui-code-bg"
    | "--ui-code-lineNumber"
    | "--ui-code-selection"
    | "--ui-code-border"
    | "--ui-math-fg"
    | "--ui-math-error"
    | "--ui-math-bg"
    | "--ui-diff-add"
    | "--ui-diff-remove"
    | "--ui-diff-unchanged"
    | "--ui-diff-inlineAdd"
    | "--ui-diff-inlineRemove"
    | "--ui-diff-bg"
    | "--ui-terminal-ansi-black"
    | "--ui-terminal-ansi-red"
    | "--ui-terminal-ansi-green"
    | "--ui-terminal-ansi-yellow"
    | "--ui-terminal-ansi-blue"
    | "--ui-terminal-ansi-magenta"
    | "--ui-terminal-ansi-cyan"
    | "--ui-terminal-ansi-white"
    | "--ui-terminal-ansi-brightBlack"
    | "--ui-terminal-ansi-brightRed"
    | "--ui-terminal-ansi-brightGreen"
    | "--ui-terminal-ansi-brightYellow"
    | "--ui-terminal-ansi-brightBlue"
    | "--ui-terminal-ansi-brightMagenta"
    | "--ui-terminal-ansi-brightCyan"
    | "--ui-terminal-ansi-brightWhite"
  >,
  string
>;

/**
 * Spacing steps. A 2px base doubling to a 64px ceiling.
 *
 * Step 0 exists so a rule can say "no space" through a token instead of a bare
 * literal, which keeps the "no numeric literals in spacing" rule free of
 * exceptions.
 */
const SPACE: ScaleTokens = {
  "--ui-space-0": "0px",
  "--ui-space-1": "2px",
  "--ui-space-2": "4px",
  "--ui-space-3": "6px",
  "--ui-space-4": "8px",
  "--ui-space-5": "12px",
  "--ui-space-6": "16px",
  "--ui-space-7": "20px",
  "--ui-space-8": "24px",
  "--ui-space-9": "32px",
  "--ui-space-10": "40px",
  "--ui-space-11": "48px",
  "--ui-space-12": "64px",
};

/**
 * Font stacks.
 *
 * These name system fonts only. No webfont is bundled: the requirement rules it
 * out because a CJK webfont costs megabytes, and the platform already ships
 * high-quality faces. Every stack ends in a generic family so a host without any
 * of the named faces still gets sane metrics rather than a fallback surprise.
 *
 * `code` and `terminal` are separate roles even though both are monospace: a
 * terminal renders box-drawing characters and wants a font that covers them,
 * while a code block does not.
 */
const FONT_FAMILY: ScaleTokens = {
  "--ui-font-family-body":
    'system-ui, -apple-system, "Segoe UI", "Noto Sans", "Helvetica Neue", Arial, sans-serif',
  "--ui-font-family-code":
    '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, "Courier New", monospace',
  "--ui-font-family-terminal":
    '"Cascadia Mono", "DejaVu Sans Mono", Consolas, "Liberation Mono", monospace',
};

/** Six size steps, from caption to page title. */
const FONT_SIZE: ScaleTokens = {
  "--ui-font-size-1": "12px",
  "--ui-font-size-2": "13px",
  "--ui-font-size-3": "14px",
  "--ui-font-size-4": "16px",
  "--ui-font-size-5": "20px",
  "--ui-font-size-6": "24px",
};

/** Four weights. Names are not used because numeric weights compose in `calc`. */
const FONT_WEIGHT: ScaleTokens = {
  "--ui-font-weight-1": "400",
  "--ui-font-weight-2": "500",
  "--ui-font-weight-3": "600",
  "--ui-font-weight-4": "700",
};

/**
 * Line heights are **unitless multipliers**, deliberately.
 *
 * A unitless value resolves against the element's own font-size, so identical
 * font sizes produce identical line boxes regardless of script. A fixed length
 * would too, but it would also stop scaling with the text size. Leaving
 * line-height at `normal` is the case that must be avoided: it resolves against
 * font metrics, and a Chinese and an English face at the same font-size produce
 * different line boxes -- measured as 29px vs 27px on the same button. Controls
 * consume step 2.
 */
const FONT_LINE_HEIGHT: ScaleTokens = {
  "--ui-font-lineHeight-1": "1.25",
  "--ui-font-lineHeight-2": "1.5",
  "--ui-font-lineHeight-3": "1.75",
};

/** Two letter-spacing steps: none, and a slight open-up for all-caps labels. */
const FONT_LETTER_SPACING: ScaleTokens = {
  "--ui-font-letterSpacing-1": "0",
  "--ui-font-letterSpacing-2": "0.02em",
};

/** Three radii: inline chip, control, container. */
const RADIUS: ScaleTokens = {
  "--ui-radius-1": "4px",
  "--ui-radius-2": "6px",
  "--ui-radius-3": "10px",
};

/**
 * Stacking order. Nothing outside this scale may set a z-index.
 *
 * The gaps are wide on purpose: a host page or a third-party popover can sit
 * between two of our layers without a collision.
 *
 * `dropdown` sits **above** `overlay` rather than below it. The intuitive order
 * -- a dropdown inside a dialog should be under the next overlay -- is wrong for
 * the way both are built here: every floating surface is portalled to the
 * document body, so a select inside a dialog and the dialog itself are siblings,
 * and only their z-index decides which is on top. Measured in Edge: a select
 * opened inside a dialog rendered at 1000 under a dialog at 1100, so its list
 * appeared *behind* the dialog it belonged to and could not be clicked. Nesting
 * does not help because the portals are flat, so the scale has to encode "a
 * transient popup outranks the surface that spawned it".
 */
const Z: ScaleTokens = {
  "--ui-z-base": "0",
  "--ui-z-dropdown": "1150",
  "--ui-z-overlay": "1100",
  "--ui-z-toast": "1200",
  "--ui-z-tooltip": "1300",
};

/** Three durations and two easings. */
const MOTION: ScaleTokens = {
  "--ui-motion-duration-1": "100ms",
  "--ui-motion-duration-2": "160ms",
  "--ui-motion-duration-3": "240ms",
  "--ui-motion-easing-1": "cubic-bezier(0.2, 0, 0.2, 1)",
  "--ui-motion-easing-2": "cubic-bezier(0.4, 0, 1, 1)",
};

/** The complete theme-independent scale set. */
export const SCALE_TOKENS: ScaleTokens = {
  ...SPACE,
  ...FONT_FAMILY,
  ...FONT_SIZE,
  ...FONT_WEIGHT,
  ...FONT_LINE_HEIGHT,
  ...FONT_LETTER_SPACING,
  ...RADIUS,
  ...Z,
  ...MOTION,
};

/**
 * Durations are zeroed when the user asks for reduced motion.
 *
 * This is emitted as a CSS media query rather than read in JavaScript so it also
 * applies to a stylesheet a host replaces at build time, and so it cannot be
 * missed by a component that never runs the setter.
 */
export const REDUCED_MOTION_CSS = `@media (prefers-reduced-motion: reduce) {
  :root {
    --ui-motion-duration-1: 0ms;
    --ui-motion-duration-2: 0ms;
    --ui-motion-duration-3: 0ms;
  }
}`;
