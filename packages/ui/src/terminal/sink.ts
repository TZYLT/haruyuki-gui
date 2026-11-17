/**
 * The adapter between the bridge's render contract and a terminal emulator.
 *
 * The one rule this module exists to keep
 *   `write(text, done)` must call `done` exactly once, from inside the write's
 *   completion callback. `done` is not a notification; it is the signal that
 *   releases the peer's credit window. A sink that withholds it does not lose
 *   anything immediately -- the first megabytes render correctly -- and then the
 *   window is exhausted and output simply stops arriving, with no error on either
 *   side. A sink that calls it too early acknowledges bytes that have not been
 *   painted, and the peer is then free to forget them: the panel shows a gap that
 *   nothing reports. Both failures are silent, which is why the completion
 *   callback is the only place `done` is wired to.
 *
 * What this module does not own, and why
 *   The acknowledgement itself. There is no ack channel in this contract: the
 *   sink confirms one slice, and the router that handed it over accumulates those
 *   confirmations into one ack per 32 KiB or per 16 ms. Re-implementing a byte
 *   threshold here would create a second, unenforceable copy of a number the
 *   router already owns, and the two would drift the first time one of them was
 *   tuned. So this module has no `ackWindowBytes` option on purpose; what it owes
 *   the router is the discipline that makes the router's accounting correct --
 *   exactly one confirmation per slice, carrying that slice's byte count, in the
 *   callback.
 *
 * What `done` is not
 *   It is not an error report. A write that throws, or a terminal that was
 *   disposed mid-write, produces no confirmation: the bytes were not painted, and
 *   claiming otherwise would let the peer discard output that nothing displayed.
 *   A stalled window is a visible stall; a false confirmation is an invisible
 *   hole. The first is recoverable, so a broken renderer is allowed to stall.
 *
 * Notices are not terminal bytes
 *   The peer reporting that it dropped bytes is a message *about* the stream, not
 *   part of it. It is painted into the same view so the user sees where the gap
 *   is, but it never enters the acknowledgement accounting: those bytes were
 *   dropped before they arrived, and confirming the marker would over-acknowledge
 *   the peer by exactly the size of the explanation. For the same reason a marker
 *   is not a request to send anything to the shell -- it is local text.
 *
 * Pure apart from the injected write and the notice timer: no DOM, no xterm
 * import, no clock read, no I/O.
 */

import type { TerminalNotice, TerminalSink } from "../bridge/terminal.js";

/**
 * How long notices are collected before they are painted as one marker.
 *
 * A dropped-bytes report arrives per incident, and a slow renderer produces them
 * in bursts; one marker per incident would scroll the terminal with explanations
 * of the gap instead of showing the gap. The window is short enough that the user
 * still associates the marker with what they just saw.
 */
const DEFAULT_NOTICE_MS = 250;

/** What the adapter needs from its caller. */
export interface TerminalSinkOptions {
  /**
   * The emulator's write: `write(text, callback)`, with the callback fired when
   * the text has been parsed and painted.
   *
   * Passed in rather than reached for, so this module never imports a terminal
   * library and a test can supply one that completes late, or not at all.
   */
  readonly write: (text: string, done: () => void) => void;

  /**
   * How long to collect dropped-bytes reports before painting one marker.
   * Defaults to 250 ms.
   */
  readonly noticeMs?: number;

  /**
   * The text of a dropped-bytes marker.
   *
   * Supplied by the caller because the word for it belongs to the message
   * catalogue, and this package reserves user-facing text there; a literal here
   * would render in one language and be invisible to every review. Omitting it
   * disables markers entirely, which is the honest default for a module that does
   * not know what language the user reads.
   */
  readonly formatNotice?: (droppedBytes: number) => string;
}

/** What the sink can say about itself, for a diagnostic and for the tests. */
export interface TerminalSinkStats {
  /** Slices handed to {@link TerminalSinkAdapter.write}. */
  readonly slices: number;
  /** Bytes of terminal output handed over, which is what the peer will ack. */
  readonly bytes: number;
  /** Slices confirmed as painted. */
  readonly confirmed: number;
  /** Slices that will never be confirmed, because painting them failed. */
  readonly abandoned: number;
  /** Dropped-bytes reports received. */
  readonly notices: number;
  /** Markers painted so far. */
  readonly markers: number;
  /** Bytes reported dropped by the peer and not yet painted. */
  readonly unnotifiedBytes: number;
}

/** The render sink plus the two calls the panel needs around it. */
export interface TerminalSinkAdapter extends TerminalSink {
  /**
   * Report that the peer dropped bytes for this terminal.
   *
   * Painted as one marker once the collection window closes; the marker is local
   * text and is never confirmed to the peer.
   *
   * @param notice the peer's report
   */
  notice(notice: TerminalNotice): void;

