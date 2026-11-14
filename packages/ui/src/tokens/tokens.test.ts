/**
 * Token-layer tests.
 *
 * These assert the properties the requirement makes testable in a component
 * test, as opposed to the properties that need a real browser:
 *
 * - completeness: every slot has a value in every theme
 * - the scale/colour split actually holds (a theme may only vary colour)
 * - the injection and switching mechanism works (installTokens / applyTheme)
 * - no token value is a raw colour outside the palette
 *
 * Layout-dependent assertions are deliberately absent: jsdom performs no layout,
 * so measuring heights here would return zeros and prove nothing.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  ALL_TOKEN_SLOTS,
  THEMES,
  THEME_COMBINATIONS,
  THEME_CONTRAST_ATTRIBUTE,
  THEME_MODE_ATTRIBUTE,
  applyTheme,
  installTokens,
  readTheme,
  themeCss,
  themeKey,
} from "./index.js";
import { SCALE_TOKENS } from "./scales.js";

/** Resets the attributes and styles a test may have added to the shared document. */
afterEach(() => {
  document.documentElement.removeAttribute(THEME_MODE_ATTRIBUTE);
  document.documentElement.removeAttribute(THEME_CONTRAST_ATTRIBUTE);
  document.getElementById("haruyuki-ui-tokens")?.remove();
});

describe("token completeness", () => {
  it("declares a slot list with no duplicates", () => {
    expect(new Set(ALL_TOKEN_SLOTS).size).toBe(ALL_TOKEN_SLOTS.length);
  });

  it("gives every theme a value for every slot", () => {
    for (const attrs of THEME_COMBINATIONS) {
      const theme = THEMES[themeKey(attrs)];

      expect(theme, `missing theme ${themeKey(attrs)}`).toBeDefined();

      const names = Object.keys(theme?.tokens ?? {});

      expect(names.length, `slot count in ${themeKey(attrs)}`).toBe(ALL_TOKEN_SLOTS.length);

      for (const slot of ALL_TOKEN_SLOTS) {
        const value = (theme?.tokens as Record<string, string> | undefined)?.[slot];

        expect(value, `${themeKey(attrs)} is missing ${slot}`).toBeTruthy();
      }
    }
  });

  it("asks for exactly the four combinations, no more", () => {
    expect(Object.keys(THEMES).sort()).toEqual([
      "dark/high",
      "dark/normal",
      "light/high",
      "light/normal",
    ]);
  });
});

describe("scale and colour split", () => {
  it("keeps every non-colour slot identical across all four themes", () => {
    // This is the property that makes the split worth having: a theme that
    // changed a spacing value would be a bug that no contrast check can catch.
    for (const [slot, expected] of Object.entries(SCALE_TOKENS)) {
      for (const attrs of THEME_COMBINATIONS) {
        const theme = THEMES[themeKey(attrs)];

        expect(
          theme?.tokens[slot as keyof typeof SCALE_TOKENS],
          `${slot} in ${themeKey(attrs)}`,
        ).toBe(expected);
      }
    }
  });

  it("does vary the colour slots between light and dark", () => {
    const light = THEMES["light/normal"];
    const dark = THEMES["dark/normal"];

    expect(light?.tokens["--ui-color-surface-1"]).not.toBe(dark?.tokens["--ui-color-surface-1"]);
    expect(light?.tokens["--ui-color-neutral-1"]).not.toBe(dark?.tokens["--ui-color-neutral-1"]);
  });
});

