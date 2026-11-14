/**
 * Token slots: the semantic contract every theme must satisfy.
 *
 * A slot is a name with a fixed meaning and no fixed value. Themes supply the
 * values; this module supplies the vocabulary. That split is what lets a theme
 * change without touching a component, and what makes a missing value a compile
 * error instead of a silently transparent colour.
 *
 * This contract freezes the **namespaces and semantics**, not the values and not the
 * number of steps inside a family. A family may gain a step; a slot may not
 * change meaning.
 *
 * Every slot is listed literally rather than derived from a range expression so
 * that `TokenName` stays a closed literal union: `--ui-space-13` has to be a
 * type error, not a string that happens to type-check.
 */

/** Colour families. Each is a namespace, not a palette. */
export type ColorFamily =
  "surface" | "neutral" | "static" | "accent" | "danger" | "warning" | "success" | "info";

/**
 * Surface steps. Fixed at three by the requirement: page, panel, overlay.
 *
 * - 1 page background
 * - 2 raised panel (card, sidebar, table header)
 * - 3 floating overlay (popover, menu, dialog)
 */
export const SURFACE_SLOTS = [
  "--ui-color-surface-1",
  "--ui-color-surface-2",
  "--ui-color-surface-3",
] as const;

/**
 * Neutral steps. Three tiers, each with its own accessibility threshold:
 *
 * - 1 primary text (>= 4.5:1 on every surface)
 * - 2 secondary text and icons (>= 4.5:1 as text, which covers the >= 3:1 an
 *   icon needs)
 * - 3 borders and dividers (>= 3:1, the non-text contrast of a component edge)
 */
export const NEUTRAL_SLOTS = [
  "--ui-color-neutral-1",
  "--ui-color-neutral-2",
  "--ui-color-neutral-3",
] as const;

/**
 * Static colours: the two slots that do not follow the **accent hue**.
 *
 * - 1 the foreground to use on a filled control (accent, danger, and the
 *   switch's thumb), so a label stays readable without the control knowing
 *   which theme is active
 * - 2 the inverse of the page, for inverted chips and tooltips
 *
 * `static-1` used to be `#ffffff` in all four themes, on the reasoning that a
 * filled control is always dark enough for white. That is false in the dark
 * themes, where `accent-1` is a *light* blue (`#79aaff`) and `danger-1` a light
 * red: white on either measured 2.33:1 and 1.70:1, well under the 4.5:1 the
 * requirement asks for. It is now the theme's own near-black in the dark themes,
 * which measures 7.91:1 and 11.46:1. The slot still does not follow the accent
 * *hue* -- it is the same label colour whatever the accent becomes -- but it is
 * no longer claimed to be identical across modes, because "identical across
 * modes" was the property that was wrong.
 */
export const STATIC_SLOTS = ["--ui-color-static-1", "--ui-color-static-2"] as const;

/**
 * Overlay colours: the two translucent layers a floating surface needs.
 *
 * - `scrim` the dimmer behind a modal dialog
 * - `shadow` the drop shadow under a popup
 *
 * Both are translucent black in every theme today, but they are slots rather
 * than literals because a literal is invisible to the theme system: the
 * stylesheet previously wrote `rgb(0 0 0 / 12%)` and `rgb(0 0 0 / 40%)` inline,
 * so a high-contrast theme could not strengthen the scrim, and the "colours live
 * only in the palette" rule had an exception nobody had written down. Keeping
 * them here also lets a host map them to its own surface elevation.
 */
export const OVERLAY_SLOTS = ["--ui-color-scrim", "--ui-color-shadow"] as const;

/** Accent steps. 1 is the base, 2 the hover fill, 3 the subtle background. */
export const ACCENT_SLOTS = [
  "--ui-color-accent-1",
  "--ui-color-accent-2",
  "--ui-color-accent-3",
] as const;

/** Each status family has a foreground (1) and a subtle background (2). */
export const STATUS_SLOTS = [
  "--ui-color-danger-1",
  "--ui-color-danger-2",
  "--ui-color-warning-1",
  "--ui-color-warning-2",
  "--ui-color-success-1",
  "--ui-color-success-2",
  "--ui-color-info-1",
  "--ui-color-info-2",
] as const;

