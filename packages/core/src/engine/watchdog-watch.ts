/**
 * Watchdog self-check of one hosted engine attempt.
 *
 * Split out of `engine.ts`, and kept apart from `child-watch.ts` on
 * purpose: `child-watch` is *we watch the process*, this is *the engine watches
 * itself*. The two produce different degradations and fail in different ways.
 *
 * Invariants:
 *
 * - The marker is only expected when the spawn spec actually preloads the
 *   watchdog. A spec without it — a caller that deliberately runs without orphan
 *   protection — must NOT be reported as degraded.
 * - Subscribing here never creates a second stderr reader; `onProcessStderr`
 *   attaches to the single reader in `spawn.ts` .
 * - A missing marker is a degradation, never a failure: the engine still works,
 *   only orphan protection is down to the parent process.
 */

import type { ChildProcess } from "node:child_process";

import {
  expectsWatchdog,
  MarkerWatch,
  watchdogDegradation,
  WATCHDOG_MARKER,
  WATCHDOG_MARKER_GRACE_MS,
} from "./degradations";
import { onProcessStderr } from "./spawn";
import type { EngineDegradation, EngineSpawnSpec } from "./types";

/** What the facade owns while this module owns the watch. */
export interface WatchdogHost {
  /** Record a degradation; the facade owns the list's lifetime. */
  note(degradation: EngineDegradation): void;
}

export class WatchdogWatch {
  #watch: MarkerWatch | null = null;

  /** A new attempt watches a new child; the old watch says nothing about it. */
  reset(): void {
    this.#watch = null;
  }

  /**
   * Watch the child's stderr for the watchdog self-check marker.
   *
   * The marker is only expected when the spawn spec actually preloads the
   * watchdog: the headless host port composes `NODE_OPTIONS=--require
   * "<abs>/watchdog.cjs"`, and a spec without it - a
   * caller that deliberately runs without orphan protection - must not be
   * reported as degraded.
   */
  watch(child: ChildProcess, spec: EngineSpawnSpec): void {
    if (!expectsWatchdog(spec)) {
      this.#watch = null;
      return;
    }

    const watch = new MarkerWatch(WATCHDOG_MARKER);
    onProcessStderr(child, (chunk) => {
      watch.observe(chunk);
    });

    this.#watch = watch;
  }

  /**
   * Turn "no marker by now" into a `watchdog` degradation.
   *
   * Called once the WebSocket URL is known: the watchdog is preloaded before any
   * engine code runs, so its marker has been written before the engine starts
   * listening. The short wait only pays off in the degraded case: the fuse
   * disables `--require`, or the path is wrong), where orphan protection is down
   * to the parent process and the host has to be told.
   */
  async settle(host: WatchdogHost): Promise<void> {
    const watch = this.#watch;

    if (watch === null || watch.found) {
      return;
    }

    await watch.wait(WATCHDOG_MARKER_GRACE_MS);

    if (watch.found) {
      return;
    }

    host.note(watchdogDegradation());
  }
}
