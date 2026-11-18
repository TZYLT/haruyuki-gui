/**
 * The about document's entry: mount the page the main process just opened.
 *
 * Split from the page itself so the page can be rendered by a test without
 * mounting a second React root: a test that imported this module would find a
 * `#root`-less document and throw before any assertion ran.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { LocaleProvider, applyTheme, type ThemeAttrs } from "@haruyuki/ui";

import { AboutPage } from "./about-page.js";

/**
 * Read the boot parameters from the loaded URL.
 *
 * `main` puts the theme and the locale in the URL so the first paint is already
 * correct. Both are validated here: a malformed URL must produce the default
 * page, not an exception before the first render.
 */
function bootParams(): { theme: ThemeAttrs; locale: string } {
  const params = new URLSearchParams(window.location.search);

  return {
    theme: {
      mode: params.get("theme") === "dark" ? "dark" : "light",
      contrast: params.get("contrast") === "high" ? "high" : "normal",
    },
    locale: params.get("locale") ?? "en",
  };
}

const container = document.getElementById("root");

if (container === null) {
  throw new Error("the about document needs a #root element");
}

const boot = bootParams();

// Before the first paint, so the window never flashes the wrong theme.
applyTheme(boot.theme);

createRoot(container).render(
  <StrictMode>
    <LocaleProvider locale={boot.locale}>
      <AboutPage />
    </LocaleProvider>
  </StrictMode>,
);
