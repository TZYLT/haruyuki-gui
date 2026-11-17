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
  Notification,
  protocol,
  safeStorage,
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

import { failBoot, removeBootstrapPage, showBootstrapError } from "./bootstrap-surface.js";
import { createMediaHandler, MEDIA_PRIVILEGES, MEDIA_SCHEME } from "./media-protocol.js";
import { MEDIA_TYPE_POLICY } from "./media-mime.js";
import { mediaAccessPath, readMediaAccess, skipsPositionCheck } from "./media-access.js";
import { createDesktopMembers, type DesktopMembersResult } from "./host-members.js";
import { desktopPaths, ensurePaths } from "./host-port.js";
import { createDesktopSecrets, type SecretsPort } from "./secrets.js";
import { DROPPED_FILES_CHANNEL } from "../shared/bridge.js";
import { createDropHandler } from "./drop-handler.js";
import { APP_HOST, APP_SCHEME, APP_PRIVILEGES, createProtocolHandler } from "./protocol.js";
import { shellError } from "../shared/shell-error.js";
import { CSP, headersFor, shouldApplyFallbackCsp } from "./csp.js";
import { APP_NAME, chooseLocale } from "./i18n.js";
import { applyAppName } from "./app-identity.js";
import { createLogger, type Logger } from "./log.js";
import { devtoolsAllowed } from "./devtools.js";
import { createSupervisionLog } from "./supervision/log.js";
import { installApplicationMenu } from "./menu-wiring.js";
import { handleRendererGone, installMainCrashHandlers } from "./crash/capture.js";
import { engineCrashQuery } from "./crash/page.js";
import { createRendererRecovery } from "./crash/renderer-recovery.js";
import { createEngineCrashHandler } from "./crash/engine-handler.js";
import { showCrashPage, crashVersions } from "./crash/wiring.js";
import { crashDirFor, readCrashRecords, type CrashRecord } from "./crash/records.js";
import { runShellCleanup } from "./diagnostics/cleanup.js";
import { registerMainDiagnosticsIpc } from "./diagnostics/main-ipc.js";
import { getSessionDiagnosticsSource } from "./diagnostics/session.js";
import { runBootSupervision, type StaleCandidate } from "./supervision/boot.js";
import { startRuntimeShell } from "./runtime/shell.js";
import { type EngineHost } from "./supervision/engine-host.js";
import { installQuitSupervisor, type QuitSupervisor } from "./supervision/quit.js";
import {
  chosenStorageBackend,
  loadSettings,
  rememberGeometry,
  saveSettings,
} from "./settings-io.js";
import { wireBridge, type BridgeWiring } from "./bridge/wire.js";
import type { LayoutWiring } from "./layout/wiring.js";
import type { CommandLifecycle } from "./command/lifecycle.js";
import { createShellServices } from "./services.js";
import type { LayoutSaveRequest } from "@haruyuki/protocol";
import {
  DEFAULT_SETTINGS,
  isWindowVisible,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  type ShellSettings,
} from "./settings.js";

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

/** D3's app-wide host and its `ipcMain` handlers; created once after `whenReady`. */
let bridge: BridgeWiring | null = null;

/**
 * The layout subsystem outlives a renderer reload but not the app. It is kept
 * beside the bridge because the two close in order: the layout flushes its open
 * save window before the bridge that carries snapshots goes away.
 */
let layoutWiring: LayoutWiring | null = null;

/** The command path: IPC plus the service, rebuilt when an engine arrives. */
let commandLifecycle: CommandLifecycle | null = null;

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
 * The operating-system-facing members, built after ready.
 *
 * `null` before then, which is honest: a caller that runs earlier has no port yet,
 * and pretending otherwise would mean a port whose dependencies are half-built.
 */
let desktopMembers: DesktopMembersResult | null = null;

/** The secure store, built after ready because `safeStorage` needs a ready app. */
let desktopSecrets: SecretsPort | null = null;

/**
 * Which storage backend `safeStorage` chose.
 *
 * Wrapped because `getSelectedStorageBackend` exists on Linux only. On Windows and
 * macOS the question is moot -- encryption is always available -- so a platform that
 * has no such call is reported as "not basic_text", which is the correct answer there.
 */
