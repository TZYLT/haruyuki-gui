/**
 * Shell glue for the three retention sweeps.
 *
 * `retention.ts` owns the policy and deliberately knows nothing about logging or
 * Electron paths. This module is the one production caller: it turns the three
 * `StartupCleanupResult` sections into the stable log events from `32` section
 * 6.3 and never lets a sweep failure escape into the boot or export path.
 *
 * Two calls exist by requirement: once after settings load and once before an
 * export. Keeping both here is what makes "the cleanup ran" a fact a reader can
 * find, instead of a comment next to an unused export.
 */

import type { LogRetention } from "../settings.js";
import { runStartupCleanup, type CleanupFailure, type StartupCleanupResult } from "./retention.js";

/** The shell's log sink; a throwing logger must not break cleanup. */
export type CleanupLog = (event: string, detail?: Record<string, unknown>) => void;

/** Everything a sweep needs from the composition root. */
export interface ShellCleanupOptions {
  readonly logsDir: string;
  readonly crashDir: string;
  readonly crashDumpsDir: string;
  readonly logs?: LogRetention;
  readonly onLog: CleanupLog;
  readonly now?: Date;
}

/** One compact log record for a completed section. */
function logSweep(
  log: CleanupLog,
  event: "logs.cleanup" | "crash.cleanup" | "minidump.cleanup",
  sweep: {
    readonly deleted: readonly string[];
    readonly bytesBefore: number;
    readonly bytesAfter: number;
  },
): void {
  try {
    log(event, {
      deleted: sweep.deleted.length,
      bytesBefore: sweep.bytesBefore,
      bytesAfter: sweep.bytesAfter,
    });
  } catch {
    // Retention must not fail because its own report failed.
  }
}

/** Log each section's failure under the event a reader already knows. */
function logFailures(log: CleanupLog, failures: readonly CleanupFailure[]): void {
  for (const failure of failures) {
    const event =
      failure.section === "logs"
        ? "logs.cleanup"
        : failure.section === "crashes"
          ? "crash.cleanup"
          : "minidump.cleanup";

    try {
      log(event, { state: "failed", detail: failure.error });
    } catch {
      // Same rule as above.
    }
  }
}

/**
 * Run all three sweeps and log what happened.
 *
 * Returns the raw result so a caller may assert on it; production ignores it.
 * `runStartupCleanup` already isolates each section; this wrapper only adds
 * logging and a final guard around a hostile logger.
 *
 * @param options directories, the optional `logs` setting and the log sink
 */
export async function runShellCleanup(options: ShellCleanupOptions): Promise<StartupCleanupResult> {
  const { onLog, ...sweep } = options;
  const result = await runStartupCleanup(sweep);

  if (result.logs !== null) logSweep(onLog, "logs.cleanup", result.logs);
  if (result.crashes !== null) logSweep(onLog, "crash.cleanup", result.crashes);
  if (result.minidumps !== null) logSweep(onLog, "minidump.cleanup", result.minidumps);

  logFailures(onLog, result.failures);

  return result;
}
