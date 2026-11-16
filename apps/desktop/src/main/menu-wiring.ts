/**
 * The menu's Electron end: build it, set it, and keep it in step with the
 * leftover-engine list.
 *
 * `menu.ts` is the pure half -- it decides what the menu says and whether an item
 * is enabled, and a test can read the whole template without an Electron process.
 * This module is the other half: it owns the Electron imports the menu needs, the
 * native dialogs, and the three side effects behind the Help items. `main.ts`
 * gets one call instead of another block, which is why the block moved here
 * rather than growing the composition root past its size gate.
 *
 * The dependencies are the composition root's facts, passed in rather than read:
 *
 *   `getWindow` is the live window, not a snapshot. The menu is built before the
 *   window exists (`main.ts` order), but the click handlers run later, so the
 *   export item works without the menu having to know when the window appeared.
 *
 *   `getStaleCandidates`/`setStaleCandidates` keep the candidate list owned by
 *   `main.ts`. The menu only ever sees a count; the dialog sees the candidates
 *   and is the only place a kill can originate.
 *
 *   `sessionAvailable` is a function, not a boolean, for the same reason
 *   `main.ts` gives the IPC registration a getter: the answer may change while
 *   the shell runs and a stale snapshot would tell the panel the wrong thing.
 *
 * No item here opens a second window, starts an engine or adds a channel. The
 * export item sends the same `open` message the crash page sends; logs and
 * restart are the app's own APIs; cleanup is only reachable through the dialog.
 */

import { Menu } from "electron";
import type { App, BrowserWindow, Dialog } from "electron";
import type { Locale } from "@haruyuki/ui/i18n/core";

import { openDiagnosticsPanel } from "./diagnostics/ipc.js";
import type { Logger } from "./log.js";
import { buildMenuTemplate, menuLabels } from "./menu.js";
import { APP_NAME } from "./i18n.js";
import type { StaleCandidate } from "./supervision/boot.js";
import { removeStaleCandidates } from "./supervision/boot.js";
import {
  showStaleCleanupDialog,
  type StaleCleanupFailure,
  type StaleCleanupLabels,
  type StaleCleanupResult,
} from "./supervision/stale-cleanup.js";

/** Everything the menu's wiring reads or mutates. */
export interface ApplicationMenuDeps {
  readonly app: App;
  readonly dialog: Dialog;
  /** The directory that owns `runtime-stale-*.json`. */
  readonly userData: string;
  /** The locale resolved for this launch; every Help label comes from it. */
  readonly locale: Locale;
  /** The inspector gate, shared with `webPreferences.devTools`. */
  readonly devtoolsAllowed: () => boolean;
  /** The live window, or null before it exists / after it closed. */
  readonly getWindow: () => BrowserWindow | null;
  /** The candidates from the last boot scan; `main.ts` owns the list. */
  readonly getStaleCandidates: () => readonly StaleCandidate[];
  /** Replaces the candidate list after a cleanup pass. */
  readonly setStaleCandidates: (next: readonly StaleCandidate[]) => void;
  /** Whether a session source is registered, read at click time. */
  readonly sessionAvailable: () => boolean;
  readonly logger?: Logger;
}

/** Error text for a log detail, without trusting `error` to be an `Error`. */
function detailOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

/** Log a failed menu action; never let logging replace the failure. */
function logActionFailure(deps: ApplicationMenuDeps, action: string, error: unknown): void {
  try {
    deps.logger?.warn("menu.action.failed", { action, detail: detailOf(error) });
  } catch {
    // The action already failed; a throwing logger is not a second problem.
  }
}

/** Ask the live window to show the diagnostics panel. */
function exportDiagnostics(deps: ApplicationMenuDeps): void {
  const window = deps.getWindow();

  // No window means no panel to open. The menu stays enabled because the window
  // is created moments after the menu is set; a click in that gap is a no-op
  // rather than an error the user did not cause.
  if (window === null || window.isDestroyed()) {
    deps.logger?.info("diagnostics.panel.open", { state: "no-window" });
    return;
  }

  if (!openDiagnosticsPanel(window.webContents, deps.sessionAvailable())) {
    deps.logger?.warn("diagnostics.panel.open", { state: "send-failed" });
  }
}

