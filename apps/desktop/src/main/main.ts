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

/**
 * This file's directory at runtime.
 *
 * `import.meta.dirname` is the obvious spelling and it does not survive the build: the
 * main process compiles to CommonJS, where `import.meta` becomes `{}`, so the two paths
 * derived from it below would both silently become `undefined`-joined nonsense. The
 * failure is a window that loads nothing, with no error naming the cause.
 *
 * `__dirname` is the CommonJS equivalent and is correct here precisely because this file
 * is built as CommonJS.
 */
const HERE = __dirname;

import { bootstrapErrorHtml, type BootstrapFailure } from "./bootstrap-error.js";
import { createMediaHandler, MEDIA_PRIVILEGES, MEDIA_SCHEME } from "./media-protocol.js";
import { MEDIA_TYPE_POLICY } from "./media-mime.js";
import { mediaAccessPath, readMediaAccess, skipsPositionCheck } from "./media-access.js";
import { APP_HOST, APP_SCHEME, APP_PRIVILEGES, createProtocolHandler } from "./protocol.js";
import { shellError } from "../shared/shell-error.js";
import { CSP, headersFor, shouldApplyFallbackCsp } from "./csp.js";
import { APP_NAME, chooseLocale } from "./i18n.js";
import { buildMenuTemplate } from "./menu.js";
import { createLogger, type Logger } from "./log.js";
import {
  DEFAULT_SETTINGS,
  isWindowVisible,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  readSettings,
  serializeSettings,
  SETTINGS_VERSION,
  settingsPath,
  type ShellSettings,
} from "./settings.js";

/** The escape hatch that lets a packaged build open the inspector. */
const DEVTOOLS_ENV = "HARUYUKI_DEVTOOLS";

/**
 * How long a boot failure waits for its log line before exiting anyway.
 *
 * Long enough for a local append; short enough that a wedged disk does not turn a
 * crash into a hang. The message is already on stderr by then.
 */
const BOOT_FLUSH_TIMEOUT_MS = 2000;

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
 * Whether this build may write the settings file back.
 *
 * False when the file on disk declares a version this build does not know. Set by
 * {@link loadSettings} and read by {@link saveSettings}; see `readSettings` for why
 * the two decisions cannot be separated.
 */
let settingsWritable = true;

/**
 * The temporary file the failure page was written to, when one was.
 *
 * Held so the quit handler can delete it. A page rendered from memory would avoid
 * the file, but `data:` crashes on this platform (`E-61`), so the file is the
 * mechanism and its cleanup is part of the mechanism.
 */
let bootstrapPagePath: string | null = null;

/**
 * The paths the user has authorised this session, for the media channel.
 *
 * `cwd` comes from core and the picked/dropped paths come from the user; this item
 * only holds the set, because it is the layer that answers "may this path be
 * served". The set is replaced wholesale on a session switch rather than
 * accumulated: it expresses "which workspace am I looking at", not "what have I
 * ever opened" (doc 29 section 4.7.3).
 *
 * Empty until something fills it, which is the correct initial answer: nothing has
 * been authorised yet.
 */
let readableRootsForMedia: readonly string[] = [];

/**
 * Whether the user has switched the position check off.
 *
 * Cached from `media-access.json` and refreshed when the file's mtime changes, so a
 * switch flipped in `F5` takes effect without a restart while still costing one
 * `stat` per request rather than a file read.
 */
let trustAllPathsForMedia = false;
let mediaAccessMtime = -1;

/**
 * The current position-trust answer, refreshed when the file changes.
 *
 * One `stat` per request rather than a file read per request, and one file read
 * rather than none, because the alternative to a cache here is either a switch that
 * needs a restart or a disk read on every image load. The mtime is the cache key
 * because it is exactly the question "has someone written the file since I last
 * looked", and the answer is stable when the file is absent.
 *
 * Synchronous on purpose: it is called from inside the protocol handler, where the
 * contract is a synchronous predicate. The read is kicked off without awaiting and
 * the *previous* answer is used for this request, which is the right trade for a
 * switch a human flips by hand -- one request served under the old decision is not
 * a defect, and blocking every media request on a file read would be.
 */
