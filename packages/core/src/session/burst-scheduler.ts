/**
 * The host clock a session store runs its burst window on.
 *
 * This is the one file in the session layer that arms a real timer, and it is
 * separated for exactly that reason: the windowing rule itself lives in
 * `subscriptions.ts` and takes its scheduler as an argument, so it can be tested
 * on a clock the test drives. Without a product caller for the timer, though,
 * the rule would only ever exist in that test - the shipped store would answer
 * every change synchronously and a fast producer would still cost a frame per
 * change. So the real timer is here, at the assembly seam, and the shell wires
 * it in.
 *
 * Two details are deliberate:
 *
 * - The timer is `unref`ed where the host offers it. A pending window is a reason
 *   to send a frame, never a reason for the process to stay alive, and a store
 *   that kept a Node process up for a quarter of a second after its last change
 *   would be a shutdown bug reported as a hang.
 * - Cancelling tolerates a handle the host has already retired. `clearTimeout`
 *   on a fired timer is a no-op by specification, so no registry of live handles
 *   is kept here; remembering them would only add a way for the registry to
 *   disagree with the runtime.
 */

/** The clock and the deferral a subscription table needs to run its window. */
export interface BurstScheduler {
  /** Defer `fn` by `ms`, returning a canceller that is safe to call twice. */
  readonly schedule: (fn: () => void, ms: number) => () => void;
  /** Read the clock, in milliseconds, on the same scale the timer runs on. */
  readonly now: () => number;
}

/** A `setTimeout` handle, which differs in type between Node and the browser. */
type TimerHandle = ReturnType<typeof setTimeout>;

/**
 * Build the scheduler a store uses in production.
 *
 * @returns the host clock and a `setTimeout`-backed deferral
 */
export function createBurstScheduler(): BurstScheduler {
  return {
    schedule: (fn, ms) => {
      const handle: TimerHandle = setTimeout(fn, ms);

      // Node returns an object here and the browser a number; only the object
      // form can be unref'ed, and only Node needs it.
      if (typeof handle === "object" && handle !== null && "unref" in handle) {
        handle.unref();
      }

      return () => {
        clearTimeout(handle);
      };
    },
    now: () => Date.now(),
  };
}
