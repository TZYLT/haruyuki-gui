/**
 * Does the whole drop path work end to end, or only the part the cursor shows?
 *
 * The cursor changing from no-drop to copy proves one thing: `dragover` is cancelled, so
 * the listener is installed and the window will accept a drop. It does **not** prove the
 * `drop` handler runs, that the payload reaches the main process, or that the main process
 * accepts it -- those are three separate steps and the cursor touches none of them.
 *
 * So this probe drives all three, in the real window with the real preload:
 *
 *   1. dispatch a `drop` with a `DataTransfer` carrying one constructed `File`;
 *   2. the preload's listener runs, calls `webUtils.getPathForFile`, and sends the report;
 *   3. the main process validates it and answers.
 *
 * A constructed `File` has no origin, so `webUtils` returns `""` and the entry arrives
 * name-only -- measured earlier and expected. What that still proves is the chain: the
 * listener fires, the conversion runs, IPC is reached, the handler validates. A real path
 * cannot be faked, which is why this is a probe and not the acceptance itself.
 *
 * The report includes what the main process answered, so "the drop was handled" is an
 * observation rather than an inference from the absence of an error.
 */

import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { applyAppName } from "../src/main/app-identity.js";
import { createDropHandler } from "../src/main/drop-handler.js";
import { DROPPED_FILES_CHANNEL } from "../src/shared/bridge.js";
import { APP_HOST, APP_SCHEME } from "../src/main/protocol.js";

/** Where the report goes. `app.exit` does not drain stdout. */
const REPORT = path.join(process.cwd(), "apps", "desktop", "dist", "probe", "drop-path.json");

/** The built main-process directory, where `preload.cjs` lives. */
const MAIN_DIR = path.resolve(__dirname, "..", "main");

/** Recorded answers, so the report can show what the handler decided. */
const answers: unknown[] = [];

function main(): void {
  applyAppName();

  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);

  void run();
}

async function run(): Promise<void> {
  await app.whenReady();

  // The real handler, with a recorder in front of the shell's accept function, so the
  // report shows what it accepted rather than only that it did not throw.
  const accepted: string[][] = [];

  ipcMain.handle(DROPPED_FILES_CHANNEL, (_event, payload: unknown) => {
    const handler = createDropHandler({
      acceptPaths: (paths) => accepted.push([...paths]),
    });

    const answer = handler(payload);

    answers.push(answer);

    return answer;
  });

  const allowRoot = path.join(MAIN_DIR, "..", "renderer");

  protocol.handle(APP_SCHEME, (request: Request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const full = path.resolve(allowRoot, relative);

    if (!full.startsWith(path.resolve(allowRoot))) return new Response(null, { status: 403 });

    try {
      return new Response(readFileSync(full), { status: 200 });
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

  const report: Record<string, unknown> = {};

  await window.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  await new Promise((resolve) => setTimeout(resolve, 800));

  // A synthetic drop with one constructed `File`. The preload's listener is what turns
  // this into IPC; nothing here reaches into the preload directly.
  // Written as plain strings joined by newlines: the injected code contains backticks in
  // its own comments, and a template literal cannot hold one unescaped.
  const injected = [
    "(async () => {",
    "  const transfer = new DataTransfer();",
    '  transfer.items.add(new File(["hello"], "synthetic.txt", { type: "text/plain" }));',
    '  const event = new DragEvent("drop", {',
    "    bubbles: true,",
    "    cancelable: true,",
    "    dataTransfer: transfer,",
    "  });",
    "  window.dispatchEvent(event);",
    "  await new Promise((resolve) => setTimeout(resolve, 600));",
    "  return { defaultPrevented: event.defaultPrevented, files: transfer.files.length };",
    "})()",
  ].join("\n");

  report.dispatch = await window.webContents.executeJavaScript(injected);

  report.handlerAnswers = answers;
  report.accepted = accepted;

  // Something observable that is not the IPC reply: did the readable set grow?
  report.acceptedCount = accepted.reduce((total, batch) => total + batch.length, 0);

  window.destroy();
  writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

  app.exit(0);
}

main();
