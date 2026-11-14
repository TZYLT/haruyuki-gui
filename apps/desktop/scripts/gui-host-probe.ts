/**
 * The GUI-host probe: answers whether this machine can run the shell.
 *
 * `verify-gui-host.mjs` launches this bundle with Electron. Everything it reports is
 * observed from inside a real main process, because the question is exactly "does a real
 * main process work here" -- a Node-based answer would not be an answer.
 *
 * It runs three stages and keeps going after a failure wherever the later stages are still
 * meaningful, so one run produces a complete picture rather than a single yes/no:
 *
 *   stage 1  a bare `BrowserWindow` over a `data:` URL, and whether its DOM is readable
 *   stage 2  the built shell over `app://`, under the real CSP, with a real preload
 *   stage 3  the preload bridge's arrival in the renderer, and the Node globals' absence
 *
 * Stage 3 is the one that matters most for this item: it is the only place where
 * `contextIsolation`, `sandbox` and the three-member bridge are observed together in a
 * running renderer rather than asserted from source.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";

/** What the probe reports back. */
interface GuiResult {
  bareWindow?: boolean;
  bareError?: string;
  shellLoaded?: boolean;
  shellError?: string;
  readyState?: string;
  origin?: string;
  bridgePresent?: boolean;
  bridgeGlobal?: string;
  bridgeMembers?: string[];
  bridgeError?: string;
  nodeAbsent?: boolean;
  nodeLeaks?: string[];
  title?: string;
}

/** The result, filled in as each stage completes. */
const result: GuiResult = {};

/** The shell's built main entry, from the caller. */
const SHELL_ENTRY = process.env["HARUYUKI_GUI_MAIN"];

/**
 * Print the result and quit.
 *
 * @param code process exit code
 */
function finish(code: number): void {
  process.stdout.write(`GUIRESULT ${JSON.stringify(result)}\n`);
  app.exit(code);

  // `app.exit` terminates the process; nothing after it runs. No `throw` here: it would
  // surface as an unhandled rejection during shutdown and bury a passing run in noise.
}

/**
 * Stage 1: a bare window over a data URL.
 *
 * `data:` rather than `app://` on purpose: this stage must fail only if Electron itself
 * cannot open a window, not if our protocol registration is wrong. Mixing the two would
 * make a protocol bug look like a platform problem.
 */
async function stageBareWindow(): Promise<void> {
  const window = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });

  try {
    await window.loadURL("data:text/html,<h1 id=t>bare</h1>");

    const text = (await window.webContents.executeJavaScript(
      "document.getElementById('t').textContent",
    )) as string;

    result.bareWindow = text === "bare";
  } catch (error) {
    result.bareWindow = false;
    result.bareError = error instanceof Error ? error.message : String(error);
  } finally {
    window.destroy();
  }
}

/**
 * Stages 2 and 3: the real shell, then the bridge inside it.
 *
 * The shell is loaded by running its own main process logic rather than by recreating a
 * window here. That is the point of the exercise: a shell that only works when a test
 * builds the window itself has not been tested.
 */
