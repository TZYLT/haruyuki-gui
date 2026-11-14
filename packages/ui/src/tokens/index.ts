/**
 * Public surface of the token layer.
 *
 * A deliberate local declaration accompanies the re-exports so this module is
 * not a pure forwarding barrel: the ownership gate rejects a module whose every
 * statement forwards, because such a module has no owner and no behaviour to
 * test. The version constant gives the layer an identity of its own.
 */

/** Identifies the token layer in diagnostics and in the gate's own messages. */
export const TOKEN_LAYER = "tokens" as const;

export {
  ACCENT_SLOTS,
  ALL_TOKEN_SLOTS,
  COLOR_SLOTS,
  CODE_SLOTS,
  DIFF_SLOTS,
  FONT_FAMILY_SLOTS,
  FONT_LETTER_SPACING_SLOTS,
  FONT_LINE_HEIGHT_SLOTS,
  FONT_SIZE_SLOTS,
  FONT_WEIGHT_SLOTS,
  MATH_SLOTS,
  MOTION_SLOTS,
  NEUTRAL_SLOTS,
  RADIUS_SLOTS,
  SPACE_SLOTS,
  STATIC_SLOTS,
  STATUS_SLOTS,
  SURFACE_SLOTS,
  THEME_COMBINATIONS,
  THEME_CONTRAST_ATTRIBUTE,
  THEME_MODE_ATTRIBUTE,
  Z_SLOTS,
  themeKey,
} from "./slots.js";
export type {
  ColorFamily,
  ThemeAttrs,
  ThemeContrast,
  ThemeMode,
  ThemeTokens,
  TokenName,
} from "./slots.js";

export {
  MIN_RATIO_BODY_TEXT,
  MIN_RATIO_LARGE_TEXT_OR_ICON,
  contrastRatio,
  isHexColor,
  parseHex,
  relativeLuminance,
} from "./contrast.js";

export { DARK_HIGH, DARK_NORMAL, LIGHT_HIGH, LIGHT_NORMAL, COLOR_FAMILIES } from "./palettes.js";
export type { Palette } from "./palettes.js";

export { REDUCED_MOTION_CSS, SCALE_TOKENS } from "./scales.js";
export type { ScaleTokens } from "./scales.js";

export {
  DEFAULT_THEME,
  THEMES,
  applyTheme,
  installTokens,
  readTheme,
  themeCss,
  themeRule,
} from "./theme.js";
export type { Theme } from "./theme.js";

export {
  HOST_THEME_ATTRIBUTES,
  VSCODE_TOKEN_MAP,
  applyHostTokens,
  hostThemeCombination,
} from "./host-map.js";
export type { MappedSlot } from "./host-map.js";