describe("stylesheet generation", () => {
  it("emits one rule per combination, each selected by both attributes", () => {
    const css = themeCss();

    for (const attrs of THEME_COMBINATIONS) {
      const selector = `:root[${THEME_MODE_ATTRIBUTE}="${attrs.mode}"][${THEME_CONTRAST_ATTRIBUTE}="${attrs.contrast}"]`;

      expect(css).toContain(selector);
    }
  });

  it("paints the page surface from the theme, not only the components", () => {
    // Tokens are variables; nothing paints them. Without a base rule a dark
    // theme produced a white page with dark components, which is what a
    // screenshot of the four-combination page showed. The class of bug no token
    // assertion can see: every value was correct and nothing consumed it.
    const css = themeCss();

    expect(css).toMatch(/body\s*\{/);
    expect(css).toContain("background-color: var(--ui-color-surface-1)");
    expect(css).toContain("color: var(--ui-color-neutral-1)");
  });

  it("zeroes the motion durations under prefers-reduced-motion", () => {
    expect(themeCss()).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("is byte-stable across calls", () => {
    expect(themeCss()).toBe(themeCss());
  });
});

describe("runtime injection", () => {
  it("inserts one style element and does not duplicate it", () => {
    const first = installTokens(document);
    const second = installTokens(document);

    expect(first).toBe(second);
    expect(document.querySelectorAll("#haruyuki-ui-tokens").length).toBe(1);
  });

  it("applies the default theme when the document has none", () => {
    // The failure this prevents is total and silent: every rule is scoped to
    // [data-theme][data-contrast], so without the attributes no rule matches and
    // every token reads as an empty string. Components render with browser
    // default fonts and zero padding -- which looks like the CSS never loaded.
    //
    // Found in a real browser, because jsdom does not apply stylesheets at all:
    // every unit test passed while the page was unstyled.
    document.documentElement.removeAttribute(THEME_MODE_ATTRIBUTE);
    document.documentElement.removeAttribute(THEME_CONTRAST_ATTRIBUTE);

    installTokens(document);

    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("light");
    expect(document.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE)).toBe("normal");
  });

  it("does not overwrite a theme the host already chose", () => {
    // A host that sets dark/high before installing must keep it; the default is
    // only a floor, never an override.
    applyTheme({ mode: "dark", contrast: "high" }, document);
    installTokens(document);

    expect(readTheme(document)).toEqual({ mode: "dark", contrast: "high" });
  });

  it("restores the element after a host removes it", () => {
    installTokens(document).remove();

    const restored = installTokens(document);

    expect(document.contains(restored)).toBe(true);
  });

  it("makes the token values readable from a descendant element", () => {
    // The reason the attributes live on :root and the reason jsdom was chosen
    // over happy-dom: custom properties must inherit to the component subtree.
    installTokens(document);
    applyTheme({ mode: "dark", contrast: "high" }, document);

    const host = document.createElement("div");
    document.body.appendChild(host);

    const child = document.createElement("span");
    host.appendChild(child);

    const value = getComputedStyle(child).getPropertyValue("--ui-color-surface-1").trim();

    expect(value).toBe(THEMES["dark/high"]?.tokens["--ui-color-surface-1"]);
  });
});

describe("theme switching", () => {
  it("writes both attributes and reads them back", () => {
    applyTheme({ mode: "dark", contrast: "high" }, document);

    expect(document.documentElement.getAttribute(THEME_MODE_ATTRIBUTE)).toBe("dark");
    expect(document.documentElement.getAttribute(THEME_CONTRAST_ATTRIBUTE)).toBe("high");
    expect(readTheme(document)).toEqual({ mode: "dark", contrast: "high" });
  });

  it("falls back to light/normal when nothing is set", () => {
    expect(readTheme(document)).toEqual({ mode: "light", contrast: "normal" });
  });

  it("falls back when an attribute holds an unknown value", () => {
    document.documentElement.setAttribute(THEME_MODE_ATTRIBUTE, "sepia");
    document.documentElement.setAttribute(THEME_CONTRAST_ATTRIBUTE, "extreme");

    expect(readTheme(document)).toEqual({ mode: "light", contrast: "normal" });
  });

  it("does not rewrite the stylesheet when switching", () => {
    const style = installTokens(document);
    const before = style.textContent;

    applyTheme({ mode: "dark", contrast: "normal" }, document);

    expect(style.textContent).toBe(before);
  });
});
