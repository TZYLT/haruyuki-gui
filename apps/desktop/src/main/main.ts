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

import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  protocol,
  session,
  shell,
} from "electron";
import { release as osRelease } from "node:os";
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
import { APP_HOST, APP_SCHEME, APP_PRIVILEGES, createProtocolHandler } from "./protocol.js";
import { shellError } from "../shared/shell-error.js";
import { CSP, headersFor, shouldApplyFallbackCsp } from "./csp.js";
import { APP_NAME, chooseLocale } from "./i18n.js";
import { createLogger, type Logger } from "./log.js";
import { installApplicationMenu } from "./menu-wiring.js";
import { handleRendererGone, installMainCrashHandlers } from "./crash/capture.js";
import { engineCrashQuery, rendererCrashQuery } from "./crash/page.js";
import { showCrashPage, crashVersions } from "./crash/wiring.js";
import { crashDirFor, readCrashRecords, type CrashRecord } from "./crash/records.js";
import { collectDiagnostics } from "./diagnostics/collect.js";
import { runDiagnosticsExport, type DiagnosticsExportContext } from "./diagnostics/export.js";
import { registerDiagnosticsIpc } from "./diagnostics/ipc.js";
import { getSessionDiagnosticsSource } from "./diagnostics/session.js";
import { diagnosticsEngineFacts, diagnosticsLabels } from "./diagnostics/wiring.js";
import { writeZip } from "./diagnostics/zip.js";
import { runBootSupervision, type StaleCandidate } from "./supervision/boot.js";
import { startShellEngine } from "./supervision/engine-lifecycle.js";
import { type EngineHost } from "./supervision/engine-host.js";
import { installQuitSupervisor, type QuitSupervisor } from "./supervision/quit.js";
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

/**
 * The one engine host, kept so B2/E4 receive the same `Engine` instance and so
 * the quit supervisor can stop it. P4 starts it; it is not a second engine.
 */
let engineHost: EngineHost | null = null;

/** Ambiguous stale engines from boot; P10's cleanup menu reads this list. */
let staleCandidates: readonly StaleCandidate[] = [];

/** The most recent engine crash, kept for P9's crash page; no page switch yet. */
let lastEngineCrash: CrashRecord | null = null;

/** Installed once, before the window; the host is attached after the async start. */
let quitSupervisor: QuitSupervisor | null = null;

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
 * Versions attached to every crash record.
 *
 * Read at crash time rather than cached at boot: `app.getVersion()` is cheap and
 * a record should describe the build that actually crashed.
 */
/** Forward a supervision event into the shell log; never let logging throw. */
function logSupervision(event: string, detail?: Record<string, unknown>): void {
  logger?.info(event, detail);
}

/**
 * The engine crashed after reporting ready.
 *
 * A start failure never reaches here: engine-host only installs the watcher on a
 * ready engine, so there is nothing to suppress in this layer (R-13). The crash
 * page is a whole-window surface; a null window is only logged.
 *
 * @param record the crash record the P3 watcher wrote
 */