/** The complete colour slot list, in family order. */
export const COLOR_SLOTS: readonly string[] = [
  ...SURFACE_SLOTS,
  ...NEUTRAL_SLOTS,
  ...STATIC_SLOTS,
  ...ACCENT_SLOTS,
  ...STATUS_SLOTS,
  ...OVERLAY_SLOTS,
];

/**
 * Spacing steps 0-12, a doubling-ish scale.
 *
 * 0 exists on purpose: `--ui-space-0` is how a rule says "no space" through the
 * token system instead of writing a bare `0`, which keeps the "no numeric
 * literals outside tokens" check simple.
 */
export const SPACE_SLOTS: readonly string[] = [
  "--ui-space-0",
  "--ui-space-1",
  "--ui-space-2",
  "--ui-space-3",
  "--ui-space-4",
  "--ui-space-5",
  "--ui-space-6",
  "--ui-space-7",
  "--ui-space-8",
  "--ui-space-9",
  "--ui-space-10",
  "--ui-space-11",
  "--ui-space-12",
];

/**
 * Font family slots. Three roles, not two: code and terminal both want a
 * monospace stack but not the same one, because a terminal renders box drawing
 * characters and a code block does not.
 */
export const FONT_FAMILY_SLOTS: readonly string[] = [
  "--ui-font-family-body",
  "--ui-font-family-code",
  "--ui-font-family-terminal",
];

/** Six size steps. */
export const FONT_SIZE_SLOTS: readonly string[] = [
  "--ui-font-size-1",
  "--ui-font-size-2",
  "--ui-font-size-3",
  "--ui-font-size-4",
  "--ui-font-size-5",
  "--ui-font-size-6",
];

/** Four weights. */
export const FONT_WEIGHT_SLOTS: readonly string[] = [
  "--ui-font-weight-1",
  "--ui-font-weight-2",
  "--ui-font-weight-3",
  "--ui-font-weight-4",
];

/**
 * Three line heights.
 *
 * These are unitless multipliers on purpose. A unitless line-height resolves
 * against the element's own font-size, so `zh` and `en` controls at the same
 * font-size get the same computed height. The alternative -- leaving line-height
 * at `normal` -- resolves against font metrics, which differ per script and made
 * the same button 29 px tall in Chinese and 27 px in English. Controls consume
 * step 2.
 */
export const FONT_LINE_HEIGHT_SLOTS: readonly string[] = [
  "--ui-font-lineHeight-1",
  "--ui-font-lineHeight-2",
  "--ui-font-lineHeight-3",
];

/** Letter spacing: normal and tight. */
export const FONT_LETTER_SPACING_SLOTS: readonly string[] = [
  "--ui-font-letterSpacing-1",
  "--ui-font-letterSpacing-2",
];

/** Three radii: inline, control, container. */
export const RADIUS_SLOTS: readonly string[] = ["--ui-radius-1", "--ui-radius-2", "--ui-radius-3"];

/** Stacking order. The only place a z-index may come from. */
export const Z_SLOTS: readonly string[] = [
  "--ui-z-base",
  "--ui-z-dropdown",
  "--ui-z-overlay",
  "--ui-z-toast",
  "--ui-z-tooltip",
];
/** Three durations and two easings. */
export const MOTION_SLOTS: readonly string[] = [
  "--ui-motion-duration-1",
  "--ui-motion-duration-2",
  "--ui-motion-duration-3",
  "--ui-motion-easing-1",
  "--ui-motion-easing-2",
];

/** Code block surface, consumed by the rendering item. */
export const CODE_SLOTS: readonly string[] = [
  "--ui-code-fg",
  "--ui-code-bg",
  "--ui-code-lineNumber",
  "--ui-code-selection",
  "--ui-code-border",
];

/** Math formula surface, consumed by the rendering item. */
export const MATH_SLOTS: readonly string[] = ["--ui-math-fg", "--ui-math-error", "--ui-math-bg"];

