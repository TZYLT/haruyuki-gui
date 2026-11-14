/**
 * The shell's entry point: one window, one instance, one protocol.
 *
 * The order of operations in `main()` is the whole design, because several of these
 * steps are only legal before `app.ready` and the rest are only legal after:
 *
 *   1. `registerSchemesAsPrivileged` -- MUST be before ready. Registering a scheme
 *      after ready is silently ignored when `standard: true`, and the failure looks
 *      like a CSP problem rather than a registration one.
 *   2. The single-instance lock -- before creating a window, so the second process
 *      exits without ever building one.
 *   3. `app.whenReady()`.
 *   4. `protocol.handle` -- after ready.
 *   5. The window.
 *
 * Three things this file deliberately does not do:
 *
 *   It does not read `process.env` for anything but the two documented escape
 *   hatches. A shell that behaves differently because of an inherited variable is a
 *   shell whose behaviour nobody can reproduce from a bug report.
 *
 *   It does not create a second window type. D1 has one window; a settings window or
 *   a devtools window is a later item's concern, and inventing the abstraction now
 *   would be guessing at its shape.
 *
 *   It does not handle errors by showing a dialog. `bootstrap-error.ts` renders a
 *   page; a modal at launch is a modal the user has to dismiss before they can read
 *   the log path.
 */

import { app, BrowserWindow, Menu, protocol, session, shell } from "electron";
import path from "node:path";

import { bootstrapErrorHtml } from "./bootstrap-error.js";
import { APP_HOST, APP_SCHEME, APP_PRIVILEGES, createProtocolHandler } from "./protocol.js";
import { CSP, headersFor, shouldApplyFallbackCsp } from "./csp.js";
import { APP_NAME, chooseLocale } from "./i18n.js";
import { buildMenuTemplate } from "./menu.js";
import { createLogger, type Logger } from "./log.js";
import {
  DEFAULT_SETTINGS,
  isWindowVisible,
  parseSettings,
  serializeSettings,
  settingsPath,
  type ShellSettings,
} from "./settings.js";

/** The escape hatch that lets a packaged build open the inspector. */
const DEVTOOLS_ENV = "HARUYUKI_DEVTOOLS";

/** The initial window size on a first launch, in DIP. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;

/** Set once, after the instance lock is won. */
let logger: Logger | null = null;

/** The one window. Held so the activate handler can focus rather than rebuild. */
let mainWindow: BrowserWindow | null = null;

/** Parsed settings, loaded once and kept in step with the window. */
let settings: ShellSettings = DEFAULT_SETTINGS;

/**
 * Report a failure that happened before the window could show a page.
 *
 * Writes to the log and exits with the platform's failure code. The alternative --
 * an unhandled rejection -- leaves a process with no window and no message.
 *
 * @param event short stable identifier
 * @param detail human-readable detail
 */
function failBoot(event: string, detail: string): never {
  const logPath = logger === null ? undefined : path.join(app.getPath("logs"), "");

  logger?.error(event, { detail });

  // No window exists yet, so there is nothing to render into. Stderr is what a
  // developer running from a terminal sees, and the log file is what a user can
  // attach. Both, because they are read by different people.
  process.stderr.write(`[haruyuki] ${event}: ${detail}\n`);

  if (logPath !== undefined) process.stderr.write(`[haruyuki] log: ${logPath}\n`);

  app.exit(1);

  // `app.exit` does not return, but TypeScript cannot know that.
  throw new Error(detail);
}

/** Whether the inspector may be opened in this run. */
function devtoolsAllowed(): boolean {
  return process.env[DEVTOOLS_ENV] === "1";
}

/**
 * Load the settings file.
 *
 * A missing file is a first launch, not an error. A file that cannot be *read* is
 * also not fatal: the defaults are correct, and refusing to start because a settings
 * file is locked by another process would be a worse failure than forgetting the
 * window position.
 */
