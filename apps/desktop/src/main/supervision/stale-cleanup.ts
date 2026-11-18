/**
 * The manual path for a leftover engine the shell will not kill on its own.
 *
 * Boot supervision reclaims a process only when two independent identity facts
 * agree. Everything else becomes a candidate: the
 * process exists, but it might be another shell's engine or an unrelated program,
 * so the decision is left to a human. This module owns that conversation and the
 * single-PID kill that may follow it, and nothing else.
 *
 * Four boundaries are deliberate:
 *
 *   The message box is injected. Electron's dialog is a main-process API; this
 *   module only reads `response`, so it stays table-testable and its tests cannot
 *   need an Electron runtime.
 *
 *   The kill is injected and per-PID. Boot's reclaim kills a tree because the
 *   marker names an engine this shell started. Here the PID is exactly the process
 *   whose identity could not be proven, so a tree kill would reach further than
 *   the evidence does.
 *
 *   Only `response === 0` kills. The default and cancel button are both Cancel,
 *   because the safe answer to "is this process ours" is "no": an accidental
 *   Enter must close the dialog, not end a process.
 *
 *   Every failure is a value, never a throw. A dialog that fails to show and a
 *   kill the OS refuses both have to reach the caller as a readable reason -- the
 *   caller is the only place that can still tell the user (requirement section
 *   4.6: a failed kill must show a readable reason).
 */

import { isProcessAlive } from "@haruyuki/core/supervision";

import type { Logger } from "../log.js";
import type { StaleCandidate } from "./boot.js";

/** The two buttons, in the order the dialog shows them. */
const CONFIRM_BUTTON = 0;
const CANCEL_BUTTON = 1;

/**
 * How long to let the OS retire the process before asking whether it is gone.
 *
 * A termination request is asynchronous even when the signal is delivered
 * synchronously, so an immediate `isProcessAlive` reports a live process that is
 * already dying. This wait is the difference between an honest failure and a
 * false one; it is injected so tests do not spend it.
 */
const DEFAULT_SETTLE_MS = 250;

/** One candidate the kill could not remove, with the reason it stayed. */
export interface StaleCleanupFailure {
  readonly pid: number;
  readonly reason: string;
}

/** What one pass through the dialog did. */
export interface StaleCleanupResult {
  /** True when nothing is left behind: no candidates, cancel, or every kill worked. */
  readonly ok: boolean;
  /** PIDs confirmed gone after the kill. */
  readonly removed: readonly number[];
  /** PIDs that survived, plus a synthetic `pid: 0` entry when the dialog failed. */
  readonly failures: readonly StaleCleanupFailure[];
}

/** The dialog's copy, resolved from the catalogue by the caller. */
export interface StaleCleanupLabels {
  readonly title: string;
  readonly message: (count: number, details: string) => string;
  readonly confirm: string;
  readonly cancel: string;
}

/**
 * The subset of `MessageBoxOptions` this module uses.
 *
 * Structural rather than Electron's type: the module must stay importable without
 * Electron, and the wiring passes `dialog.showMessageBox` which is a superset.
 */
export interface StaleCleanupMessageBoxOptions {
  readonly type: "warning";
  readonly title: string;
  readonly message: string;
  /** Mutable array: Electron's `MessageBoxOptions` takes `string[]`. */
  readonly buttons: string[];
  readonly defaultId: number;
  readonly cancelId: number;
  readonly noLink: boolean;
}

/** `dialog.showMessageBox`, narrowed to the answer this module reads. */
export type StaleCleanupMessageBox = (
  options: StaleCleanupMessageBoxOptions,
) => Promise<{ readonly response: number }>;

