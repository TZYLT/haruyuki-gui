/**
 * What one activation owns, and the order its teardown has to happen in.
 *
 * The editor waits on `deactivate`'s promise but gives up after a few seconds,
 * so a teardown that waits for a hung child is worse than one that reports the
 * wait and continues: the window is gone either way, and both a leaked token
 * file and a silently killed deactivation are defects. This module therefore
 * runs the same fixed sequence against a single deadline:
 *
 *   1. close the panel (optional -- a window that never opened one has none)
 *   2. stop the core child, which stops the engine first and waits for its exit
 *   3. remove the one capability-token file the engine wrote into `tokenDir`
 *   4. render the status bar idle
 *
 * The order is the contract, not a detail: the token file is deleted only after
 * the process that reads it is gone, and the status bar says "inactive" only
 * once the cleanup is over.
 *
 * Three properties this module is written to hold:
 *
 * - The whole sequence settles inside a 3 second budget (see
 *   {@link DEFAULT_DISPOSE_BUDGET_MS}). A step that outlives its slice is
 *   reported and abandoned, never awaited forever, so `deactivate` always
 *   settles. The budget is split rather than first-come-first-served: the core
 *   keeps a reserved slice, because a webview that hangs on close must not
 *   consume the time the child needs to shut down.
 * - It is idempotent. The second call joins the first one's promise and starts
 *   no second teardown; neither call throws.
 * - It is single-use. Deactivation is the end of an activation, so a caller
 *   that activates again constructs another instance instead of reusing this
 *   one (the entry clears its own reference, see `../extension.ts`).
 *
 * The token file is deleted at exactly one known path -- `<tokenDir>/<name>` --
 * with a single-file removal. There is no directory sweep and no pattern match
 * anywhere in this module: a bug here would turn a shutdown into an arbitrary
 * delete, and the path is injected precisely so that cannot be guessed.
 *
 * Every collaborator is injected, so the whole sequence is exercised against
 * doubles in a plain Node process, including the budget that fires only when a
 * child never exits.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ShellLog } from "./log.js";
import type { StatusBar } from "./status.js";

/**
 * Total budget for one teardown.
 *
 * The editor's own ceiling on `deactivate` is a few seconds; three leaves room
 * for the work to be abandoned and reported before that ceiling is reached, so
 * a slow shutdown is logged rather than truncated with no evidence.
 */
export const DEFAULT_DISPOSE_BUDGET_MS = 3_000;

/**
 * Slice of the budget held back for stopping the core child.
 *
 * The panel step may use the rest. Without this, a webview whose `close` never
 * settles would leave the child running with nothing to stop it -- the one
 * failure mode this ordering exists to prevent.
 */
const CORE_STOP_RESERVE_MS = 1_000;

/**
 * The engine's own fixed file name for its capability token, inside `tokenDir`.
 *
 * Deliberately a literal here: the extension host bundle must not value-import
 * the core package for one constant. `__tests__/lifecycle.test.ts` imports the
 * engine's constant and asserts the two agree, so the duplication cannot drift.
 */
export const TOKEN_FILE_NAME = "engine-token";

/** The one operation this module needs of the core child. */
export type LifecycleCoreHost = {
  /** Ask the child to shut down and resolve once it has exited. Idempotent. */
  stop(): Promise<void>;
};

/** The one operation it needs of the panel. */
export type LifecyclePanel = {
  /** Release the panel and everything it owns. */
  close?(): Promise<void>;
};

/** Diagnostic sink: codes and words, never a payload. */
export type LifecycleLog = Pick<ShellLog, "event" | "failure">;

/** The status-bar sink. Rendering one state is all a teardown does to it. */
export type LifecycleStatus = Pick<StatusBar, "set">;

/** Everything one teardown needs, all of it injected. */
export type LifecycleOptions = {
  /**
   * The core child this activation started.
   *
   * Absent means no child was started, which is the normal state of a window
   * where nothing was ever opened; the sequence then skips its step.
   */
  readonly coreHost?: LifecycleCoreHost | undefined;
  /** The panel this activation opened, if any. */
  readonly panel?: LifecyclePanel | undefined;
  /** The log to report steps to. Absent means there is nowhere to report to. */
  readonly log?: LifecycleLog | undefined;
  /** The status bar to render idle. */
  readonly status?: LifecycleStatus | undefined;
  /**
   * The directory the engine writes its capability token into.
   *
   * Injected, never composed here: only the code that started the engine knows
   * where its token went. Absent means this shell owns no token file.
   */
  readonly tokenDir?: string | undefined;
  /** Override for the total budget; see {@link DEFAULT_DISPOSE_BUDGET_MS}. */
  readonly deadlineMs?: number | undefined;
};

/** The handle the entry keeps for one activation. */
export interface Lifecycle {
  /** Run the sequence once. Never rejects; resolves within the budget. */
  dispose(): Promise<void>;
  /**
   * Start the same sequence without waiting for it.
   *
   * For a host that cannot await -- a process-exit hook, say. The steps are
   * started in the same order, but nothing is waited for, so the ordering is a
   * best effort and the token file is removed before the child is known dead.
   * {@link dispose} is the contract; this exists only for the caller that has
   * no way to hold a promise.
   */
  disposeSync(): void;
}

/** A log that swallows everything, for a teardown with nowhere to report to. */
const NOOP_LOG: LifecycleLog = {
  event(): void {
    return undefined;
  },
  failure(): void {
    return undefined;
  },
};

/** One step of the sequence, with the failure code it reports to the log. */
type Step = {
  readonly name: string;
  readonly failureCode: string;
  readonly budgetMs: number;
};

