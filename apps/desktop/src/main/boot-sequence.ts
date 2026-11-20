/**
 * The part of the boot that happens before anything is shown.
 *
 * Extracted from the composition root without changing it: the same three calls
 * in the same order, with the same inputs and the same failure behaviour. It
 * lives here because the root had reached its line limit and this is the block
 * that reads as a unit - load the settings, sweep what a previous run left
 * behind, then clear a stale engine out of the way before the menu can ask about
 * it.
 *
 * Why the sweep is duplicated as a separate export: the same call is made again
 * later, from the menu's cleanup entry, against whatever settings are in force by
 * then. Both call it with the same shape, so the shape lives here once.
 */

import { app } from "electron";

import { crashDirFor } from "./crash/records.js";
import { runShellCleanup } from "./diagnostics/cleanup.js";
import { loadSettings } from "./settings-io.js";
import type { ShellSettings } from "./settings.js";
import { runBootSupervision, type StaleCandidate } from "./supervision/boot.js";
import type { Logger } from "./log.js";

/** What the boot sweep and supervision need, named the way the root names it. */
export interface BootFacts {
  readonly userData: string;
  readonly logSupervision: (event: string, detail?: Record<string, unknown>) => void;
  readonly logger: Logger | null;
}

/** What the boot produced, for the root to keep. */
export interface BootOutcome {
  readonly settings: ShellSettings;
  readonly settingsWritable: boolean;
  readonly staleCandidates: readonly StaleCandidate[];
}

/**
 * Sweep, then clear a stale engine out of the way, then report what was kept.
 *
 * Order matters and is unchanged: retention before supervision, so a stale engine
 * is gone, or listed, before the user can ask about it. A failed sweep is a log
 * line and never aborts the boot; the supervision failures are logged inside and
 * never abort it either.
 *
 * @param facts the root's paths and logging
 * @returns the settings to run under and the candidates the menu lists
 */
export async function runBootSequence(facts: BootFacts): Promise<BootOutcome> {
  const loaded = await loadSettings(facts.logger);

  await runShellCleanup({
    logsDir: app.getPath("logs"),
    crashDir: crashDirFor(facts.userData),
    crashDumpsDir: app.getPath("crashDumps"),
    ...(loaded.settings.logs === undefined ? {} : { logs: loaded.settings.logs }),
    onLog: facts.logSupervision,
  });

  const boot = await runBootSupervision({
    userData: facts.userData,
    appVersion: app.getVersion(),
    onLog: facts.logSupervision,
  });

  facts.logger?.info("supervision.boot", {
    stale: boot.stale.length,
    reclaimed: boot.reclaimed.length,
    candidates: boot.stale.map((candidate) => candidate.pid),
  });

  return {
    settings: loaded.settings,
    settingsWritable: loaded.writable,
    staleCandidates: boot.stale,
  };
}

/**
 * The same sweep, against the settings in force now.
 *
 * Called from the menu's cleanup entry, which can run long after boot and after
 * the user has changed where logs go. Kept beside the boot version so the two
 * cannot drift into sweeping different directories.
 *
 * @param facts the root's paths and logging
 * @param settings the settings in force at the moment of the request
 */
export async function sweepShell(facts: BootFacts, settings: ShellSettings): Promise<void> {
  await runShellCleanup({
    logsDir: app.getPath("logs"),
    crashDir: crashDirFor(facts.userData),
    crashDumpsDir: app.getPath("crashDumps"),
    ...(settings.logs === undefined ? {} : { logs: settings.logs }),
    onLog: facts.logSupervision,
  });
}