/** Diff surface, consumed by the rendering item. */
export const DIFF_SLOTS: readonly string[] = [
  "--ui-diff-add",
  "--ui-diff-remove",
  "--ui-diff-unchanged",
  "--ui-diff-inlineAdd",
  "--ui-diff-inlineRemove",
  "--ui-diff-bg",
];

/**
 * Every literal slot name this package knows about.
 *
 * Written out as a union rather than as `` `--ui-color-${string}` `` so that a
 * typo is a type error. A theme record typed as `ThemeTokens` therefore cannot
 * silently omit a slot or invent one.
 */
export type TokenName =
  | (typeof SURFACE_SLOTS)[number]
  | (typeof NEUTRAL_SLOTS)[number]
  | (typeof STATIC_SLOTS)[number]
  | (typeof ACCENT_SLOTS)[number]
  | (typeof STATUS_SLOTS)[number]
  | (typeof OVERLAY_SLOTS)[number]
  | (typeof SPACE_SLOTS)[number]
  | (typeof FONT_FAMILY_SLOTS)[number]
  | (typeof FONT_SIZE_SLOTS)[number]
  | (typeof FONT_WEIGHT_SLOTS)[number]
  | (typeof FONT_LINE_HEIGHT_SLOTS)[number]
  | (typeof FONT_LETTER_SPACING_SLOTS)[number]
  | (typeof RADIUS_SLOTS)[number]
  | (typeof Z_SLOTS)[number]
  | (typeof MOTION_SLOTS)[number]
  | (typeof CODE_SLOTS)[number]
  | (typeof MATH_SLOTS)[number]
  | (typeof DIFF_SLOTS)[number];

/** A complete set of values for one theme combination. */
export type ThemeTokens = Record<TokenName, string>;

/**
 * The ordered slot inventory, for gates and tests that need to enumerate.
 *
 * Colour slots are `string[]` above (spreading literal arrays widens them), so
 * this list is the authority for *completeness* and `TokenName` is the authority
 * for *membership*. The test asserts the two agree.
 */
export const ALL_TOKEN_SLOTS: readonly string[] = [
  ...COLOR_SLOTS,
  ...SPACE_SLOTS,  ...FONT_FAMILY_SLOTS,
  ...FONT_SIZE_SLOTS,
  ...FONT_WEIGHT_SLOTS,
  ...FONT_LINE_HEIGHT_SLOTS,
  ...FONT_LETTER_SPACING_SLOTS,
  ...RADIUS_SLOTS,
  ...Z_SLOTS,
  ...MOTION_SLOTS,
  ...CODE_SLOTS,
  ...MATH_SLOTS,
  ...DIFF_SLOTS,
];

/** Theme dimensions. Two orthogonal axes, four combinations. */
export type ThemeMode = "light" | "dark";

/** Contrast axis. `high` raises every contrast pair, it does not change hues. */
export type ThemeContrast = "normal" | "high";

/** One point in the 2x2 theme grid. */
export interface ThemeAttrs {
  mode: ThemeMode;
  contrast: ThemeContrast;
}

/**
 * The attribute names that select a theme.
 *
 * Both attributes live on `<html>`. They are plain `data-` attributes rather
 * than classes because a class name is a shared namespace that a component
 * library or a host page can collide with, and because an attribute selector
 * keeps the specificity low enough to override.
 */
export const THEME_MODE_ATTRIBUTE = "data-theme";

/** The contrast attribute, paired with {@link THEME_MODE_ATTRIBUTE}. */
export const THEME_CONTRAST_ATTRIBUTE = "data-contrast";

/** All four combinations, in a stable order for enumeration. */
export const THEME_COMBINATIONS: readonly ThemeAttrs[] = [
  { mode: "light", contrast: "normal" },
  { mode: "light", contrast: "high" },
  { mode: "dark", contrast: "normal" },
  { mode: "dark", contrast: "high" },
];

/**
 * @param attrs theme combination
 * @returns stable key such as `light/normal`
 */
export function themeKey(attrs: ThemeAttrs): string {
  return `${attrs.mode}/${attrs.contrast}`;
}
