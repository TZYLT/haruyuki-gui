/**
 * The cold start probe: measures how long the shell takes to become usable.
 *
 * `coldstart.mjs` launches this bundle with the Electron binary 20 times; each run starts
 * the real main process and records when both readiness signals had fired.
 *
 *   `ready-to-show`           the window is painted and about to appear
 *   `readyState === "load"`   the renderer document finished loading
 *
 * Both, because either alone is misleading: a window that appears before the page can
 * paint is not usable, and a page that finishes loading behind a hidden window is not
 * visible.
 *
 * The clock starts at the top of this file, which is as close to process start as a
 * script can observe. Electron's own startup happens before this module is evaluated, so
 * the reported figure is a lower bound on true cold start -- recorded here rather than
 * hidden, because a number whose bias is unknown cannot be compared against a budget.
 */

import { app, BrowserWindow } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Captured before any other work, so the measurement includes the import cost. */
const STARTED = Date.now();

/** The built shell entry the caller pointed us at. */
const ENTRY = process.env["HARUYUKI_COLDSTART_ENTRY"];

/**
 * Print the measurement and quit.
 *
 * @param elapsedMs the measured duration
 */
function report(elapsedMs: number): never {
  process.stdout.write(`COLDSTART ${JSON.stringify({ elapsedMs })}\n`);
  app.exit(0);

  throw new Error("unreachable");
}

/**
 * Drive one measurement.
 *
 * The main process is imported rather than spawned as a child, so the measurement covers
 * the real application code without a second process boundary that would need its own
 * synchronisation.
 */
async function main(): Promise<void> {
  if (ENTRY === undefined) {
    process.stderr.write("HARUYUKI_COLDSTART_ENTRY must be set\n");
    app.exit(1);

    return;
  }

  await app.whenReady();

  // Watching for the first window rather than requiring one: the main process creates it,
  // and waiting for a specific reference would depend on how that file is written.
  const deadline = Date.now() + 20_000;

  const observed = await new Promise<{ readyToShow: number; complete: number } | null>(
    (resolve) => {
      /**
       * @param window the window the shell created
       */
      const watch = (window: BrowserWindow): void => {
        let readyToShow = 0;
        let complete = 0;

        window.once("ready-to-show", () => {
          readyToShow = Date.now() - STARTED;
        });

        window.webContents.on("did-finish-load", () => {
          complete = Date.now() - STARTED;
        });

        const poll = setInterval(() => {
          if (readyToShow > 0 && complete > 0) {
            clearInterval(poll);
            resolve({ readyToShow, complete });

            return;
          }

          if (Date.now() > deadline) {
            clearInterval(poll);
            resolve(null);
          }
        }, 5);
      };

      const existing = BrowserWindow.getAllWindows();

      if (existing.length > 0) {
        watch(existing[0]!);
      } else {
        app.once("browser-window-created", (_event, window) => watch(window));
      }

      setTimeout(() => resolve(null), 20_000);
    },
  );

  if (observed === null) {
    process.stderr.write("the shell did not reach both readiness signals within 20 s\n");
    app.exit(1);

    return;
  }

  // The later of the two, per the criterion's definition.
  report(Math.max(observed.readyToShow, observed.complete));
}

// The shell's own entry is imported first so its `whenReady` handling runs, then the
// measurement waits for the window it creates.
void (async () => {
  try {
    await import(pathToFileURL(path.resolve(ENTRY!)).href);
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  }
})();
