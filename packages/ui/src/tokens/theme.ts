/**
 * Assembling a theme into CSS text, and the runtime injection that applies it.
 *
 * The output is a plain string, not a `?raw` CSS import and not a bundler
 * plugin. Two measured facts forced that choice:
 *
 * - `?inline` / `?raw` return an empty string under the default vitest config, so
 *   a test that asserts on token values would silently assert on nothing;
 * - the package ships TypeScript source with no bundler (the requirement rules
 *   one out), so anything that depends on a CSS loader is unusable downstream
 *   until the consuming app picks a bundler.
 *
 * A string works in jsdom, in a real browser and in a downstream static
 * stylesheet -- the host can serialise `themeCss()` to a file at build time if it
 * prefers, and the slot semantics do not change.
 */

import { SCALE_TOKENS, REDUCED_MOTION_CSS } from "./scales.js";
import { DARK_HIGH, DARK_NORMAL, LIGHT_HIGH, LIGHT_NORMAL, type Palette } from "./palettes.js";
import {
  THEME_CONTRAST_ATTRIBUTE,
  THEME_MODE_ATTRIBUTE,
  type ThemeAttrs,
  type TokenName,
  themeKey,
} from "./slots.js";

/** One theme: its palette plus the shared scales. */
export interface Theme {
  attrs: ThemeAttrs;
  tokens: Record<TokenName, string>;
}

/**
 * The four themes, keyed `mode/contrast`.
 *
 * Built by spreading the shared scales into each palette, so a theme can only be
 * wrong about colour: the scales are the same object values in all four.
 *
 * @returns all four themes
 */
function buildThemes(): Record<string, Theme> {
  /**
   * @param palette colour values
   * @param attrs theme combination
   * @returns the assembled theme
   */
  function assemble(palette: Palette, attrs: ThemeAttrs): Theme {
    return {
      attrs,
      tokens: { ...SCALE_TOKENS, ...palette } as Record<TokenName, string>,
    };
  }

  return {
    [themeKey({ mode: "light", contrast: "normal" })]: assemble(LIGHT_NORMAL, {
      mode: "light",
      contrast: "normal",
    }),
    [themeKey({ mode: "light", contrast: "high" })]: assemble(LIGHT_HIGH, {
      mode: "light",
      contrast: "high",
    }),
    [themeKey({ mode: "dark", contrast: "normal" })]: assemble(DARK_NORMAL, {
      mode: "dark",
      contrast: "normal",
    }),
    [themeKey({ mode: "dark", contrast: "high" })]: assemble(DARK_HIGH, {
      mode: "dark",
      contrast: "high",
    }),
  };
}

/** All four themes, keyed by `themeKey()`. */
export const THEMES: Readonly<Record<string, Theme>> = buildThemes();

/**
 * The default theme.
 *
 * Light/normal rather than following `prefers-color-scheme`: the host decides,
 * because the host owns the window chrome and follows the OS itself. A renderer
 * package guessing from a media query would disagree with its own shell.
 */
export const DEFAULT_THEME: ThemeAttrs = { mode: "light", contrast: "normal" };

/**
 * Render one theme as a CSS rule.
 *
 * The selector is the two attributes on `:root`. Both are required, so a tree
 * that sets only one gets no theme at all rather than a half-applied one -- a
 * loud failure in the form of unstyled content, which is easier to notice than a
 * silently wrong colour.
 *
 * @param theme theme to render
 * @returns a CSS rule
 */
export function themeRule(theme: Theme): string {
  const selector =
    `:root[${THEME_MODE_ATTRIBUTE}="${theme.attrs.mode}"]` +
    `[${THEME_CONTRAST_ATTRIBUTE}="${theme.attrs.contrast}"]`;

  const declarations = Object.entries(theme.tokens)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");

  return `${selector} {\n${declarations}\n}`;
}

/**
 * Base rules that make a theme actually visible.
 *
 * Tokens on their own only define variables. Nothing paints them, so a document
 * with `data-theme="dark"` and no base rule keeps a white page with dark
 * components -- which is what a screenshot of the four-combination page showed:
 * the *components* switched and the page did not, because `body` has a default
 * background from the user agent and none of our rules touched it.
 *
 * This is the minimum needed for a combination to be usable: the page surface, the
 * text colour, and the font. Everything else stays with the components, so a host
 * that wants its own page chrome can override these two rules and lose nothing.
 */
