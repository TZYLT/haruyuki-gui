/**
 * Does the drop listener actually run in the real window?
 *
 * The user's report is specific and it does not match "the listener works": dragging over
 * the window shows the **no-drop** cursor everywhere except over a text input, while the
 * window content does not change. A no-drop cursor means `dragover` was not
 * `preventDefault`ed, and the listener is the only thing that does that.
 *
 * So the question is not "is the code present" -- it is, in `preload.cjs` -- but "does
 * that code execute in this window". The quietest failure in an Electron shell is a
 * preload that does not load: the bridge is simply `undefined` in the renderer and nothing
 * anywhere reports why.
 *
 * This probe opens the real window, then asks the renderer what it can see:
 *
 *   - is `window.haruyuki` present (the preload ran at all)?
 *   - does a synthetic `dragover` arrive with `defaultPrevented === true`
 *     (the listener is attached and calls `preventDefault`)?
 *
 * A synthetic event is enough for the second question: it proves the listener is
 * registered and calls through. It does not prove the operating system's cursor changes,
 * which is why the human's observation and this probe are different evidence.
 */

import { app, BrowserWindow, protocol } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { APP_NAME } from "../src/main/i18n.js";
import { applyAppName } from "../src/main/app-identity.js";
import { CSP_DIRECTIVES } from "../src/main/csp.js";
import { APP_HOST, APP_SCHEME } from "../src/main/protocol.js";

/** Where the report goes. `app.exit` does not drain stdout. */
const REPORT = path.join(process.cwd(), "apps", "desktop", "dist", "probe", "drop-wiring.json");

/**
 * The built main-process directory, which is where `preload.cjs` lives.
 *
 * Not this file's directory: a probe is bundled into `dist/probe/`, and the first version
 * pointed at its own sibling there, so the preload path did not exist and the probe
 * measured a window with no preload at all. That is worth leaving in as a comment because
 * it produced exactly the symptom under investigation -- a window where `dragover` is not
 * cancelled and `window.haruyuki` is undefined.
 */
const MAIN_DIR = path.resolve(__dirname, "..", "main");

function main(): void {
  // Both of these must precede `app.ready` -- `registerSchemesAsPrivileged` is rejected
  // afterwards, which is exactly the bug the shell had. Made the same mistake here on the
  // first attempt, which is the argument for keeping the rule in the comment rather than
  // in one's head.
  applyAppName();

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  void run();
}

async function run(): Promise<void> {
  await app.whenReady();

  const allowRoot = path.join(MAIN_DIR, "..", "renderer");

  protocol.handle(APP_SCHEME, (request: Request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const full = path.resolve(allowRoot, relative);

    if (!full.startsWith(path.resolve(allowRoot))) {
      return new Response(null, { status: 403 });
    }

    try {
      const body = readFileSync(full);

      return new Response(body, { status: 200 });
    } catch {
      return new Response(null, { status: 404 });
    }
  });

  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(MAIN_DIR, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  // A preload that throws leaves no trace anywhere. These two capture it.
  const preloadErrors: string[] = [];

  window.webContents.on("preload-error", (_event, preloadPath, error) => {
    preloadErrors.push(`${preloadPath}: ${error.message}`);
  });

  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) preloadErrors.push(`console: ${message}`);
  });

  const report: Record<string, unknown> = {
    appName: APP_NAME,
    cspDirectives: [...CSP_DIRECTIVES].length,
    preloadPath: path.join(MAIN_DIR, "preload.cjs"),
    preloadErrors,
  };

  await window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  // Both questions in one round trip. `executeJavaScript` runs in the page's world, which
  // is where the preload's `window.addEventListener` registered its listeners.
  report.answers = await window.webContents.executeJavaScript(`
    (() => {
      const dragover = new Event("dragover", { bubbles: true, cancelable: true });
      window.dispatchEvent(dragover);

      return {
        bridgePresent: typeof window.haruyuki === "object" && window.haruyuki !== null,
        bridgeMembers: window.haruyuki === undefined ? [] : Object.keys(window.haruyuki).sort(),
        dragoverDefaultPrevented: dragover.defaultPrevented,
      };
    })()
  `);

  window.destroy();
  writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

  app.exit(0);
}

main();