function handleEngineCrash(record: CrashRecord): void {
  lastEngineCrash = record;

  const exitCode = record.engine?.exitCode ?? null;
  const signal = record.engine?.signal ?? null;

  logger?.error("supervision.engine.crash", {
    code: record.code,
    exitCode,
    signal,
  });

  const window = mainWindow;

  if (window === null) {
    logger?.warn("shell.crash.page", {
      state: "skipped",
      kind: "engine",
      detail: "no window is open",
    });

    return;
  }

  void showCrashPage(
    window,
    engineCrashQuery({ code: exitCode, signal }),
    "engine",
    APP_SCHEME,
    logSupervision,
  );
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

  // P3 records every renderer death; P9 switches to the crash page once and
  // falls back to the static inline page afterwards. Both counters are per
  // window: a second window is a new surface and gets its own first attempt,
  // while the same window reloading its crash page must not loop (`RD-13`).
  let rendererCrashes = 0;
  let rendererFallbackShown = false;

  /**
   * Put the static failure page up, at most once.
   *
   * The page needs no React, so it cannot fail the way the crash page did. The
   * flag stops a renderer that keeps dying from reloading that page forever;
   * further deaths are logged and nothing else.
   *
   * @param reason Electron's renderer reason
   * @param exitCode Electron's renderer exit code
   * @param detail why the static page is being used
   */
  const showRendererFallback = (reason: string, exitCode: number | null, detail: string): void => {
    if (rendererFallbackShown) {
      logger?.error("shell.crash.renderer.repeated", {
        state: "ignored",
        reason,
        exitCode,
        detail: "the static failure page is already shown",
      });

      return;
    }

    rendererFallbackShown = true;

    // R-11: the inline page has no export button, but the Help menu still does,
    // and the window keeps a visible way out instead of going black.
    logger?.error("shell.crash.renderer.repeated", { reason, exitCode, detail });

    void showBootstrapError(
      {
        event: "shell.crash.renderer.repeated",
        detail: `the interface process stopped (reason ${reason}, exit code ${String(exitCode)})`,
      },
      window,
    );
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    void handleRendererGone(
      { reason: details.reason, exitCode: details.exitCode ?? null },
      {
        dir: crashDirFor(app.getPath("userData")),
        versions: crashVersions(),
        onCrash: (record) => {
          rendererCrashes += 1;

          const reason = record.renderer?.reason ?? "";
          const exitCode = record.renderer?.exitCode ?? null;

          logger?.error("supervision.renderer.crash", {
            code: record.code,
            reason,
            exitCode,
            attempt: rendererCrashes,
          });

          if (rendererCrashes > 1) {
            showRendererFallback(reason, exitCode, "the crash page did not survive");

            return;
          }

          void showCrashPage(
            window,
            rendererCrashQuery({ reason, exitCode }),
            "renderer",
            APP_SCHEME,
            logSupervision,
          ).then((shown) => {
            // No normal page to derive the route from, or the load failed:
            // the static page is the only floor left.
            if (!shown)
              showRendererFallback(reason, exitCode, "the crash route could not be shown");
          });
        },
      },
    ).catch((error: unknown) => {
      logger?.warn("supervision.renderer.crash.failed", {
        detail: error instanceof Error ? error.message : String(error),
      });
    });
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
  const userData = app.getPath("userData");

  // P3 first, before ready (docs/33 section 5.5): a crash during start-up is
  // still a crash worth recording. The dump path is set before the reporter
  // starts so an early crash has somewhere to land.
  app.setPath("crashDumps", path.join(userData, "crash-dumps"));
  crashReporter.start({ uploadToServer: false, compress: false, rateLimit: false });
  installMainCrashHandlers({
    dir: crashDirFor(userData),
    versions: crashVersions(),
    onFatal: (code) => app.exit(code),
    onUnhandled: (detail) => logger?.warn("crash.unhandled-rejection", { detail }),
  });

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

  // Boot supervision runs before the menu and the window (docs/33 section
  // 5.5): a stale engine must be gone, or listed for P10, before the user can
  // ask about it. Its failures are logged inside and never abort the boot.
  const boot = await runBootSupervision({
    userData,
    appVersion: app.getVersion(),
    onLog: logSupervision,
  });

  staleCandidates = boot.stale;

  logger.info("supervision.boot", {
    stale: boot.stale.length,
    reclaimed: boot.reclaimed.length,
    candidates: boot.stale.map((candidate) => candidate.pid),
  });

  // Installed once with a null host so a quit before the engine start finishes
  // still clears the boot marker. The host is attached on start success.
  quitSupervisor = installQuitSupervisor({
    host: engineHost,
    userData,
    app,
    onLog: logSupervision,
  });

  const locale = chooseLocale(settings.locale, app.getLocale());

  installApplicationMenu({
    app,
    shell,
    dialog,
    locale,
    devtoolsAllowed,
    getWindow: () => mainWindow,
    getStaleCandidates: () => staleCandidates,
    setStaleCandidates: (next) => {
      staleCandidates = next;
    },
    sessionAvailable: () => getSessionDiagnosticsSource() !== null,
    logger,
  });

  mainWindow = await createWindow(!app.isPackaged || devtoolsAllowed(), locale);

  mainWindow.setTitle(APP_NAME);

  logger.info("shell.ready", { locale, allowRoot });

  // D4's three diagnostics channels. Registered after the window exists so a
  // menu/crash-page "open" has a webContents, and before the engine starts so a
  // crash during start-up can already be exported. No second engine, window or
  // preload member is involved: the channels are the only extension.
  registerDiagnosticsIpc({
    ipcMain,
    getWindow: () => mainWindow,
    sessionAvailable: getSessionDiagnosticsSource() !== null,
    logger,
    app,
    export: (run) => {
      const context: DiagnosticsExportContext = {
        userData,
        logsDir: app.getPath("logs"),
        crashDumpsDir: app.getPath("crashDumps"),
        appVersion: app.getVersion(),
        commit: null,
        electron: process.versions.electron ?? "unknown",
        chrome: process.versions.chrome ?? "unknown",
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        release: osRelease(),
        locale,
        theme: settings.theme,
        settings,
        engine: diagnosticsEngineFacts(engineHost),
        crashes: readCrashRecords(crashDirFor(userData)),
        sessionSource: getSessionDiagnosticsSource(),
      };

      return runDiagnosticsExport({ options: run.options }, context, {
        now: () => new Date(),
        onEvent: run.onEvent,
        abortSignal: run.signal,
        collect: collectDiagnostics,
        writeZip,
        labels: diagnosticsLabels(locale),
        showSaveDialog: async (options) => {
          const result =
            mainWindow === null
              ? await dialog.showSaveDialog(options)
              : await dialog.showSaveDialog(mainWindow, options);

          return { canceled: result.canceled, filePath: result.filePath };
        },
        showMessageBox: async (options) => {
          const result =
            mainWindow === null
              ? await dialog.showMessageBox(options)
              : await dialog.showMessageBox(mainWindow, options);

          return { response: result.response };
        },
        openPath: async (target) => {
          const failure = await shell.openPath(target);

          if (failure !== "") throw new Error(failure);
        },
      });
    },
  });

  // The window never waits for the engine (docs/33 section 5.5 item 9). A
  // missing bundle resolves as a skip and leaves the window exactly as it was.
  void startShellEngine({
    userData,
    appVersion: app.getVersion(),
    appPath: app.getAppPath(),
    onLog: logSupervision,
    onCrash: handleEngineCrash,
    quitSupervisor,
    onHost: (host) => {
      engineHost = host;
    },
  }).catch((error: unknown) => {
    logger?.warn("supervision.engine.start", {
      state: "failed",
      reason: "unexpected",
      detail: error instanceof Error ? error.message : String(error),
    });
  });

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

/**
 * Stale-engine candidates from the last boot scan.
 *
 * P10's cleanup menu reads this through the existing main module; it is not a
 * renderer bridge and adds no channel.
 */
export function getStaleEngineCandidates(): readonly StaleCandidate[] {
  return staleCandidates;
}

/** The most recent engine crash record, for P9's crash page. */
export function getLastEngineCrash(): CrashRecord | null {
  return lastEngineCrash;
}

/** The single engine host, for B2/E4 to consume instead of constructing one. */
export function getEngineHost(): EngineHost | null {
  return engineHost;
}