const BASE_CSS = `
body {
  margin: 0;
  background-color: var(--ui-color-surface-1);
  color: var(--ui-color-neutral-1);
  font-family: var(--ui-font-family-body);
  /* Unitless so line height follows each element's own font size, which is what
     makes the same control the same height in Chinese and in English. */
  line-height: var(--ui-font-lineHeight-2);
}
`;

/**
 * Render all four themes plus the reduced-motion override as one stylesheet.
 *
 * Sorted by theme key so the output is byte-stable: a snapshot test can then
 * detect an accidental palette edit, which a hash-ordered object would hide.
 *
 * @returns CSS text
 */
export function themeCss(): string {
  const rules = Object.keys(THEMES)
    .sort()
    .map((key) => {
      const theme = THEMES[key];

      if (theme === undefined) {
        throw new Error(`theme missing for key ${key}`);
      }

      return themeRule(theme);
    });

  // Base rules first: they read the variables, so they must come after the
  // declarations in cascade order at equal specificity -- and a `body` rule is
  // less specific than anything scoped to `:root`, so order does not matter for
  // correctness, only for readability.
  return [BASE_CSS, ...rules, REDUCED_MOTION_CSS].join("\n\n");
}

/** Marks the style element this module owns, so injection stays idempotent. */
const STYLE_ELEMENT_ID = "haruyuki-ui-tokens";

/**
 * Insert the token stylesheet into a document, once.
 *
 * Idempotent by id: calling it twice must not append a second copy, because a
 * duplicate sheet doubles every declaration and makes the cascade order between
 * the two copies undefined. Re-calling after the host removed the element
 * restores it, which is why the check is for the element rather than a boolean.
 *
 * @param doc target document, defaults to the ambient one
 * @returns the style element that holds the tokens
 */
export function installTokens(doc?: Document): HTMLStyleElement {
  const target = doc ?? globalThis.document;

  if (target === undefined) {
    throw new Error("installTokens needs a Document; none was passed and none is ambient");
  }

  const existing = target.getElementById(STYLE_ELEMENT_ID);

  if (existing !== null) {
    return existing as HTMLStyleElement;
  }

  const style = target.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = themeCss();
  target.head.appendChild(style);

  // Apply the default combination when the document does not already carry one.
  //
  // Without this the sheet installs but resolves to nothing: every rule is scoped
  // to `[data-theme][data-contrast]`, so a document with neither attribute matches
  // no rule and every token reads as an empty string. The failure is silent and
  // total -- components render with browser default fonts and zero padding, which
  // looks like "the CSS was never loaded" rather than "one attribute is missing".
  // Found in a real browser; jsdom cannot see it because it does not apply
  // stylesheets at all.
  //
  // A host that wants a different theme calls `applyTheme` afterwards, which
  // overwrites these; a host that wants none of this can remove the attributes.
  if (
    !target.documentElement.hasAttribute(THEME_MODE_ATTRIBUTE) &&
    !target.documentElement.hasAttribute(THEME_CONTRAST_ATTRIBUTE)
  ) {
    applyTheme(DEFAULT_THEME, target);
  }

  return style;
}

/**
 * Select a theme by setting the two attributes on the document root.
 *
 * Switching does not rewrite the stylesheet: all four rules are already present
 * and the attribute selector picks one. That keeps a theme change to two
 * attribute writes, which is cheap enough to do on a keystroke and cannot leave
 * a half-written sheet behind.
 *
 * @param attrs theme to activate
 * @param doc target document, defaults to the ambient one
 */
export function applyTheme(attrs: ThemeAttrs, doc?: Document): void {
  const target = doc ?? globalThis.document;

  if (target === undefined) {
    throw new Error("applyTheme needs a Document; none was passed and none is ambient");
  }

  const root = target.documentElement;
  root.setAttribute(THEME_MODE_ATTRIBUTE, attrs.mode);
  root.setAttribute(THEME_CONTRAST_ATTRIBUTE, attrs.contrast);
}

/**
 * Read the theme currently applied to a document.
 *
 * Falls back to {@link DEFAULT_THEME} when an attribute is missing or holds an
 * unknown value, so a host that never calls `applyTheme` still renders in a
 * defined theme instead of an unstyled tree.
 *
 * @param doc target document, defaults to the ambient one
 * @returns the active theme combination
 */
export function readTheme(doc?: Document): ThemeAttrs {
  const target = doc ?? globalThis.document;

  if (target === undefined) {
    return DEFAULT_THEME;
  }

  const mode = target.documentElement.getAttribute(THEME_MODE_ATTRIBUTE);
  const contrast = target.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE);

  return {
    mode: mode === "dark" ? "dark" : "light",
    contrast: contrast === "high" ? "high" : "normal",
  };
}