/** Show the outcome of a cleanup pass, without letting a dialog failure matter. */
async function reportCleanup(
  deps: ApplicationMenuDeps,
  labels: ReturnType<typeof menuLabels>,
  result: StaleCleanupResult,
): Promise<void> {
  const failures = result.failures.filter((failure) => failure.pid > 0);

  try {
    if (failures.length > 0) {
      // The reason has to reach the user: a killed-nothing dialog that only
      // logged would leave "I clicked it and nothing happened".
      await deps.dialog.showMessageBox({
        type: "warning",
        title: labels.cleanupFailed,
        message: labels.cleanupFailed,
        detail: failures.map((failure) => `PID ${failure.pid}: ${failure.reason}`).join("\n"),
        buttons: [labels.close],
      });
      return;
    }

    if (result.removed.length > 0) {
      await deps.dialog.showMessageBox({
        type: "info",
        title: labels.cleanupDone(result.removed.length),
        message: labels.cleanupDone(result.removed.length),
        buttons: [labels.close],
      });
    }
  } catch (error) {
    logActionFailure(deps, "cleanup-report", error);
  }
}

/** One cleanup pass: confirm, kill what was confirmed, then rebuild the menu. */
async function cleanupStale(deps: ApplicationMenuDeps, rebuild: () => void): Promise<void> {
  const labels = menuLabels(deps.locale);
  const cleanupLabels: StaleCleanupLabels = {
    title: labels.cleanupTitle,
    message: labels.cleanupMessage,
    confirm: labels.cleanupConfirm,
    cancel: labels.cleanupCancel,
  };
  try {
    const candidates = deps.getStaleCandidates();
    const result = await showStaleCleanupDialog(candidates, {
      showMessageBox: (options) => deps.dialog.showMessageBox(options),
      // Per-PID on purpose: the candidate is exactly the process whose identity
      // could not be proven, so a tree kill would reach beyond the evidence.
      kill: async (pid) => {
        process.kill(pid);
      },
      labels: cleanupLabels,
      // `exactOptionalPropertyTypes` distinguishes "absent" from "undefined",
      // and the dialog's logger is genuinely optional.
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    });

    logFailures(deps, result.failures);

    // A failure stays a candidate: the process is still there, so the menu must
    // still offer it. A removed one drops out, and a rebuild re-reads the count.
    const handled = new Set([...result.removed, ...result.failures.map((failure) => failure.pid)]);
    const remaining = candidates.filter((candidate) => !handled.has(candidate.pid));

    // The process is confirmed gone only for `removed`; delete the matching
    // stale file so a later boot does not resurrect a cleaned candidate
    // (RD-08: cleanup success deletes the record).
    const failedFiles = await removeStaleCandidates(deps.userData, candidates, result.removed);

    for (const file of failedFiles) {
      logActionFailure(deps, "cleanup-stale-file", file);
    }

    if (result.removed.length > 0 || result.ok) {
      deps.setStaleCandidates(remaining);
      rebuild();
    }

    await reportCleanup(deps, labels, result);
  } catch (error) {
    // The dialog promises never to throw; this guards the wiring's own steps
    // (a template rebuild, a list replacement) so the `void` call above cannot
    // turn into an unhandled rejection.
    logActionFailure(deps, "cleanup", error);
  }
}

/** Log each real failure; the dialog-failure case has no candidate to log. */
function logFailures(deps: ApplicationMenuDeps, failures: readonly StaleCleanupFailure[]): void {
  for (const failure of failures) {
    if (failure.pid <= 0) continue;

    try {
      deps.logger?.warn("menu.action.failed", {
        action: "cleanup",
        pid: failure.pid,
        reason: failure.reason,
      });
    } catch {
      // Same rule as elsewhere: logging must not mask the failure.
    }
  }
}

/**
 * Build and install the menu, and return the rebuild hook for the cleanup path.
 *
 * @param deps the composition root's facts and the Electron APIs the menu uses
 * @returns the rebuild function, so a caller can refresh the count on demand
 */
export function installApplicationMenu(deps: ApplicationMenuDeps): { rebuild(): void } {
  const rebuild = (): void => {
    const template = buildMenuTemplate({
      isDevelopment: !deps.app.isPackaged,
      devtoolsAllowed: deps.devtoolsAllowed(),
      appName: APP_NAME,
      locale: deps.locale,
      staleCount: deps.getStaleCandidates().length,
      onExportDiagnostics: () => {
        exportDiagnostics(deps);
      },
      onCleanupStale: () => {
        void cleanupStale(deps, rebuild);
      },
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  rebuild();

  return { rebuild };
}