async function stageShell(): Promise<void> {
  if (SHELL_ENTRY === undefined) {
    result.shellLoaded = false;
    result.shellError = "HARUYUKI_GUI_MAIN was not set";
    return;
  }

  // The shell was already imported by `start()`, before the app became ready. Its
  // `whenReady` handler has either run or is about to; this only waits for its window.

  // Wait for the window the shell created.
  const deadline = Date.now() + 20_000;

  const shellWindow = await new Promise<BrowserWindow | null>((resolve) => {
    const poll = setInterval(() => {
      const [first] = BrowserWindow.getAllWindows();

      if (first !== undefined) {
        clearInterval(poll);
        resolve(first);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        resolve(null);
      }
    }, 50);
  });

  if (shellWindow === null) {
    result.shellLoaded = false;
    result.shellError = "the shell created no window within 20 s";
    return;
  }

  // Its `ready-to-show` may already have fired, so wait on the document state instead.
  await new Promise<void>((resolve) => {
    if (!shellWindow.webContents.isLoading()) {
      resolve();
      return;
    }

    shellWindow.webContents.once("did-finish-load", () => resolve());
    setTimeout(resolve, 15_000);
  });

  const inspected = (await shellWindow.webContents.executeJavaScript(`
    (() => {
      const bridge = window.haruyuki;
      const leaks = ["require", "process", "module", "Buffer"].filter(
        (name) => typeof window[name] !== "undefined",
      );
      return {
        readyState: document.readyState,
        origin: location.origin,
        href: location.href,
        bridgePresent: typeof bridge === "object" && bridge !== null,
        bridgeMembers: bridge ? Object.keys(bridge) : [],
        bridgeType: typeof bridge,
        nodeLeaks: leaks,
        rootHasContent: (document.getElementById("root")?.childElementCount ?? 0) > 0,
      };
    })()
  `)) as {
    readyState: string;
    origin: string;
    href: string;
    bridgePresent: boolean;
    bridgeMembers: string[];
    bridgeType: string;
    nodeLeaks: string[];
    rootHasContent: boolean;
  };

  result.readyState = inspected.readyState;
  result.origin = inspected.origin;
  result.title = shellWindow.getTitle();

  // Stage 2 passes only if the document came from the app:// origin and actually has a
  // rendered tree. A blank document with the right origin means the bundle never ran.
  result.shellLoaded =
    inspected.origin === "app://haruyuki" &&
    inspected.readyState === "complete" &&
    inspected.rootHasContent;

  if (!result.shellLoaded) {
    result.shellError =
      inspected.origin !== "app://haruyuki"
        ? `the document origin is ${inspected.origin}, not app://haruyuki`
        : inspected.readyState !== "complete"
          ? `the document is ${inspected.readyState}, not complete`
          : "the document loaded but the renderer mounted nothing into #root";
  }

  result.bridgePresent = inspected.bridgePresent;
  result.bridgeMembers = inspected.bridgeMembers;
  // The global the preload is frozen to expose, for the report's benefit.
  result.bridgeGlobal = "haruyuki";

  if (!inspected.bridgePresent) {
    result.bridgeError = `window.haruyuki is ${inspected.bridgeType}, so the preload did not run`;
  }

  result.nodeAbsent = inspected.nodeLeaks.length === 0;
  result.nodeLeaks = inspected.nodeLeaks;
}

/**
 * Run every stage, then report.
 */
async function main(): Promise<void> {
  await app.whenReady();

  await stageBareWindow();
  await stageShell();

  const passed =
    result.bareWindow === true &&
    result.shellLoaded === true &&
    result.bridgePresent === true &&
    result.nodeAbsent === true;

  finish(passed ? 0 : 1);
}

/**
 * Start.
 *
 * The shell's main process must be imported **before** `app.whenReady()` resolves,
 * because it calls `protocol.registerSchemesAsPrivileged` at module scope and Electron
 * refuses that call after ready. Importing it from inside `main()` -- which only runs
 * once ready -- produced exactly that refusal:
 *
 *   protocol.registerSchemesAsPrivileged should be called before app is ready
 *
 * That is not a bug in the shell; it is a rule about when its module may be evaluated, and
 * the probe was breaking it. Importing first also matches how Electron loads a real main
 * script: once, at startup, before the app is ready.
 */
async function start(): Promise<void> {
  if (SHELL_ENTRY !== undefined) {
    // Import for its side effects only. Its own `whenReady` handler will build the window
    // once the app is ready, which happens after this import returns.
    await import(new URL(`file://${path.resolve(SHELL_ENTRY).replace(/\\/g, "/")}`).href);
  }

  await main();
}

void start().catch((error: unknown) => {
  // A throw here is itself the answer: record it against whichever stage was running.
  if (result.bareWindow === undefined) {
    result.bareWindow = false;
    result.bareError = error instanceof Error ? error.message : String(error);
  } else {
    result.shellLoaded = false;
    result.shellError = error instanceof Error ? error.message : String(error);
  }

  finish(1);
});
