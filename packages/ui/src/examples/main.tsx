/**
 * Browser entry for the sample page.
 *
 * Test scaffolding, not part of the package's API. It exists so a human can look at
 * the components and so the real-browser layout check has something to load.
 *
 * Two query parameters:
 *
 *   ?locale=en|zh-CN          which language to render
 *   ?theme=light/normal       which of the four combinations to apply
 *   &contrast=high            (or spell both: theme=dark&contrast=high)
 *
 * The theme parameters exist because theme approval is a human judgement over four
 * combinations, and a reviewer cannot judge a combination the page offers no way
 * to reach. Reading them here rather than hardcoding `light/normal` is what makes
 * that acceptance criterion executable instead of aspirational.
 */

import { createRoot } from "react-dom/client";

import { applyTheme, type ThemeAttrs } from "../tokens/index.js";
import { SamplePage } from "./SamplePage.js";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("sample page needs a #root element");
}

const params = new URLSearchParams(window.location.search);

/**
 * Read a theme combination from the query string.
 *
 * Accepts both `?theme=dark/high` and `?theme=dark&contrast=high`, because a
 * reviewer typing a URL will try either.
 *
 * @returns the requested combination
 */
function requestedTheme(): ThemeAttrs {
  const theme = params.get("theme") ?? "light/normal";
  const [modePart, contrastPart] = theme.split("/");

  const mode = modePart === "dark" ? "dark" : "light";
  const explicitContrast = params.get("contrast");
  const contrast = explicitContrast === "high" || contrastPart === "high" ? "high" : "normal";

  return { mode, contrast };
}

// Applied before the first render so the page never paints a combination the
// reviewer did not ask for.
applyTheme(requestedTheme());

const requestedLocale = params.get("locale") ?? "en";

createRoot(container).render(<SamplePage locale={requestedLocale} />);