/**
 * The shutdown registry.
 *
 * One list for the process rather than one per consumer, so cleanup registered by two
 * different callers both runs. `runShutdown` drains it exactly once.
 */
const shutdownCallbacks: (() => void)[] = [];

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

/** Forward a supervision event into the shell log; never let logging throw. */
const logSupervision = createSupervisionLog(() => logger);

const handleEngineCrash = createEngineCrashHandler({
  setLastCrash: (record) => {
    lastEngineCrash = record;
  },
  getWindow: () => mainWindow,
  log: logSupervision,
});

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
  bridge?.attachWindow(window);
  layoutWiring?.publish();

  window.on("close", () => {
    settings = rememberGeometry(settings, window);
    void saveSettings(settings, settingsWritable, logger);
  });

  window.on("closed", () => {
    mainWindow = null;
  });

  // P3 records every renderer death; the recovery policy reloads the normal
  // interface once, shows the D4 error page on a second death, and falls back to
  // the static inline page afterwards. The fallback flag is per window.
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
      { preloadPath: path.join(HERE, "preload.cjs"), logger },
    );
  };

  const handleRendererRecovery = createRendererRecovery({
    window,
    appScheme: APP_SCHEME,
    log: logSupervision,
    showFallback: showRendererFallback,
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    void handleRendererGone(
      { reason: details.reason, exitCode: details.exitCode ?? null },
      {
        dir: crashDirFor(app.getPath("userData")),
        versions: crashVersions(),
        onCrash: (record) => {
          const reason = record.renderer?.reason ?? "";
          const exitCode = record.renderer?.exitCode ?? null;

          handleRendererRecovery(reason, exitCode);
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
    ...(bridge?.bootParams() ?? {}),
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

    await showBootstrapError({ event: "shell.page.failed", detail: loadFailure }, window, {
      preloadPath: path.join(HERE, "preload.cjs"),
      logger,
    });
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
  // The application's own name, set before anything asks for a path.
  //
  // The call is in `app-identity.ts` rather than inline so that `verify:host-port` can
  // exercise the *same* function: the probe runs in its own Electron process and cannot
  // import this file, and when it called `app.setName` itself the resulting assertion
  // passed on a tree with this call deleted. A check that cannot fail is not a check.
  //
  // **This must stay the first statement in `main()`.** `app.setName` only affects
  // paths resolved after it, and every `getPath` call in this file is inside a function
  // that runs later. Moving one to module scope would silently undo this, and the
  // symptom would be a duplicated settings directory rather than an error.
  applyAppName();

  // Both schemes go in one call: `registerSchemesAsPrivileged` may only be called once
  // before ready, and a second call would silently not take effect.
  //
  // **This has to precede `app.ready`, which in this file means it must precede the first
  // `await` in `main()`.** The `await` form is the *executable equivalent*, not the rule:
  // it holds only while `main()` is the file's sole async entry point. A module-scope
  // `await` above this call would make that assertion give the wrong answer -- and it
  // would err toward "legal", which is worse than no answer.
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { ...APP_PRIVILEGES } },
    { scheme: MEDIA_SCHEME, privileges: { ...MEDIA_PRIVILEGES } },
  ]);

  // The four roots, created before anything writes into them.
  //
  // Deliberately before `createLogger`: the logger writes into `logs`, so creating the
  // roots has to come first for the same reason the name does.
  const paths = desktopPaths((name) => app.getPath(name as Parameters<typeof app.getPath>[0]));

  try {
    await ensurePaths(paths);
  } catch (error) {
    process.stderr.write(`haruyuki: cannot create the application directories: ${String(error)}\n`);
    app.exit(1);

    return;
  }

  // The crash reporter starts before ready: a crash during start-up is still a crash
  // worth recording. The dump path is set before the reporter starts so an early crash
  // has somewhere to land; the directory is created by the retention/ensure path above.
  const userData = app.getPath("userData");

  app.setPath("crashDumps", path.join(userData, "crash-dumps"));
  crashReporter.start({ uploadToServer: false, compress: false, rateLimit: false });
  installMainCrashHandlers({
    dir: crashDirFor(userData),
    versions: crashVersions(),
    onFatal: (code) => app.exit(code),
    onUnhandled: (detail) => logger?.warn("crash.unhandled-rejection", { detail }),
  });

  logger = createLogger({ logDir: paths.logs, minLevel: "info" });
  logger.info("shell.boot", {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    packaged: app.isPackaged,
  });

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

  // The secure store. Built after ready because `safeStorage` is only usable then,
  // and synchronous because its construction touches no disk: if it wrote on
  // construction, a plaintext file could appear before the user was ever asked.
  desktopSecrets = createDesktopSecrets({
    userData: app.getPath("userData"),
    safeStorage,
    // `getSelectedStorageBackend` rather than `isEncryptionAvailable`: on Linux with
    // the `basic_text` backend the latter answers `true` while only obfuscating, so
    // deriving the answer from it would silently skip the consent prompt that the
    // requirement exists to guarantee (D2-Q05).
    keyringAvailable: chosenStorageBackend() !== "basic_text",
    consent: async ({ storePath }) => {
      // The question is asked only when the user is about to store something in
      // plaintext, and it names the file: "encrypted" versus "plaintext in
      // C:\...\secrets.json" is a decision a person can make, where "your secrets may
      // be at risk" is not.
      //
      // A modal dialog with three answers, because the three outcomes are genuinely
      // different: accept for good, accept this once, or nothing is stored.
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: APP_NAME,
        message: "This machine has no system keyring.",
        detail: `Credentials will be saved in plain text to ${storePath}. Any program that can read that directory can read them.`,
        buttons: ["Save anyway (do not ask again)", "Save this time only", "Do not save"],
        defaultId: 2,
        cancelId: 2,
      });

      if (answer.response === 0) return "allow-always";
      if (answer.response === 1) return "allow-once";

      return "deny";
    },
  });

  // The operating-system-facing members. Built here rather than at module scope
  // because every dependency below needs a ready app: `Notification` before ready
  // throws, and the dialog needs a window to be modal to.
  desktopMembers = createDesktopMembers(
    {
      showNotification: (title, body) => {
        // `Notification` rather than a renderer toast: this is the OS surface the
        // requirement names, and whether it is *visible* depends on the app having a
        // Start Menu entry, which belongs to packaging (requirement T-3).
        //
        // The construction is wrapped because a throw here would take down whatever
        // tried to report a problem -- a failure path that crashes the reporter is
        // worse than one that stays quiet.
        try {
          new Notification({ title, body }).show();
        } catch (error) {
          logger?.warn("notify.failed", { detail: String(error).slice(0, 120) });
        }
      },
      openExternal: (url) => shell.openExternal(url),
      showOpenDialog: async ({ kind, multiple }) => {
        const answer = await dialog.showOpenDialog({
          properties:
            kind === "directory"
              ? ["openDirectory", ...(multiple ? (["multiSelections"] as const) : [])]
              : ["openFile", ...(multiple ? (["multiSelections"] as const) : [])],
        });

        return { cancelled: answer.canceled, paths: answer.filePaths };
      },
      // True in this build. The measured caveat about toast visibility is packaging's
      // (requirement T-3) and does not change whether a notification can be raised.
      canNotify: () => true,
      readableRoots: () => readableRootsForMedia,
      trustAllPaths: () => currentTrustAllPaths(),
      onFailure: (error) => {
        logger?.warn("host.refused", {
          code: error.code,
          messageKey: error.messageKey,
          detail: error.detail,
        });
      },
    },
    shutdownCallbacks,
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

  // Drag-drop: the one channel this item adds.
  //
  // The preload has already converted the drop to `{name, path}[]`, because a `File`
  // cannot cross into this process at all. What arrives here is therefore untrusted
  // data that claims to describe files, and it is re-checked rather than believed:
  // the requirement is explicit that the main process validates the path again
  // (section 4.6 item 7).
  //
  // `ipcMain.handle` rather than `on`, as the requirement specifies. The preload sends
  // with `ipcRenderer.send` today, which `handle` does not answer -- so the two sides are
  // deliberately not matched yet, and that is the point of using `handle`: the moment the
  // preload is changed to `invoke`, a reply exists to receive. An `on` registration would
  // have to be rewritten at that moment instead.
  ipcMain.handle(DROPPED_FILES_CHANNEL, (_event, payload: unknown) =>
    // The receiving logic is in `drop-handler.ts`: what arrives on this channel is
    // untrusted and turning it into an authorisation is a decision procedure, not
    // startup wiring. This line is the wiring.
    createDropHandler({
      acceptPaths: (accepted) => {
        setReadableRootsForMedia([...readableRootsForMedia, ...accepted]);
      },
      warn: (event, detail) => {
        logger?.warn(event, detail);
      },
    })(payload),
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

  const loaded = await loadSettings(logger);
  settings = loaded.settings;
  settingsWritable = loaded.writable;
  // Retention runs before supervision and the window; a failed sweep is a log line only.
  await runShellCleanup({
    logsDir: app.getPath("logs"),
    crashDir: crashDirFor(userData),
    crashDumpsDir: app.getPath("crashDumps"),
    ...(settings.logs === undefined ? {} : { logs: settings.logs }),
    onLog: logSupervision,
  });
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

  const bridgeWiring = wireBridge({
    coreVersion: app.getVersion(),
    log: (event, detail) => logger?.info(event, detail),
    layoutSave: (request) =>
      layoutWiring === null
        ? { ok: false, code: "LAYOUT_UNAVAILABLE" }
        : layoutWiring.channel.handleSave(request as LayoutSaveRequest),
    layoutState: () => {
      if (layoutWiring === null) {
        throw new Error("layout wiring is not ready");
      }

      return layoutWiring.channel.handleState();
    },
  });
  bridge = bridgeWiring;

  const services = await createShellServices({
    userData,
    ipc: ipcMain,
    host: bridgeWiring,
    log: (code, detail) => logger?.info(code, detail),
  });
  layoutWiring = services.layout;
  commandLifecycle = services.command;

  const locale = chooseLocale(settings.locale, app.getLocale());

  installApplicationMenu({
    app,
    dialog,
    userData,
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

  registerMainDiagnosticsIpc({
    ipcMain,
    getWindow: () => mainWindow,
    sessionSource: getSessionDiagnosticsSource,
    logger,
    app,
    userData,
    settings,
    locale,
    getEngineHost: () => engineHost,
    cleanup: async () => {
      await runShellCleanup({
        logsDir: app.getPath("logs"),
        crashDir: crashDirFor(userData),
        crashDumpsDir: app.getPath("crashDumps"),
        ...(settings.logs === undefined ? {} : { logs: settings.logs }),
        onLog: logSupervision,
      });
    },
  });

  // Window first; the runtime layer verifies the lock and hands D4 the bundle.
  void startRuntimeShell({
    window: mainWindow as BrowserWindow,
    ipcMain,
    userData,
    appVersion: app.getVersion(),
    appPath: app.getAppPath(),
    here: HERE,
    logsDir: app.getPath("logs"),
    onLog: logSupervision,
    onCrash: handleEngineCrash,
    quitSupervisor,
    onHost: (host) => {
      if (host === null) return;

      engineHost = host;
      commandLifecycle?.onHost(host);
    },
  }).catch((error: unknown) => logger?.warn("runtime.startup", { detail: String(error) }));

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
  commandLifecycle?.dispose();
  commandLifecycle = null;
  void layoutWiring?.close();
  layoutWiring = null;
  bridge?.dispose();
  bridge = null;
  // The port's cleanup runs first, and only once. It is not awaited here: the drain
  // below already holds the quit open, so awaiting two independent things in one
  // handler would need a join for no benefit -- the callbacks are synchronous by
  // contract, and `runShutdown` resolves immediately after them.
  //
  // `void` rather than `await` is deliberate and safe for that reason: there is
  // nothing asynchronous inside it to miss.
  void desktopMembers?.runShutdown();

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
  void failBoot("shell.boot.failed", detail, {
    preloadPath: path.join(HERE, "preload.cjs"),
    logger,
  });
});

export { bootstrapErrorHtml } from "./bootstrap-error.js";

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
