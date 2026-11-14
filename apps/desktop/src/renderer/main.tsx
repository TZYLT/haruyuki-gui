/**
 * The renderer entry.
 *
 * Mounts the sample page, applying the theme and locale the main process resolved.
 *
 * Why this is the sample page and not a real shell surface: D1's job is the shell, and
 * the requirement says so explicitly (`D1-Q01`). What has to be proven is that a page
 * built from `packages/ui` renders inside the sandboxed renderer under the real CSP.
 * The sample page is the fixture for that proof; it is replaced when E1 builds the
 * page framework, not by D1 growing a second one.
 *
 * Both values arrive in the URL the main process loaded, rather than being read here.
 * The renderer has no `process` (sandboxed, `contextIsolation: true`) and no access to
 * the settings file, so a renderer that decided its own theme would be a second source
 * of truth for a value the main process also needs for the window's background.
 */

import { StrictMode, useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import { LocaleProvider, applyTheme, type ThemeAttrs } from "@haruyuki/ui";
import { SamplePage } from "@haruyuki/ui/examples";

/**
 * What the preload exposes.
 *
 * Declared rather than imported: the preload is plain JavaScript with no module graph
 * the renderer can see, and `apps/desktop` deliberately does not depend on Electron's
 * types from the renderer side. Only the members the renderer uses are named.
 */
interface ShellBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
}

declare global {
  interface Window {
    /** The preload's exposed surface. Absent if the preload failed to load. */
    haruyuki?: ShellBridge;
  }
}

/**
 * Read the boot parameters from the loaded URL.
 *
 * A query string rather than an injected `<script>`: the CSP forbids inline script, and
 * a preload-injected global would make the renderer depend on the bridge for something
 * as basic as which theme to paint -- so a preload regression would blank the page
 * instead of only disabling IPC.
 *
 * Every value is validated here. The URL is not secret, and a malformed one must
 * produce the default page rather than an exception before the first render.
 */
function bootPayload(): { theme: ThemeAttrs; locale: string } {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("theme") === "dark" ? "dark" : "light";
  const contrast = params.get("contrast") === "high" ? "high" : "normal";
  const requested = params.get("locale");

  return {
    theme: { mode, contrast },
    locale: requested !== null && requested !== "" ? requested : "en",
  };
}

const container = document.getElementById("root");

if (container === null) {
  throw new Error("the renderer document needs a #root element");
}

const boot = bootPayload();

// Before the first paint, so the page never flashes the wrong theme.
applyTheme(boot.theme);

/**
 * The mounted shell.
 *
 * @returns the sample page inside its providers
 */
function Shell(): ReactElement {
  const [locale] = useState(boot.locale);

  // The document's own `lang` follows the resolved locale: a screen reader picks its
  // voice from this attribute, and a page that says `en` while showing Chinese is read
  // aloud in the wrong language.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <LocaleProvider locale={locale}>
      <SamplePage locale={locale} />
    </LocaleProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