async function loadSettings(): Promise<ShellSettings> {
  const { readFile } = await import("node:fs/promises");
  const file = settingsPath(app.getPath("userData"));

  try {
    const raw = await readFile(file, "utf8");
    const parsed = parseSettings(raw);

    logger?.info("settings.loaded", { file, theme: parsed.theme, locale: parsed.locale });

    return parsed;
  } catch {
    logger?.info("settings.first-launch", { file });

    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the settings. Failures are logged, never surfaced: a settings file that
 * cannot be written must not close the window the user is working in. */
async function saveSettings(next: ShellSettings): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  const file = settingsPath(app.getPath("userData"));

  try {
    await writeFile(file, serializeSettings(next), "utf8");
  } catch (error) {
    logger?.warn("settings.write-failed", { detail: String(error) });
  }
}

/**
 * Capture the window's geometry into `settings` and persist.
 *
 * Saved on `close`, not on every `move`/`resize`: a drag fires dozens of events and
 * only the last position matters. Reading the *normal* bounds rather than the current
 * ones means a maximised window restores to the rectangle the user had before
 * maximising, which is what they expect.
 *
 * @param window the window to read
 */
function rememberGeometry(window: BrowserWindow): void {
  if (window.isMinimized()) return;

  const maximized = window.isMaximized();
  const bounds = maximized ? window.getNormalBounds() : window.getBounds();

  settings = { ...settings, window: { ...bounds, maximized } };
}

/**
 * Create the window and load the shell.
 *
 * @param allowedDevtools whether the inspector may be opened
 * @param locale the resolved locale, needed for the boot parameters
 */
async function createWindow(allowedDevtools: boolean, locale: string): Promise<BrowserWindow> {
  const restored = settings.window;
  const displays = await import("electron").then(({ screen }) =>
    screen.getAllDisplays().map((display) => display.workArea),
  );

  // A persisted rectangle is a fact about a display layout that may no longer exist.
  // Restoring an unreachable one gives the user a window they cannot find.
  const usable = restored !== null && isWindowVisible(restored, displays);

  if (restored !== null && !usable) {
    logger?.warn("window.restore.refused", {
      detail: "the saved rectangle is not on any current display",
      width: restored.width,
      height: restored.height,
    });
  }

  const window = new BrowserWindow({
    width: usable ? restored.width : DEFAULT_WIDTH,
    height: usable ? restored.height : DEFAULT_HEIGHT,
    // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the same
    // as an omitted key. Spreading a conditional is how the position is left out
    // entirely on a first launch, which lets the platform centre the window.
    ...(usable ? { x: restored.x, y: restored.y } : {}),
    // Show only when the page is painted: a window that appears white and fills in
    // is the single most common complaint about Electron shells.
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      // The preload is the only bridge. `nodeIntegration: false` plus `sandbox: true`
      // is what makes the three-member shape the whole attack surface.
      preload: path.join(import.meta.dirname, "../preload/preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The shell never uses a `<webview>`, and enabling the tag without a reason is
      // how a page gets a second, weaker renderer inside it.
      webviewTag: false,
      // Devtools are gated on the same condition as the menu item, so there is one
      // answer to "can the user inspect this build".
      devTools: allowedDevtools,
    },
  });

  if (usable) window.setBounds(restored);
  if (usable && restored.maximized) window.maximize();

  window.once("ready-to-show", () => window.show());

  window.on("close", () => {
    rememberGeometry(window);
    void saveSettings(settings);
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  // External links go to the user's browser. Without this an `https://` link in
  // rendered content would navigate the shell itself away from the app, leaving a
  // window with no UI and no way back.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  // Same reasoning for a same-window navigation the app did not ask for.
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) {
      event.preventDefault();

      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    }
  });

  // The theme and locale travel in the URL so the renderer can paint correctly on its
  // first frame. The alternative -- an IPC round trip after load -- paints the default
  // theme first and then corrects it, which is the flash this arrangement avoids.
  const params = new URLSearchParams({
    theme: settings.theme,
    contrast: settings.contrast,
    locale,
  });

  await window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html?${params.toString()}`);

  return window;
}

/**
 * Build and start the shell.
 *
 * Everything above this function is a pure helper; this is the only place with side
 * effects that matter to the process.
 */
async function main(): Promise<void> {
  const userData = app.getPath("userData");

  logger = createLogger({ logDir: app.getPath("logs"), minLevel: "info" });
  logger.info("shell.boot", {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
  });

  // Before ready, and before anything reads the protocol.
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { ...APP_PRIVILEGES } }]);

  // A second launch focuses the existing window instead of building a second one.
  // Without this, two shells share one settings file and overwrite each other.
  const isPrimary = app.requestSingleInstanceLock();

  if (!isPrimary) {
    logger.info("shell.second-instance");

    app.quit();

    return;
  }

  app.on("second-instance", () => {
    if (mainWindow === null) return;

    if (mainWindow.isMinimized()) mainWindow.restore();

    mainWindow.focus();
  });

  await app.whenReady();

  const allowRoot = path.join(import.meta.dirname, "../renderer");

  protocol.handle(APP_SCHEME, createProtocolHandler({ allowRoot, headersFor }));

  // The fallback. `protocol.handle` already sets the policy on its own responses;
  // this catches anything the session loads that did not come through the handler.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!shouldApplyFallbackCsp(details.url)) {
      callback({ responseHeaders: details.responseHeaders ?? {} });

      return;
    }

    const headers = { ...details.responseHeaders };
    const existingKey = Object.keys(headers).find(
      (key) => key.toLowerCase() === "content-security-policy",
    );

    if (existingKey === undefined) {
      headers["Content-Security-Policy"] = [CSP];
    }

    callback({ responseHeaders: headers });
  });

  settings = await loadSettings();

  const locale = chooseLocale(settings.locale, app.getLocale());

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        isDevelopment: !app.isPackaged,
        devtoolsAllowed: devtoolsAllowed(),
        appName: APP_NAME,
      }),
    ),
  );

  mainWindow = await createWindow(!app.isPackaged || devtoolsAllowed(), locale);

  mainWindow.setTitle(APP_NAME);

  logger.info("shell.ready", { locale, allowRoot });

  app.on("activate", () => {
    // macOS: clicking the dock icon with no window open reopens one. Reusing the
    // settings and the protocol is why this is a window creation and not a relaunch.
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow(!app.isPackaged || devtoolsAllowed(), locale).then((window) => {
        mainWindow = window;
        window.setTitle(APP_NAME);
      });
    }
  });
}

app.on("window-all-closed", () => {
  // On macOS a closed window does not quit the app; everywhere else it does.
  if (process.platform !== "darwin") app.quit();
});

main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);

  failBoot("shell.boot.failed", detail);
});

export { bootstrapErrorHtml };
