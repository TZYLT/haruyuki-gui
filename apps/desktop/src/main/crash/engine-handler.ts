/**
 * The engine-crash callback, as a value rather than a `main.ts` function.
 *
 * The callback is a sequence (remember the record, log it, show the page or say
 * why it cannot be shown) and its dependencies are the window and logger that
 * `main.ts` already owns. Keeping the sequence here leaves the entry point to
 * wire the dependencies.
 */

import type { BrowserWindow } from "electron";

import { engineCrashQuery } from "./page.js";
import { showCrashPage } from "./wiring.js";
import { APP_SCHEME } from "../protocol.js";
import type { CrashRecord } from "./records.js";

export interface EngineCrashHandlerDeps {
  readonly setLastCrash: (record: CrashRecord) => void;
  readonly getWindow: () => BrowserWindow | null;
  readonly log: (event: string, detail?: Record<string, unknown>) => void;
}

/** Build the `onCrash` callback installed on the engine host. */
export function createEngineCrashHandler(
  deps: EngineCrashHandlerDeps,
): (record: CrashRecord) => void {
  return (record) => {
    deps.setLastCrash(record);

    const exitCode = record.engine?.exitCode ?? null;
    const signal = record.engine?.signal ?? null;

    deps.log("supervision.engine.crash", { code: record.code, exitCode, signal });

    const window = deps.getWindow();

    if (window === null) {
      deps.log("shell.crash.page", {
        state: "skipped",
        kind: "engine",
        detail: "no window is open",
      });

      return;
    }

    void showCrashPage(
      window,
      engineCrashQuery({
        code: exitCode,
        signal,
        watchdog: record.engine?.watchdog ?? "unknown",
      }),
      "engine",
      APP_SCHEME,
      deps.log,
    );
  };
}