function currentTrustAllPaths(): boolean {
  const file = mediaAccessPath(app.getPath("userData"));

  void (async () => {
    try {
      const { statSync } = await import("node:fs");
      const mtime = statSync(file).mtimeMs;

      if (mtime === mediaAccessMtime) return;

      mediaAccessMtime = mtime;
      trustAllPathsForMedia = skipsPositionCheck(await readMediaAccess(app.getPath("userData")));
    } catch {
      // Absent is the normal case until `F5` ships. It also covers "removed while
      // running", which must fall back to the closed default rather than keeping
      // a stale `true`.
      mediaAccessMtime = -1;
      trustAllPathsForMedia = false;
    }
  })();

  return trustAllPathsForMedia;
}

/**
 * Set the paths the media channel may serve.
 *
 * Called by whatever owns the session and the picker. Exported so the readable set
 * has one write point; a second caller assigning the array directly would be a
 * second definition of the set.
 *
 * @param roots the paths to allow, replacing whatever was there
 */
export function setReadableRootsForMedia(roots: readonly string[]): void {
  // Replaced, never merged: the set answers "which workspace am I looking at",
  // and merging would make it grow for the lifetime of the process.
  readableRootsForMedia = [...roots];
}

/**
 * Put the bootstrap failure page in front of the user.
 *
 * The requirement names two error surfaces and this is the first one
 * (`D1-Q37`): when `app://` itself cannot serve, there is no React, no
 * catalogue and no token layer, so the page is an HTML string built by
 * `bootstrap-error.ts`.
 *
 * It is loaded from a temporary file rather than a `data:` URL. That is not a
 * preference: on this development machine a window pointed at `data:` dies with
 * `0xC0000003` before painting (`E-61`), and a failure page that crashes is
 * worse than the blank window it replaces. A file has no such interaction.
 *
 * Returns whether the page was actually shown, so the caller can decide between
 * "leave it up" and "exit with a code"; a failure page that can be seen is a
 * better outcome than a fast exit.
 *
 * @param failure what to report
 * @param target an existing window to reuse, or `undefined` to make one
 */
async function showBootstrapError(
  failure: BootstrapFailure,
  target?: BrowserWindow,
): Promise<boolean> {
  const { writeFile } = await import("node:fs/promises");
  const file = path.join(app.getPath("temp"), `haruyuki-bootstrap-${String(process.pid)}.html`);

  try {
    await writeFile(file, bootstrapErrorHtml(failure), "utf8");

    // Remember it so the quit handler can remove it: one file per failed launch
    // would otherwise accumulate in the user's temp directory forever.
    bootstrapPagePath = file;

    const window =
      target ??
      new BrowserWindow({
        width: 900,
        height: 560,
        show: false,
        // The same hardening as the shell window. This page is static text, but a
        // second window with weaker settings is a second attack surface, and the
        // rule would then have an exception nobody remembers.
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
          devTools: false,
        },
      });

    window.once("ready-to-show", () => window.show());
    await window.loadFile(file);

    return true;
  } catch (error) {
    logger?.error("shell.bootstrap-error.failed", { detail: String(error) });

    return false;
  }
}

/**
 * Report a failure that happened before the window could show a page.
 *
 * Writes to stderr and to the log, then tries to render the failure page. Exits
 * with the platform's failure code only when the page could not be shown -- a
 * visible explanation outranks a specific exit code, and the code is in the log
 * either way.
 *
 * The log write is awaited before anything else happens. `app.exit()`
 * terminates without draining anything, and the logger writes through a promise
 * chain, so the first version of this function queued an error record and then
 * killed the process before the record reached the file: the one line that
 * explains a failed launch was the line most likely to be lost.
 *
 * @param event short stable identifier
 * @param detail human-readable detail
 */
async function failBoot(event: string, detail: string): Promise<void> {
  process.stderr.write(`[haruyuki] ${event}: ${detail}\n`);

  const logDir = logger === null ? undefined : app.getPath("logs");

  if (logDir !== undefined) process.stderr.write(`[haruyuki] log: ${logDir}\n`);

  logger?.error(event, { detail });

  // A flush that never settles would turn "the app failed" into "the app hangs",
  // so it is bounded. The record is best-effort by then; stderr already has it.
  if (logger !== null) {
    await Promise.race([
      logger.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, BOOT_FLUSH_TIMEOUT_MS);
      }),
    ]);
  }

  const shown = await showBootstrapError({
    event,
    detail,
    ...(logDir === undefined ? {} : { logPath: logDir }),
  });

  if (shown) return;

  app.exit(1);
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
 *
 * A file written by a newer build is read but never written back, so
 * `settingsWritable` is captured here rather than decided at save time. The
 * decision belongs where the version was seen: once the values are in memory the
 * evidence is gone.
 */
