/**
 * The bootstrap-failure probe: does the shell's failure page actually appear?
 *
 * `verify-bootstrap-error.mjs` launches this bundle with the renderer bundle moved
 * away, so the shell's own `loadURL` fails the way a broken build makes it fail.
 * The probe then reads what the window is showing.
 *
 * It drives the real shell by importing its built entry, rather than recreating a
 * window: the question is whether *the shell* shows the page, and a probe that
 * built its own window would answer a question nobody asked.
 *
 * Reported fields, all observed from inside the main process:
 *
 *   windowAppeared  a window exists at all -- a blank shell is the failure mode
 *   documentText    what `document.body.innerText` says
 *   hasEvent        whether that text names an event code
 *   hasLogPath      whether it says where the log is
 */

import { app, BrowserWindow } from "electron";
import { createRequire } from "node:module";
import path from "node:path";

/** What the probe reports. */
interface BootResult {
  windowAppeared?: boolean;
  documentText?: string;
  hasEvent?: boolean;
  hasLogPath?: boolean;
  title?: string;
  error?: string;
}

/** The result, filled in as the probe proceeds. */
const result: BootResult = {};

/**
 * The shell's built main entry.
 *
 * The probe bundle lands in `dist/probe/` and the shell in `dist/main/`, so this
 * is one directory up and across -- not a sibling. Getting it wrong reports "no
 * window appeared", which is the same message a broken shell gives.
 */
const SHELL_ENTRY = path.join(__dirname, "..", "main", "main.cjs");

/**
 * `require`, because the shell is a CommonJS bundle at a Windows absolute path.
 *
 * The first version used `await import(SHELL_ENTRY)`, which the bundler turns into
 * a dynamic ESM import: that loader rejects a bare `J:\...` path ("Only URLs with a
 * scheme in: file, data, node, and electron are supported"), so the probe reported
 * "no window appeared" when the real problem was that it never loaded the shell.
 * In a CJS bundle `require` reads the path as written.
 */
const requireShell = createRequire(__filename);

/**
 * Print the result and quit.
 *
 * `app.exit` terminates without draining stdout, so the write takes a callback --
 * the same mistake that once made this probe do all its work and print nothing.
 *
 * @param code process exit code
 */
function finish(code: number): void {
  process.stdout.write(`BOOTRESULT ${JSON.stringify(result)}\n`, () => {
    app.exit(code);
  });
}

/**
 * Wait for the shell's window.
 *
 * @param timeoutMs how long to wait
 * @returns the window, or null
 */
async function waitForWindow(timeoutMs: number): Promise<BrowserWindow | null> {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve) => {
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
}

/**
 * Wait until the window's body has text, or give up.
 *
 * Polling rather than listening for `did-finish-load`: the shell loads a 404 body
 * first (which fires that event with an empty document) and only then swaps in the
 * failure page. An event-based wait returns on the first, empty load and reports
 * the blank window the probe exists to catch.
 *
 * @param window the shell's window
 * @param timeoutMs how long to wait
 * @returns the visible text, or an empty string
 */
async function waitForText(window: BrowserWindow, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const text = (await window.webContents
      .executeJavaScript("document.body?.innerText ?? ''", true)
      .catch(() => "")) as string;

    if (text.trim().length > 0) return text;

    if (Date.now() > deadline) return "";

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
  }
}

async function main(): Promise<void> {
  // The shell's entry registers the privileged scheme, but it must be loaded
  // before `whenReady` or Electron ignores the registration when `standard: true`.
  // So it is loaded first, and only then is the app awaited -- the shell's own
  // `whenReady` continuation runs alongside this function's.
  requireShell(SHELL_ENTRY);

  await app.whenReady();

  const window = await waitForWindow(20_000);

  if (window === null) {
    result.error = "the shell created no window within 20 s";
    finish(1);

    return;
  }

  result.windowAppeared = true;
  result.title = window.getTitle();

  // The window appears when it is *created*, before `loadURL` has finished -- so
  // reading the DOM once here catches the blank document and reports the failure
  // the probe was meant to detect. Waiting for text is the only reliable signal:
  // the shell replaces the 404 body with the failure page once it notices.
  const text = await waitForText(window, 20_000);

  result.documentText = text;
  result.hasEvent = /shell\.page\.failed|shell\.boot\.failed|failed to start/.test(text);
  result.hasLogPath = /log/i.test(text);

  finish(text.trim().length > 0 ? 0 : 1);
}

void main().catch((error: unknown) => {
  result.error = error instanceof Error ? error.message : String(error);
  finish(1);
});
