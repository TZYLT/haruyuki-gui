/**
 * Switching an open window to its crash page.
 *
 * Split from `main.ts` so the composition root does not grow a URL parser and a
 * load sequence for a surface that P9 owns. The window is reused, never rebuilt:
 * a second `BrowserWindow` would add a focus lifecycle and load the same bundle
 * again for a user who just lost a process.
 */

import type { BrowserWindow } from "electron";

/** The log sink the composition root passes in; it must never throw. */
export type CrashLog = (event: string, detail?: Record<string, unknown>) => void;

/**
 * The URL that shows a crash page in a window that is already open.
 *
 * It is derived from the page the window is currently showing rather than rebuilt
 * from settings, so the theme, contrast, locale and panel parameters survive the
 * switch. `null` means "do not load": there is no normal page to derive from, or
 * the window already shows a crash route. Reloading a crash page on every new
 * crash is the loop that leaves a window with no way out (`RD-13`).
 *
 * @param window the window to switch, which must already exist
 * @param query the crash query from `crash/page.ts`
 * @param appScheme the shell's privileged scheme, e.g. `app`
 * @returns the URL to load, or `null` when loading would lose or loop
 */
export function crashPageUrl(
  window: BrowserWindow,
  query: string,
  appScheme: string,
): string | null {
  if (window.isDestroyed()) return null;

  let current: URL;

  try {
    current = new URL(window.webContents.getURL());
  } catch {
    // `getURL()` is empty before the first load and after some crashes. The
    // caller cannot derive the boot parameters in that case, so it logs instead
    // of loading a page that would fall back to the default locale and theme.
    return null;
  }

  if (current.protocol !== `${appScheme}:`) return null;
  if (current.searchParams.has("crash")) return null;

  for (const [key, value] of new URLSearchParams(query)) {
    current.searchParams.set(key, value);
  }

  return current.toString();
}

/**
 * Switch an existing window to its crash page.
 *
 * Every outcome is logged -- a crash page that never appeared is exactly the
 * failure the log is for -- and none is thrown, because this runs from crash
 * callbacks where a throw would replace one failure with another.
 *
 * @param window the window to switch
 * @param query the crash query from `crash/page.ts`
 * @param kind which crash page, for the log line
 * @param appScheme the shell's privileged scheme
 * @param log the shell log sink
 * @returns whether the page was loaded
 */
export async function showCrashPage(
  window: BrowserWindow,
  query: string,
  kind: "engine" | "renderer",
  appScheme: string,
  log: CrashLog,
): Promise<boolean> {
  const url = crashPageUrl(window, query, appScheme);

  if (url === null) {
    log("shell.crash.page", {
      state: "skipped",
      kind,
      detail: "no normal page to derive the crash route from, or a crash page is already shown",
    });

    return false;
  }

  try {
    await window.loadURL(url);

    log("shell.crash.page", { state: "shown", kind, url });

    return true;
  } catch (error) {
    log("shell.crash.page.failed", {
      kind,
      detail: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}