/** Milliseconds left until the deadline, never negative. */
function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * Build the teardown for one activation.
 *
 * @param options the injected collaborators and the budget
 * @returns the handle; the sequence is not started until it is called
 */
export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const coreHost = options.coreHost;
  const panel = options.panel;
  const log = options.log ?? NOOP_LOG;
  const status = options.status;
  const tokenDir = options.tokenDir;
  const budgetMs = options.deadlineMs ?? DEFAULT_DISPOSE_BUDGET_MS;

  /**
   * The running or finished teardown.
   *
   * Set synchronously before the first await, so a second call -- even one made
   * while the first is still in flight -- joins it instead of starting another.
   */
  let pending: Promise<void> | undefined;

  /**
   * Run one step, waiting at most for its slice of the budget.
   *
   * A step that outlives its slice is reported and abandoned: its promise stays
   * handled (the race attached a handler), so a later rejection cannot surface
   * as an unhandled one, and the sequence continues with the next step.
   *
   * @param step the step, its failure code and its slice
   * @param work the step itself, called once
   */
  async function runStep(step: Step, work: () => Promise<void> | void): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), step.budgetMs);
    });

    try {
      const settled = await Promise.race([
        Promise.resolve()
          .then(work)
          .then(() => "done"),
        expired,
      ]);

      if (settled === "expired") {
        log.event("LIFECYCLE_STEP_TIMEOUT", { step: step.name, budgetMs: step.budgetMs });
      }
    } catch (error) {
      log.failure(step.failureCode, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Start one step now, handling its outcome without waiting for it.
   *
   * Called synchronously rather than on a microtask: the one caller is a hook
   * that cannot await, and a step started "later" would be a step that never
   * started if that hook is the last thing the process does.
   *
   * @param failureCode the code a rejection is reported with
   * @param work the step itself
   */
  function startStep(failureCode: string, work: () => Promise<void> | void): void {
    try {
      void Promise.resolve(work()).catch((error: unknown) => {
        log.failure(failureCode, error);
      });
    } catch (error) {
      // A step that throws before it returns a promise has the same outcome.
      log.failure(failureCode, error);
    }
  }

  /**
   * Remove the engine's token file, and only that file.
   *
   * One absolute path, derived from the injected directory and the engine's own
   * fixed name. `force` makes a file that was never written a success rather
   * than a failure, which is the honest answer: the secret is gone either way.
   */
  function removeTokenFile(): void {
    if (tokenDir === undefined) {
      log.event("LIFECYCLE_TOKEN_NOT_OWNED");

      return;
    }

    const file = join(tokenDir, TOKEN_FILE_NAME);

    try {
      const existed = existsSync(file);

      // Single file, single path: never recursive, never a pattern.
      rmSync(file, { force: true });

      log.event(existed ? "LIFECYCLE_TOKEN_REMOVED" : "LIFECYCLE_TOKEN_ABSENT", { file });
    } catch (error) {
      log.failure("LIFECYCLE_TOKEN_REMOVE_FAILED", error);
    }
  }

  /** The whole sequence, awaited. */
  async function runDispose(): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;

    log.event("LIFECYCLE_DISPOSE_STARTED", { budgetMs });

    if (panel?.close !== undefined) {
      const reserve = Math.min(CORE_STOP_RESERVE_MS, Math.floor(budgetMs / 3));

      await runStep(
        {
          name: "panel-close",
          failureCode: "PANEL_CLOSE_FAILED",
          budgetMs: Math.max(0, remaining(deadline) - reserve),
        },
        () => panel.close?.(),
      );
    }

    if (coreHost !== undefined) {
      await runStep(
        { name: "core-stop", failureCode: "CORE_STOP_FAILED", budgetMs: remaining(deadline) },
        // `stop` resolves after the child has exited, so the token file below
        // is removed only once nothing is left reading it.
        () => coreHost.stop(),
      );
    }

    removeTokenFile();
    status?.set("inactive");

    const elapsedMs = Date.now() - startedAt;

    if (elapsedMs > budgetMs) {
      log.event("LIFECYCLE_BUDGET_EXCEEDED", { elapsedMs, budgetMs });
    }

    log.event("LIFECYCLE_DISPOSED", { elapsedMs, budgetMs });
  }

  /** The same sequence, started but never awaited. */
  function runDisposeSync(): void {
    const startedAt = Date.now();

    log.event("LIFECYCLE_DISPOSE_STARTED", { budgetMs, sync: true });

    if (panel?.close !== undefined) {
      startStep("PANEL_CLOSE_FAILED", () => panel.close?.());
    }

    if (coreHost !== undefined) {
      startStep("CORE_STOP_FAILED", () => coreHost.stop());
    }

    removeTokenFile();
    status?.set("inactive");

    log.event("LIFECYCLE_DISPOSED", {
      elapsedMs: Date.now() - startedAt,
      budgetMs,
      sync: true,
    });
  }

  return {
    dispose(): Promise<void> {
      if (pending !== undefined) {
        log.event("LIFECYCLE_DISPOSE_IGNORED");

        return pending;
      }

      // Reported rather than rejected: the editor is shutting down, and a
      // teardown that throws here would be a crash on the way out.
      pending = runDispose().catch((error: unknown) => {
        log.failure("LIFECYCLE_DISPOSE_FAILED", error);
      });

      return pending;
    },

    disposeSync(): void {
      if (pending !== undefined) {
        log.event("LIFECYCLE_DISPOSE_IGNORED");

        return;
      }

      // The no-op promise marks the teardown as taken, so a later `dispose`
      // reports instead of running a second one over the same collaborators.
      pending = Promise.resolve();

      try {
        runDisposeSync();
      } catch (error) {
        log.failure("LIFECYCLE_DISPOSE_FAILED", error);
      }
    },
  };
}