async function loadSettings(): Promise<ShellSettings> {
  const { readFile } = await import("node:fs/promises");
  const file = settingsPath(app.getPath("userData"));

  let raw: string;

  try {
    raw = await readFile(file, "utf8");
  } catch {
    // Not an error: this is a first launch, or the file was removed.
    logger?.info("settings.first-launch", { file });

    settingsWritable = true;

    return { ...DEFAULT_SETTINGS };
  }

  const read = readSettings(raw);

  settingsWritable = read.writable;

  // A file that exists but could not be understood is a different event from a
  // first launch. Reporting both as "first launch" is how a settings file being
  // written over by a half-crashed process goes unnoticed until someone wonders
  // why their preferences never stick.
  if (read.corrupt) {
    logger?.warn("settings.corrupt", {
      code: shellError("SHELL_SETTINGS_CORRUPT", `unparsable document: ${file}`).code,
      detail: file,
    });
  }

  if (!read.writable) {
    // Warn, not error: the shell works, it just will not persist. The user
    // needs to know the next launch will forget this session's window.
    logger?.warn("settings.read-only", {
      file,
      foundVersion: read.foundVersion,
      supportedVersion: SETTINGS_VERSION,
    });
  }

  logger?.info("settings.loaded", {
    file,
    theme: read.settings.theme,
    locale: read.settings.locale,
    writable: read.writable,
  });

  return read.settings;
}

/**
 * Persist the settings. Failures are logged, never surfaced: a settings file that
 * cannot be written must not close the window the user is working in.
 *
 * The write is skipped entirely when the file on disk is a newer format. Writing
 * would drop the fields this build cannot represent, and the newer build would
 * then find them gone -- a downgrade the user never asked for.
 */
async function saveSettings(next: ShellSettings): Promise<void> {
  if (!settingsWritable) {
    logger?.info("settings.write-skipped", { detail: "the file was written by a newer version" });

    return;
  }

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
    // The live clamp. `parseWindow` refuses a *saved* rectangle below the
    // minimum, but that only guards the restore path; without these two the user
    // can still drag the window down to nothing and the editor has no usable
    // area left. `D1-Q27` states 1024×700 as a property of the window, so it
    // belongs on the window as well as on the parser.
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is not the same
    // as an omitted key. Spreading a conditional is how the position is left out
    // entirely on a first launch, which lets the platform centre the window.
    ...(usable ? { x: restored.x, y: restored.y } : {}),
    // Show only when the page is painted: a window that appears white and fills in
    // is the single most common complaint about Electron shells.
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      // The preload is the only bridge. `nodeIntegration: false` plus `sandbox: true` is
      // what makes the three-member shape the whole attack surface.
      //
      // Sibling of this file, with the `.cjs` extension the build emits. The path has to
      // match the build's output *filename*, not just its directory: a wrong preload path
      // is the quietest failure in the shell -- Electron loads nothing, the bridge is
      // `undefined` in the renderer, and nothing anywhere reports why.
      preload: path.join(HERE, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The shell never uses a `<webview>`, and enabling the tag without a reason is how
      // a page gets a second, weaker renderer inside it.
      webviewTag: false,
      // Devtools are gated on the same condition as the menu item, so there is one answer
      // to "can the user inspect this build".
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

  const url = `${APP_SCHEME}://${APP_HOST}/index.html?${params.toString()}`;

  // `loadURL` rejects on a net error but *resolves* on an HTTP error status, so
  // a 404 from the protocol handler -- missing bundle, wrong allow root -- is a
  // successful call that leaves a blank window. Watching `did-fail-load` and
  // checking the served document afterwards are the two ways to notice, and only
  // the second catches a 404. This is exactly that case: the window exists and
  // shows nothing.
  let loadFailure: string | null = null;

  window.webContents.on("did-fail-load", (_event, code, description, failedUrl) => {
    if (!failedUrl.startsWith(`${APP_SCHEME}://`)) return;

    loadFailure = `did-fail-load ${String(code)} ${description}`;
  });

  try {
    await window.loadURL(url);
  } catch (error) {
    loadFailure = error instanceof Error ? error.message : String(error);
  }

  // A successful load of a 404: the handler answered, so nothing threw, and the
  // document is the empty body the handler returns for a miss.
  if (loadFailure === null) {
    const mounted = (await window.webContents
      .executeJavaScript("document.getElementById('root') !== null", true)
      .catch(() => false)) as boolean;

    if (!mounted) loadFailure = `the document at ${url} has no #root`;
  }

  if (loadFailure !== null) {
    logger?.error("shell.page.failed", { detail: loadFailure, url });

    await showBootstrapError({ event: "shell.page.failed", detail: loadFailure }, window);
  }

  return window;
}

/**
 * Build and start the shell.
 *
 * Everything above this function is a pure helper; this is the only place with side
 * effects that matter to the process.
 */
async function main(): Promise<void> {
  logger = createLogger({ logDir: app.getPath("logs"), minLevel: "info" });
  logger.info("shell.boot", {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
  });

  // Before ready, and before anything reads the protocol. Both schemes go in one
  // call: `registerSchemesAsPrivileged` may only be called once before ready, and
  // a second call would silently not take effect.
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { ...APP_PRIVILEGES } },
    { scheme: MEDIA_SCHEME, privileges: { ...MEDIA_PRIVILEGES } },
  ]);

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

  const allowRoot = path.join(HERE, "../renderer");

  protocol.handle(
    APP_SCHEME,
    createProtocolHandler({
      allowRoot,
      headersFor,
      // A refusal must leave a trace. Without this the handler answers 403 or 404
      // into the void, and a broken allow root looks exactly like a missing file:
      // a blank window and nothing in the log.
      onFailure: (error) => {
        logger?.warn("protocol.refused", {
          code: error.code,
          messageKey: error.messageKey,
          detail: error.detail,
        });
      },
    }),
  );

  // The media channel. Registered here rather than inside its module because the
  // scheme list has to be a single call, and because a scheme registered twice in
  // one process does not take effect the second time (measured during the route
  // probe).
  protocol.handle(
    MEDIA_SCHEME,
    createMediaHandler({
      // The type table lives behind this policy; the seam is deliberate so the two
      // packages never edit the same region of this file.
      types: MEDIA_TYPE_POLICY,
      readableRoots: () => readableRootsForMedia,
      // Read per request rather than cached: the file is the user's, and `F5`'s
      // switch would otherwise need a message to this process to take effect.
      // Until `F5` ships there is no writer, so this is always the closed default.
      trustAllPaths: () => currentTrustAllPaths(),
      onFailure: (error) => {
        logger?.warn("media.refused", {
          code: error.code,
          messageKey: error.messageKey,
          detail: error.detail,
        });
      },
    }),
  );

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

