/**
 * Child-process accounting of one hosted engine attempt.
 *
 * Split out of `engine.ts` (E-142): spawning, subscribing, classifying a child
 * fault and recording the exit fact is one responsibility — *we watch the
 * process* — and it is separate from *the engine tells us things* (watchdog) and
 * from *the socket accepted us* (socket session).
 *
 * Invariants this module keeps (B1 `no recursive` section 3.3 (e)/(f), `R-062`):
 *
 * - A start-time fault goes through the attempt's `FaultSignal`, so the pending
 *   step fails immediately instead of waiting for its own timeout.
 * - A fault after `ready` is a crash and is handed to the facade, which owns the
 *   single state machine. This module never transitions anything itself.
 * - `lastExit` records, it does not classify: crash detection stays
 *   `state === "failed"` (`R-062`-3/6).
 * - The stderr tail is fed by the ONE reader in `spawn.ts`; subscribing here
 *   never creates a second reader .
 */

import type { ChildProcess } from "node:child_process";

import {
  killProcess,
  onProcessError,
  onProcessExit,
  onProcessStderr,
  startEngineProcess,
} from "./spawn";
import { codeOf, EngineStartError, messageOf, FaultSignal } from "./start-internals";
import { StderrTail } from "./stderr-tail";
import type {
  EngineError,
  EngineErrorCode,
  EngineExitInfo,
  EngineSpawnSpec,
  EngineState,
} from "./types";

/** What the facade owns while this module owns the process. */
export interface ChildWatchHost {
  /** Read live: a fault raised during `start` must see the current state. */
  getState(): EngineState;
  /** True while the facade itself is taking the process down. */
  isStopping(): boolean;
  /** Hand a crash to the single state machine. */
  declareFailure(error: EngineError): void;
}

export class ChildWatch {
  #child: ChildProcess | null = null;

  #fault: FaultSignal | null = null;

  #unsubscribers: Array<() => void> = [];

  #lastExit: EngineExitInfo | null = null;

  /** Bounded stderr tail, fed by the single reader in `spawn.ts`. */
  readonly #stderr = new StderrTail();

  /** Reset the per-attempt observations; the process itself is cleared by stop. */
  reset(): void {
    this.#lastExit = null;
    this.#stderr.clear();
  }

  get child(): ChildProcess | null {
    return this.#child;
  }

  get fault(): FaultSignal | null {
    return this.#fault;
  }

  get lastExit(): EngineExitInfo | null {
    return this.#lastExit;
  }

  get pid(): number | null {
    return this.#child?.pid ?? null;
  }

  /** Adopt this attempt's fault signal (one per attempt). */
  set fault(fault: FaultSignal | null) {
    this.#fault = fault;
  }

  stderrTail(limit?: number): readonly string[] {
    return this.#stderr.snapshot(limit);
  }