/** Everything the dialog needs beyond the candidates themselves. */
export interface StaleCleanupDeps {
  /** Shows the confirmation dialog; injected so the module needs no Electron. */
  readonly showMessageBox: StaleCleanupMessageBox;
  /** Ends one process. Rejects with a readable reason when the OS refuses. */
  readonly kill: (pid: number) => Promise<void>;
  /** Liveness check, defaulting to the core primitive. */
  readonly isAlive?: (pid: number) => boolean;
  /** Waits for the OS to retire the process; injected so tests stay fast. */
  readonly settle?: () => Promise<void>;
  /** Structured, never user-facing. */
  readonly logger?: Logger;
  /** Resolved copy for the dialog. */
  readonly labels: StaleCleanupLabels;
}

/** Error text for a reason, without trusting `error` to be an `Error`. */
function detailOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}

/** Human-readable line for one candidate; paths and reasons stay verbatim. */
function describeCandidate(candidate: StaleCandidate): string {
  const image = candidate.evidence.imagePath ?? "unknown";
  const started = candidate.evidence.createdAt ?? "unknown";

  return `PID ${candidate.pid} | image ${image} | started ${started} | ${candidate.decision} | ${candidate.reason}`;
}

/** Wait `DEFAULT_SETTLE_MS`, used when the caller did not inject a settle. */
function defaultSettle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, DEFAULT_SETTLE_MS);
  });
}

/** Log one failure under the existing stale event; never let logging throw. */
function logFailure(deps: StaleCleanupDeps, failure: StaleCleanupFailure): void {
  try {
    deps.logger?.warn("supervision.stale.failed", {
      state: "cleanup",
      pid: failure.pid,
      reason: failure.reason,
    });
  } catch {
    // A logger that throws must not turn a reported failure into a crash.
  }
}

/**
 * Ask once, then kill the candidates the user confirmed.
 *
 * @param candidates the stale engines from the boot scan
 * @param deps injected dialog, kill, liveness and copy
 * @returns what was removed and what survived, never a rejection
 */
export async function showStaleCleanupDialog(
  candidates: readonly StaleCandidate[],
  deps: StaleCleanupDeps,
): Promise<StaleCleanupResult> {
  // Nothing to decide: do not open an empty dialog the user has to dismiss.
  if (candidates.length === 0) {
    return { ok: true, removed: [], failures: [] };
  }

  const details = candidates.map(describeCandidate).join("\n");
  let response: number;

  try {
    const answer = await deps.showMessageBox({
      type: "warning",
      title: deps.labels.title,
      message: deps.labels.message(candidates.length, details),
      buttons: [deps.labels.confirm, deps.labels.cancel],
      defaultId: CANCEL_BUTTON,
      cancelId: CANCEL_BUTTON,
      noLink: true,
    });

    response = answer.response;
  } catch (error) {
    const failure: StaleCleanupFailure = { pid: 0, reason: "dialog failed" };

    logFailure(deps, { ...failure, reason: `${failure.reason}: ${detailOf(error)}` });

    return { ok: false, removed: [], failures: [failure] };
  }

  if (response !== CONFIRM_BUTTON) {
    return { ok: true, removed: [], failures: [] };
  }

  const isAlive = deps.isAlive ?? isProcessAlive;
  const settle = deps.settle ?? defaultSettle;
  const removed: number[] = [];
  const failures: StaleCleanupFailure[] = [];

  for (const candidate of candidates) {
    const { pid } = candidate;

    try {
      await deps.kill(pid);
      await settle();
    } catch (error) {
      const failure = { pid, reason: detailOf(error) };

      failures.push(failure);
      logFailure(deps, failure);
      continue;
    }

    let alive: boolean;

    try {
      alive = isAlive(pid);
    } catch (error) {
      // "Cannot tell" is not "gone". Treating an unreadable liveness check as
      // success would drop the candidate from the menu while the process runs.
      const failure = { pid, reason: `liveness check failed: ${detailOf(error)}` };

      failures.push(failure);
      logFailure(deps, failure);
      continue;
    }

    if (alive) {
      const failure = { pid, reason: "process is still running after the kill request" };

      failures.push(failure);
      logFailure(deps, failure);
      continue;
    }

    removed.push(pid);
  }

  return { ok: failures.length === 0, removed, failures };
}
