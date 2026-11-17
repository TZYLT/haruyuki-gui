/**
 * Liveness probe for one connection to a child process.
 *
 * An open socket proves nothing about the peer: the process can be wedged, its
 * event loop blocked, or a half-dead pipe left behind. The cheap way to tell the
 * difference is to ask one small, read-only question and wait for the answer, so
 * this module repeats that request on a timer and counts consecutive failures.
 *
 * Two deliberate properties:
 *
 * - **One miss is not a verdict.** A dropped round trip is routine while the
 *   engine is busy, and tearing down a healthy connection costs more than one
 *   extra timeout. So the first failure only marks the connection `suspect`; the
 *   default rule waits for two consecutive failures before declaring it `dead`.
 * - **The probe only reports.** Stopping, reconnecting and resuming belong to
 *   the caller, which keeps detection testable without a socket or a process.
 *
 * The next attempt is armed `intervalMs` after the previous one *settles*,
 * rather than on a fixed cadence. A fixed cadence either starts a second round
 * trip under a still-open one when the timeout is longer than the interval, or
 * drifts when the timer is late; settling first makes "no two round trips in
 * flight" true by construction. With the defaults, a disconnect that happens
 * right after a good answer is noticed after
 * `interval + timeout + interval + timeout` = 36 seconds at worst.
 */

/** How much of the connection's behaviour the probe currently trusts. */
export type ProbeState = "alive" | "suspect" | "dead";

/**
 * Time source and timer port.
 *
 * Injected instead of using the global timers so a test can walk the worst-case
 * detection window without sleeping, and so the caller can share one clock.
 */
export interface ProbeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

/** One round trip. Resolves `{ ok: true }` when the engine answered in time; never throws. */
export type ProbeSend = () => Promise<{ ok: boolean }>;

export interface ProbeOptions {
  /** Default 10_000. */
  readonly intervalMs?: number;
  /** Default 8_000. */
  readonly timeoutMs?: number;
  /** Default 2 — how many consecutive failures declare the connection dead. */
  readonly strikes?: number;
  readonly clock: ProbeClock;
  readonly send: ProbeSend;
  /** Called on every state change, never twice with the same state. */
  readonly onStateChange?: (state: ProbeState, at: number) => void;
}

export interface Probe {
  /** Starts the timer. Idempotent. */
  start(): void;
  /** Stops the timer and drops any in-flight round trip. Idempotent. */
  stop(): void;
  /** Current verdict. */
  state(): ProbeState;
  /** Number of consecutive failed round trips so far. */
  strikes(): number;
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_STRIKES = 2;

/**
 * One round trip, identified by object identity so a late answer from an
 * abandoned attempt cannot be mistaken for the answer of the current one.
 */
interface Attempt {
  settled: boolean;
}

export function createProbe(options: ProbeOptions): Probe {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const strikeLimit = options.strikes ?? DEFAULT_STRIKES;
  const { clock, send, onStateChange } = options;

  let verdict: ProbeState = "alive";
  let failures = 0;
  let running = false;
  let current: Attempt | null = null;
  let cancelTick: (() => void) | null = null;
  let cancelTimeout: (() => void) | null = null;

  function clearTick(): void {
    cancelTick?.();
    cancelTick = null;
  }

  function clearTimeoutTimer(): void {
    cancelTimeout?.();
    cancelTimeout = null;
  }

  function setVerdict(next: ProbeState): void {
    if (verdict === next) return;
    verdict = next;
    onStateChange?.(next, clock.now());
  }

  function scheduleTick(): void {
    if (!running || cancelTick !== null) return;
    cancelTick = clock.setTimer(onTick, intervalMs);
  }

  function onTick(): void {
    cancelTick = null;
    if (!running) return;
    // While a round trip is open, keep the cadence alive but skip the send: the
    // attempt is still bounded by its own timeout, and queueing ticks would
    // release a burst of requests the moment it settles.
    if (current !== null) {
      scheduleTick();
      return;
    }
    // Arm the next tick before sending; a settlement replaces it with a tick
    // measured from the settlement, so a slow answer never shifts the cadence
    // or stacks a second request on top of the next one.
    scheduleTick();
    fire();
  }

  function fire(): void {
    const attempt: Attempt = { settled: false };
    current = attempt;
    // The timeout is the only thing that can settle an attempt that never
    // answers. It is cancelled in settle, so a quick answer leaves no timer.
    cancelTimeout = clock.setTimer(() => settle(attempt, false), timeoutMs);

    let roundTrip: Promise<{ ok: boolean }>;
    try {
      roundTrip = send();
    } catch {
      // A synchronous throw is a failed round trip, not a crash of the probe.
      settle(attempt, false);
      return;
    }
    roundTrip.then(
      (answer) => settle(attempt, answer.ok === true),
      () => settle(attempt, false),
    );
  }

  function settle(attempt: Attempt, ok: boolean): void {
    if (attempt.settled) return;
    attempt.settled = true;
    // `stop()` clears `current`, so an answer that arrives afterwards is
    // dropped instead of reviving a probe nobody is observing any more.
    if (current !== attempt) return;
    current = null;
    clearTimeoutTimer();
    if (!running) return;

    if (ok) {
      failures = 0;
      setVerdict("alive");
    } else {
      failures += 1;
      if (failures >= strikeLimit) {
        setVerdict("dead");
        halt();
        return;
      }
      setVerdict("suspect");
    }

    clearTick();
    scheduleTick();
  }

  function halt(): void {
    running = false;
    clearTick();
    clearTimeoutTimer();
    current = null;
  }

  function start(): void {
    if (running) return;
    running = true;
    scheduleTick();
  }

  function stop(): void {
    running = false;
    clearTick();
    clearTimeoutTimer();
    // Drops the attempt as well: its resolution is ignored by `settle`, and its
    // timeout no longer exists.
    current = null;
  }

  return {
    start,
    stop,
    state: () => verdict,
    strikes: () => failures,
  };
}