/**
 * Delete the failure page's temporary file, if one was written.
 *
 * Best effort and silent: it runs during shutdown, where there is no one to tell
 * and nothing to fall back to. A leftover temp file is a nuisance, not a failure.
 */
async function removeBootstrapPage(): Promise<void> {
  if (bootstrapPagePath === null) return;

  const file = bootstrapPagePath;

  bootstrapPagePath = null;

  try {
    const { rm } = await import("node:fs/promises");

    await rm(file, { force: true });
  } catch {
    // Nothing to do; the OS clears temp directories.
  }
}

app.on("window-all-closed", () => {
  // On macOS a closed window does not quit the app; everywhere else it does.
  if (process.platform !== "darwin") app.quit();
});

// The last chance to get queued records onto disk. The logger serialises writes,
// so a record issued on the way out is still in flight when the process ends;
// without this the final events of every session -- the ones that say how it
// ended -- are the ones most likely to be missing. `will-quit` because it can be
// cancelled, and an async drain needs to hold the quit open to be worth anything.
app.on("will-quit", (event) => {
  // The guard is `logger !== null` rather than "is there anything to do", because
  // this handler re-enters itself: it calls `app.quit()` once it is done, and the
  // second entry must not preventDefault again forever.
  if (logger === null) return;

  const pending = logger;

  logger = null;
  event.preventDefault();

  void pending
    .flush()
    .catch(() => {
      // Nothing useful to do while exiting, and a throw here would replace the
      // shutdown with a crash report about logging.
    })
    .then(removeBootstrapPage)
    .then(() => {
      app.quit();
    });
});

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);

  // `failBoot` is async because it awaits the log flush. Nothing is left to
  // await it *for* once the process is exiting, but an unhandled rejection here
  // would print over the message it is trying to deliver.
  void failBoot("shell.boot.failed", detail);
});

export { bootstrapErrorHtml };
