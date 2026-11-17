/**
 * Replaces the child process behind one engine endpoint, once.
 *
 * Reconnecting over existing sockets covers a dropped connection. It does not
 * cover the engine itself being gone or wedged: the endpoint the old process
 * listened on is not coming back, and the only way to reach a usable engine is
 * to stop that process and start a new one. That single step lives here.
 *
 * Deliberately not in this module: it never decides to restart (the caller
 * decides when), it has no retry loop, and it carries no UI state.
 *
 * The properties that matter are about ownership: two overlapping attempts can
 * leave two processes, one with nobody holding its endpoint. So concurrent calls
 * share the attempt in flight, and every attempt is bounded by a budget.
 */

/** The endpoint the engine listens on once it is up. */
export interface RestartEndpoint {
  readonly url: string;
  readonly token: string;
}

/** The process this port replaces. Both steps are supplied by the caller. */
export interface RestartPorts {
  /** Stop whatever is running now. Must be safe when nothing is running. */
  readonly stop: () => Promise<void>;
  /** Start again and resolve the endpoint the engine now listens on. */
  readonly start: () => Promise<{ readonly url: string; readonly token: string }>;
}

/**
 * Timer port, the same shape the rest of this layer injects: a test can walk
 * past the budget without waiting for it, and the caller can share one clock.
 */
export type RestartTimer = (fn: () => void, ms: number) => () => void;

export interface RestartOptions {
  /** How long one restart may take before it is abandoned. Default 30_000 ms. */
  readonly timeoutMs?: number;
  /** Timer for the budget. Defaults to the global timers. */
  readonly setTimer?: RestartTimer;
}

export interface RestartPort {
  /**
   * Restart once. Concurrent calls share the attempt already in flight instead of
   * starting a second process.
   */
  restart(): Promise<{ readonly url: string; readonly token: string }>;
  /** Timers this port owns; safe to call twice. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const systemTimer: RestartTimer = (fn, ms) => {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
};

export function createRestartPort(ports: RestartPorts, options: RestartOptions = {}): RestartPort {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const setTimer = options.setTimer ?? systemTimer;

  /**
   * The attempt in flight, held by identity so a second call can be answered
   * with the same promise, and cleared when it settles so the next call starts
   * over instead of inheriting the verdict of an attempt the caller saw fail.
   */
  let inflight: Promise<RestartEndpoint> | null = null;
  let cancelBudget: (() => void) | null = null;
  let disposed = false;

  function clearBudget(): void {
    cancelBudget?.();
    cancelBudget = null;
  }

  /**
   * One attempt: stop, then start, inside a single budget.
   *
   * One budget covers both steps rather than one each, because the caller asked
   * for one restart with one budget and per-step timers would allow twice the
   * wait that was promised.
   */
  function begin(): Promise<RestartEndpoint> {
    return new Promise<RestartEndpoint>((resolve, reject) => {
      let settled = false;

      /** Claims the settlement and drops the timer; false when already settled. */
      const claim = (): boolean => {
        if (settled) return false;
        settled = true;
        clearBudget();
        return true;
      };

      cancelBudget = setTimer(() => {
        cancelBudget = null;
        if (!claim()) return;
        reject(new Error(`restart timed out: the ${timeoutMs} ms budget was spent`));
      }, timeoutMs);

      const replace = async (): Promise<RestartEndpoint> => {
        try {
          await ports.stop();
        } catch {
          // A process that cannot be stopped cleanly is still a process to
          // replace: it is gone or wedged, which is why this port was called at
          // all. Skipping `start` would leave the caller with no engine and no
          // endpoint, which is worse than starting a replacement next to a
          // process that may still be dying, so the stop failure is swallowed
          // and the attempt reports what `start` says.
        }
        return ports.start();
      };

      replace().then(
        (endpoint) => {
          if (claim()) resolve(endpoint);
        },
        (error: unknown) => {
          // Rethrown unchanged: a caller that logs or classifies the failure
          // needs the original error, not a wrapper.
          if (claim()) reject(error);
        },
      );
    });
  }

  function restart(): Promise<RestartEndpoint> {
    if (disposed) {
      return Promise.reject(
        new Error("restart port is disposed: refusing to start a process nobody would own"),
      );
    }
    if (inflight !== null) return inflight;

    const attempt = begin();
    inflight = attempt;
    // Released on both outcomes; a rejected attempt must not poison the latch,
    // or one transient failure would make every later restart a replay of it.
    const release = (): void => {
      if (inflight === attempt) inflight = null;
    };
    attempt.then(release, release);
    return attempt;
  }

  /**
   * Stops this port from starting anything new, and drops the budget timer.
   *
   * An attempt already in flight is left alone: the work was asked for before
   * dispose and its callers hold its promise, so its outcome is still reported
   * when it arrives. Only the timer goes away.
   */
  function dispose(): void {
    disposed = true;
    clearBudget();
  }

  return { restart, dispose };
}