  /**
   * Stop painting and release the pending notice timer.
   *
   * After this, writes are ignored and produce no confirmation, because a
   * disposed emulator never fires its completion callback. The caller is expected
   * to unregister the sink; a confirmation for a slice that was never painted
   * would let the peer discard output nobody saw.
   */
  dispose(): void;

  /** Current counters. */
  readonly stats: TerminalSinkStats;
}

/**
 * Build the sink that renders one terminal's output.
 *
 * @param options the emulator's write, and how notices are collected
 * @returns the sink, its notice path and its counters
 */
export function createTerminalSink(options: TerminalSinkOptions): TerminalSinkAdapter {
  const noticeMs = options.noticeMs ?? DEFAULT_NOTICE_MS;

  if (!Number.isFinite(noticeMs) || noticeMs < 0) {
    throw new RangeError(
      `invalid noticeMs: ${String(noticeMs)}; the notice window must be a finite ` +
        "non-negative number of milliseconds, or a burst of reports would never " +
        "resolve into a single marker",
    );
  }

  let slices = 0;
  let bytes = 0;
  let confirmed = 0;
  let abandoned = 0;
  let notices = 0;
  let markers = 0;
  let unnotifiedBytes = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Paint the collected drops as one marker.
   *
   * The marker is written with a no-op completion: it is not terminal output, so
   * there is nothing to confirm. Its size is deliberately not added to `bytes`
   * either -- that counter is the amount the peer will be asked to acknowledge,
   * and adding local text to it would over-acknowledge by the marker's length.
   *
   * The collected bytes are cleared even when no marker text was supplied. They
   * still described a gap the user cannot see a marker for, but keeping them
   * queued would make the pending count grow forever with reports that will never
   * be painted, which reads as a backlog that does not exist.
   */
  function paintNotice(): void {
    timer = null;

    if (disposed) return;

    const dropped = unnotifiedBytes;

    unnotifiedBytes = 0;

    if (dropped <= 0 || options.formatNotice === undefined) return;

    markers += 1;

    // A marker that cannot be painted must not leave the drops queued for a
    // second attempt: the report described bytes that are already gone.
    try {
      options.write(options.formatNotice(dropped), () => {});
    } catch {
      // Nothing to report and nowhere to report it: the emulator is the surface
      // this marker was meant for.
    }
  }

  return {
    write(text: string, done: () => void): void {
      // A disposed emulator never calls back, so a write here would be a slice
      // that can never be confirmed. Refusing it keeps the counter honest.
      if (disposed) return;

      slices += 1;
      bytes += byteLength(text);

      let settled = false;

      const settle = (): void => {
        // The completion callback is the only caller of `done`, and a completion
        // delivered twice settles once: an emulator that re-enters its callback
        // must not be able to acknowledge the same slice twice.
        if (settled) return;

        settled = true;

        if (disposed) return;

        confirmed += 1;
        done();
      };

      try {
        options.write(text, settle);
      } catch {
        // The callback will never arrive, so this slice is never confirmed. The
        // peer's window stalls rather than being told about a paint that did not
        // happen -- see the module comment for why that is the safe direction.
        abandoned += 1;
      }
    },

    notice(notice: TerminalNotice): void {
      if (disposed) return;

      if (!Number.isFinite(notice.droppedBytes) || notice.droppedBytes <= 0) return;

      // Counted even when no marker text was supplied. The report is a fact about
      // the stream, and a diagnostic that could not see it would be blind exactly
      // where the terminal is showing nothing -- but the pending bytes still have
      // to be collected and cleared on schedule, or the count would grow forever
      // with reports that can never be painted.
      notices += 1;
      unnotifiedBytes += notice.droppedBytes;

      // The first report of a burst arms the window; the rest join it. Re-arming
      // per report would push the marker out for as long as the burst lasts,
      // which on a sustained overload means never.
      if (timer === null) {
        timer = setTimeout(paintNotice, noticeMs);
      }
    },

    dispose(): void {
      if (disposed) return;

      disposed = true;

      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      // Drops that were never painted are dropped with the view, not reported:
      // there is no surface left to report them on.
      unnotifiedBytes = 0;
    },

    get stats(): TerminalSinkStats {
      return {
        slices,
        bytes,
        confirmed,
        abandoned,
        notices,
        markers,
        unnotifiedBytes,
      };
    },
  };
}

/**
 * The byte length of one slice's text.
 *
 * The peer's window and its acknowledgements are counted in bytes, not in UTF-16
 * code units, so a slice of CJK text is three times its `length`. Confirming
 * `text.length` would under-acknowledge by that factor and stall the window on
 * exactly the terminals whose output is most expensive to render.
 *
 * @param text the slice as the emulator will receive it
 * @returns its length in UTF-8 bytes
 */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
