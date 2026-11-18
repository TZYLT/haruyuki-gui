/**
 * The about window: a second `app://` document, opening facts that are already
 * on this machine.
 *
 * A second window rather than a route in the main one, because the two have
 * different lifetimes: the shell's window is the application, and a user who
 * asks what version they are running should not lose their place in it.
 *
 * Why this file is not part of `main.ts`: that file is the composition root and
 * is at its size gate. Nothing here belongs in the window/bootstrap order either
 * -- the about window is created long after boot, repeatedly, and never at
 * launch.
 *
 * Two things are deliberately *not* done here:
 *
 *   The window is not attached to the bridge's session host. That host tracks
 *   one document at a time (a reload replaces the generation behind it), so
 *   attaching a second window would make the shell's own `bridge.ready` arrive
 *   in a session the about window had taken over. The about page needs `invoke`
 *   only, and `invoke` needs no session.
 *
 *   No `sandbox`/`contextIsolation`/`preload` value is re-decided: the same
 *   three are passed in from the composition root, so a window cannot quietly
 *   become the weaker one. The CSP is the scheme's, not this window's, which is
 *   why nothing here mentions it.
 */

import { BrowserWindow } from "electron";
import path from "node:path";

import { APP_HOST, APP_SCHEME } from "./protocol.js";

/** The about window's width in DIP: one column of label/value rows. */
export const ABOUT_WIDTH = 720;

/** Tall enough for five sections with the update result expanded. */
export const ABOUT_HEIGHT = 680;

/** The only window of this kind; a second click focuses the one that exists. */
let aboutWindow: BrowserWindow | null = null;

/** Where the about document lives, relative to the `app://` allow root. */
export const ABOUT_DOCUMENT = "about.html" as const;

/** Everything the window needs from the composition root. */
export interface AboutWindowDeps {
  /** `__dirname` of the built main bundle: the preload sits beside it. */
  readonly here: string;
  /** The resolved locale, so the window opens in the user's language. */
  readonly locale: string;
  /** The theme attributes the shell is using, for the first paint. */
  readonly theme: string;
  readonly contrast: string;
  /** Whether the inspector may be opened; identical to the shell's answer. */
  readonly devtoolsAllowed: boolean;
  /** Hand an external URL to the browser. */
  readonly openExternal: (url: string) => void;
  /** Report a refused load, so a blank window is not silent. */
  readonly onFailure?: (detail: string) => void;
  /** Test seam: replaces the window factory. */
  readonly createWindow?: (
    options: ConstructorParameters<typeof BrowserWindow>[0],
  ) => BrowserWindow;
}

/**
 * Build the `app://` URL the about document is loaded from.
 *
 * The theme and locale travel in the URL for the same reason the shell's do: a
 * round trip after load paints the default theme first and then corrects it,
 * which is a flash on every open.
 *
 * @param locale the resolved locale
 * @param theme the theme mode
 * @param contrast the contrast level
 * @returns an absolute `app://` URL
 */
export function aboutUrl(locale: string, theme: string, contrast: string): string {
  const params = new URLSearchParams({ theme, contrast, locale });

  return `${APP_SCHEME}://${APP_HOST}/${ABOUT_DOCUMENT}?${params.toString()}`;
}

/**
 * Open the about window, or focus the one that is already open.
 *
 * @param deps the composition root's facts
 * @returns the window, so a caller can await its document if it wants to
 */
export async function openAboutWindow(deps: AboutWindowDeps): Promise<BrowserWindow> {
  if (aboutWindow !== null && !aboutWindow.isDestroyed()) {
    if (aboutWindow.isMinimized()) aboutWindow.restore();

    aboutWindow.focus();

    return aboutWindow;
  }

  const factory =
    deps.createWindow ??
    ((options) => new BrowserWindow(options as ConstructorParameters<typeof BrowserWindow>[0]));

  const window = factory({
    width: ABOUT_WIDTH,
    height: ABOUT_HEIGHT,
    // A read-only surface: shrinking it to nothing would hide the whole page,
    // and there is no editor here that needs the space back.
    minWidth: 560,
    minHeight: 480,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(deps.here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: deps.devtoolsAllowed,
    },
  });

  aboutWindow = window;

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    aboutWindow = null;
  });

  // The two outbound links. `deny` plus `openExternal` is the same arrangement
  // the shell's window uses: a page cannot navigate itself away and leave a
  // window with no way back, and the URL still reaches the user's browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) deps.openExternal(url);
    else deps.onFailure?.(`refused to open a non-https link from the about window (${url})`);

    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) return;

    event.preventDefault();
    if (url.startsWith("https:")) deps.openExternal(url);
  });

  const url = aboutUrl(deps.locale, deps.theme, deps.contrast);

  try {
    await window.loadURL(url);
  } catch (error) {
    deps.onFailure?.(error instanceof Error ? error.message : String(error));
  }

  return window;
}

/** Close the window if one is open. Used by tests and by a future shutdown hook. */
export function closeAboutWindow(): void {
  if (aboutWindow !== null && !aboutWindow.isDestroyed()) aboutWindow.close();

  aboutWindow = null;
}