  /**
   * Start the child with the token PATH appended to `argvPrefix`.
   *
   * The spec is copied field by field instead of mutated: the host port owns its
   * spec object, and a mutated `argvPrefix` would grow by one element on every
   * restart. The token path is the last prefix element because the host port's
   * prefix already ends with the `--ws-token-file` option name.
   */
  spawn(spec: EngineSpawnSpec, tokenFilePath: string): ChildProcess {
    const childSpec: EngineSpawnSpec = {
      exePath: spec.exePath,
      env: spec.env,
      argvPrefix: [...spec.argvPrefix, tokenFilePath],
      bundlePath: spec.bundlePath,
      cwd: spec.cwd,
      stdio: "pipe",
      windowsHide: spec.windowsHide,
      detached: spec.detached,
    };

    try {
      const child = startEngineProcess(childSpec);

      // Subscribe immediately after spawn, while the child is still starting.
      // `onProcessStderr` adds a listener to the single reader in `spawn.ts`; it
      // does not create a second reader .
      this.#unsubscribers.push(
        onProcessStderr(child, (chunk) => {
          this.#stderr.push(chunk);
        }),
      );

      this.#child = child;
      return child;
    } catch (error) {
      throw new EngineStartError(
        "SPAWN_FAILED",
        `could not start the engine process: ${messageOf(error)}`,
      );
    }
  }

  /** Terminate the child without waiting; the emergency path must not block. */
  kill(child: ChildProcess): void {
    killProcess(child);
  }

  /** Take the child out of this module's hands, leaving the field empty. */
  takeChild(): ChildProcess | null {
    const child = this.#child;
    this.#child = null;
    return child;
  }

  /**
   * Subscribe to the child's `error` and `exit` events.
   *
   * A start-time fault is routed through the signal so the pending step fails
   * immediately; a fault after `ready` is a crash and moves the facade to
   * `failed` (section 3.3 (e): any state may fail).
   */
  watch(child: ChildProcess, fault: FaultSignal, host: ChildWatchHost): void {
    this.#unsubscribers.push(
      onProcessError(child, (error) => {
        const quick = codeOf(error);
        this.raiseFault(
          fault,
          "SPAWN_FAILED",
          `the engine process reported an error: ${messageOf(error)}`,
          host,
          quick,
        );
      }),
      onProcessExit(child, (info) => {
        // Record before any stopping decision: a normal stop and a crash both
        // leave an exit fact, and D4 reads this after `failed` (`R-062`-3/6).
        this.#lastExit = { code: info.code, signal: info.signal };

        if (host.isStopping()) {
          return;
        }

        // Before the URL exists nothing can be classified as a port or protocol
        // fault, so the process never became a server.
        const code: EngineErrorCode = host.getState() === "spawning" ? "SPAWN_FAILED" : "TIMEOUT";
        this.raiseFault(
          fault,
          code,
          `the engine process exited unexpectedly (code ${String(info.code)}, ` +
            `signal ${String(info.signal)})`,
          host,
        );
      }),
    );
  }

  /** Classify a child fault for the in-flight attempt and for a later crash. */
  raiseFault(
    fault: FaultSignal,
    code: EngineErrorCode,
    detail: string,
    host: ChildWatchHost,
    wireHint?: string,
  ): void {
    const error =
      wireHint === undefined
        ? new EngineStartError(code, detail)
        : new EngineStartError(code, detail, wireHint);

    fault.fail(error);

    if (host.getState() === "ready") {
      host.declareFailure(error);
    }
  }

  /**
   * Pick the root cause of a failed start step.
   *
   * A dead child is often reported twice: the pending step fails on the closed
   * stdout stream or socket (a symptom) in the same tick the child's `error` /
   * `exit` event fires (the cause). Child events are queued behind the step's
   * rejection, so one macrotask is enough for them to run. A spawn failure then
   * wins over the port or protocol symptom it produced, which is what a field
   * report needs to see.
   */
  async rootCause(reason: unknown, fault: FaultSignal, host: ChildWatchHost): Promise<unknown> {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const raised = fault.raised;
    if (raised !== null && raised.code === "SPAWN_FAILED") {
      return raised;
    }

    if (host.getState() === "spawning" && this.isGone()) {
      return new EngineStartError(
        "SPAWN_FAILED",
        "the engine process exited before a WebSocket URL was discovered",
      );
    }

    return reason;
  }

  /** True when the child has recorded an exit or a terminating signal. */
  isGone(): boolean {
    const child = this.#child;
    return child !== null && (child.exitCode !== null || child.signalCode !== null);
  }

  /** Detach the child listeners so a stop cannot be mistaken for a crash. */
  releaseSubscriptions(): void {
    for (const unsubscribe of this.#unsubscribers.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // The child is already gone; a failed unsubscribe changes nothing.
      }
    }
  }

  /**
   * Record the OS exit fact when the child object already carries one.
   *
   * The normal stop path and the failure cleanup both release the child's
   * subscriptions before stopping it, so the `onProcessExit` listener cannot
   * record those. Reading `exitCode` / `signalCode` after the stop is the same
   * fact, and a budget expiry leaves both null (recorded as null, not guessed).
   *
   * @param child the child that has just been stopped
   */
  recordExit(child: ChildProcess): void {
    if (this.#lastExit === null && (child.exitCode !== null || child.signalCode !== null)) {
      this.#lastExit = { code: child.exitCode, signal: child.signalCode };
    }
  }
}
