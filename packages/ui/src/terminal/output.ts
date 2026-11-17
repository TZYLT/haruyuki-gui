/**
 * Getting an engine's bytes onto the screen.
 *
 * Why this module exists
 *   Three separate things were built and none of them touched: the router accepts a
 *   sink and calls `sink.write(text, done)`; `createTerminalSink` builds one and
 *   measures it; the panel owns the emulator. Nothing connected them, so bytes
 *   arriving from the engine were counted, dropped for want of a sink, and the
 *   screen stayed empty. A terminal that starts, takes keys, and displays nothing
 *   looks like a hung shell rather than a missing wire.
 *
 * The loop that has to close
 *   `done` is not a courtesy callback. The router accrues a terminal's bytes and
 *   acknowledges them only when a slice reports itself painted; without `done` the
 *   acknowledgement window never fills, the peer's credit never returns, and output
 *   stops a couple of megabytes in -- silently, with no error on either side. So the
 *   callback handed to `createTerminalSink` has to be the emulator's own completion
 *   callback, not a wrapper that drops it. `output.test.ts` closes that loop against
 *   the real router rather than asserting that a spy was called.
 *
 * Why disposal must unregister
 *   Measured, not assumed: after `host.dispose()`, `terminal.write` does not throw.
 *   It also still fires its completion callback, while the emulator prints
 *   "Trying to add a disposable to a DisposableStore that has already been
 *   disposed of". So a router left registered would keep confirming bytes that no
 *   human can see -- the acknowledgement would tell the peer to discard output that
 *   was painted into a torn-down buffer. That is worse than not painting at all,
 *   and it is the reason this module's unsubscribe is not optional.
 *
 * What this module does not own
 *   The decision to dispose, the terminal id, and the notice surface. It is handed
 *   those, so it can be tested without a React tree and so the panel keeps deciding
 *   when a session ends.
 */

import type { TerminalRouter } from "../bridge/terminal.js";
import { createTerminalSink } from "./sink.js";
import type { TerminalSinkAdapter } from "./sink.js";

/** What {@link attachTerminalOutput} needs from its caller. */
export interface TerminalOutputOptions {
  /** The terminal this output belongs to, as the engine keys sessions. */
  readonly terminalId: string;

  /** The router that receives the engine's slices. */
  readonly router: TerminalRouter;

  /**
   * The emulator's write, `write(text, done)`.
   *
   * Taken as a function rather than as a terminal so a caller can hand over a
   * stable closure: the panel rebuilds its host per mount, and a sink holding the
   * terminal object directly would keep writing into the previous instance.
   */
  readonly write: (text: string, done: () => void) => void;

  /**
   * The text of a dropped-bytes marker.
   *
   * Supplied by the caller because the word belongs to the message catalogue, and
   * the sink is deliberately unable to produce user-facing text of its own.
   */
  readonly formatNotice?: (droppedBytes: number) => string;

  /** How long to collect drop reports before painting one marker. */
  readonly noticeMs?: number;
}

/** What attaching produced. */
export interface TerminalOutputAttachment {
  /** The sink the router now holds. Exposed for its counters. */
  readonly sink: TerminalSinkAdapter;

  /**
   * Unregister and stop painting.
   *
   * Idempotent: a panel unmounts on paths that may also call it, and a second call
   * must not throw or resurrect the sink.
   */
  dispose(): void;
}

/**
 * Build a sink over one emulator and register it with the router.
 *
 * @param options the terminal, the router, the write and the marker text
 * @returns the sink and its teardown
 */
export function attachTerminalOutput(options: TerminalOutputOptions): TerminalOutputAttachment {
  const sink = createTerminalSink({
    write: (text, done) => {
      // Passed straight through, both arguments. A wrapper that dropped `done`
      // would leave the router's acknowledgement window unfilled, which shows up
      // as a stall megabytes later rather than as an error here.
      options.write(text, done);
    },
    ...(options.formatNotice === undefined ? {} : { formatNotice: options.formatNotice }),
    ...(options.noticeMs === undefined ? {} : { noticeMs: options.noticeMs }),
  });

  // `register` returns the unsubscribe that compares sink identity at call time, so
  // a remount that registers a second sink cannot be torn down by the first one's
  // teardown.
  const unregister: () => void = options.router.register(options.terminalId, sink);

  let disposed = false;

  return {
    sink,
    dispose(): void {
      if (disposed) return;

      disposed = true;

      // Order matters: unregister first, so the router stops handing this sink
      // slices before it is asked to stop painting. A slice arriving between the
      // two would otherwise be written to a disposed sink and confirmed without
      // being painted.
      unregister();
      sink.dispose();
    },
  };
}
