/**
 * The last-resort failure surface.
 *
 * These three operations are separate from `main.ts` for one reason: they are a
 * closed procedure (write a page, show it, drain the log, exit), not startup
 * wiring. Keeping them here also keeps the entry point under the file-size gate
 * as C4 and D4 add their own startup steps.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";

import { bootstrapErrorHtml, type BootstrapFailure } from "./bootstrap-error.js";
import type { Logger } from "./log.js";

/** How long a boot failure waits for its log line before exiting anyway. */
const BOOT_FLUSH_TIMEOUT_MS = 2000;

/** The temporary page from the most recent failure, if one was written. */
let bootstrapPagePath: string | null = null;

/** What the page needs from the entry point. */
export interface BootstrapSurfaceDeps {
  readonly preloadPath: string;
  readonly logger: Logger | null;
}

/**
 * Show the failure page and report whether it was actually visible.
 *
 * It is loaded from a temporary file rather than a `data:` URL: on this
 * development machine a window pointed at `data:` dies with `0xC0000003` before
 * painting (`E-61`), and a failure page that crashes is worse than the blank
 * window it replaces.
 *
 * @param failure what to report
 * @param target an existing window to reuse, or `undefined` to make one
 * @param deps the preload path and logger at call time
 */
export async function showBootstrapError(
  failure: BootstrapFailure,
  target: BrowserWindow | undefined,
  deps: BootstrapSurfaceDeps,
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
        webPreferences: {
          preload: deps.preloadPath,
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
    deps.logger?.error("shell.bootstrap-error.failed", { detail: String(error) });

    return false;
  }
}

/**
 * Report a failure that happened before the window could show a page.
 *
 * The log write is awaited before the page: `app.exit()` terminates without
 * draining anything, and the one line that explains a failed launch is the line
 * most likely to be lost.
 *
 * @param event short stable identifier
 * @param detail human-readable detail
 * @param deps the preload path and logger at call time
 */
export async function failBoot(
  event: string,
  detail: string,
  deps: BootstrapSurfaceDeps,
): Promise<void> {
  process.stderr.write(`[haruyuki] ${event}: ${detail}\n`);

  const logDir = deps.logger === null ? undefined : app.getPath("logs");

  if (logDir !== undefined) process.stderr.write(`[haruyuki] log: ${logDir}\n`);

  deps.logger?.error(event, { detail });

  if (deps.logger !== null) {
    await Promise.race([
      deps.logger.flush(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, BOOT_FLUSH_TIMEOUT_MS);
      }),
    ]);
  }

  const shown = await showBootstrapError(
    {
      event,
      detail,
      ...(logDir === undefined ? {} : { logPath: logDir }),
    },
    undefined,
    deps,
  );

  if (shown) return;

  app.exit(1);
}

/**
 * Delete the failure page's temporary file, if one was written.
 *
 * Best effort and silent: it runs during shutdown, where there is no one to tell
 * and nothing to fall back to.
 */
export async function removeBootstrapPage(): Promise<void> {
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
