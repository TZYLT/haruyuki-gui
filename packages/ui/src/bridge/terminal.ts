/**
 * The renderer's terminal router: where `term.output` text is written, and where
 * its acknowledgement is batched.
 *
 * Requirement source: doc 38 section 6.3 (terminal bytes never enter React
 * state; a sink owns the DOM node and the writing) and section 10.2 (the
 * acknowledgement is batched, not one ack per slice).
 *
 * Why this module has no imports at all
 *   `@haruyuki/ui` may not value-import `@haruyuki/protocol` (rule R7), and the
 *   slice body is a wire shape rather than a renderer type, so
 *   {@link TermOutputBody} is declared here with the same eight fields instead
 *   of being imported. The two copies are compared by the compiler at the one
 *   place a host wires them together; duplicating an interface of primitives is
 *   cheaper than making the renderer load the protocol package at runtime. There
 *   is deliberately no React import either: the sink is an imperative target (a
 *   terminal emulator, a DOM text node), and the point of section 6.3 is that a
 *   megabyte of terminal text never becomes a React state update.
 *
 * Why `done` exists at all
 *   A sink may write asynchronously -- a terminal emulator parses a slice over
 *   several frames -- so acknowledging on the `write` call would acknowledge
 *   bytes that have not been rendered yet. The sink reports completion by
 *   calling the callback it was handed, and only then do the bytes count toward
 *   a batch. A sink that calls `done` synchronously (a plain text node) costs
 *   nothing extra.
 *
 * What batching is for
 *   One ack per 8 KiB slice is 128 acks for a megabyte, each crossing the bridge
 *   as its own frame. The router accumulates the bytes a sink has confirmed and
 *   sends one ack per {@link TerminalRouterOptions.batchBytes} (32 KiB by
 *   default), plus a deadline of {@link TerminalRouterOptions.intervalMs} (16 ms)
 *   so a terminal that goes quiet mid-batch -- or receives the last bytes of a
 *   command and then nothing -- is still acknowledged promptly. Both counters
 *   are per terminal: two terminals writing at once must not be able to flush
 *   each other's bytes onto one ack, because the peer credits them separately.
 *
 * What this layer does not do
 *   It does not decode or reorder slices, it does not decide what a dropped byte
 *   means (it forwards the peer's notice), and it does not own the transport: the
 *   two callbacks in the options are how the host sends the ack and shows the
 *   notice. Dropping text for a terminal that has no sink is not an error -- the
 *   screen may simply not show that terminal yet -- so it is counted, never
 *   buffered and never acknowledged, which is the only answer that cannot claim
 *   bytes were rendered when they were not.
 */

/** A destination that renders terminal text for one terminal. */
export interface TerminalSink {
  /**
   * Write one slice.
   *
   * @param text the slice's text, already decoded by the sender
   * @param done call once the text has been rendered; the bytes become eligible
   *   for acknowledgement at that moment. Calling it twice has no extra effect
   */
  write(text: string, done: () => void): void;
}

/**
 * One `term.output` slice (doc 38 section 6.2), as the sender produced it.
 *
 * Same shape as the protocol's own definition; declared here because the
 * renderer may not load that package (see the file comment).
 */
export interface TermOutputBody {
  terminal_id: string;
  slice: number;
  slices: number;
  offset: number;
  bytes: number;
  final: boolean;
  text: string;
}

/** A terminal the peer had to drop bytes for, reported so the view can say so. */
export interface TerminalNotice {
  terminal_id: string;
  droppedBytes: number;
}

/** How this router reaches the outside world. */
export interface TerminalRouterOptions {
  /** Send one acknowledgement for bytes that have been rendered. */
  ack: (ack: { terminal_id: string; bytes: number }) => void;
  /** Show that bytes were dropped for a terminal. */
  onNotice: (notice: TerminalNotice) => void;
  /** Bytes to accumulate before acknowledging without waiting. Defaults to 32 KiB. */
  batchBytes?: number;
  /** How long an incomplete batch may wait before it is acknowledged. Defaults to 16 ms. */
  intervalMs?: number;
}

/** What a diagnostic can read about a router. */
export interface TerminalRouterStats {
  /** Slices handed to a registered sink. */
  delivered: number;
  /** Slices that arrived for a terminal with no sink. */
  noSink: number;
  /** Bytes acknowledged so far. */
  ackedBytes: number;
  /** Notices forwarded to {@link TerminalRouterOptions.onNotice}. */
  notices: number;
}

/** The router a host calls once per bridge session. */
export interface TerminalRouter {
  /**
   * Attach the sink that renders one terminal.
   *
   * Registering the same terminal again replaces the sink; the bytes already
   * confirmed by the previous sink stay queued, because they have been rendered
   * and must still be acknowledged.
   *
   * @param terminalId the terminal this sink renders
   * @param sink the destination for slices of that terminal
   * @returns a function that detaches this sink and drops its queued bytes;
   *   it is inert if this sink is no longer the registered one, and calling it
   *   twice is safe
   */
  register(terminalId: string, sink: TerminalSink): () => void;

  /**
   * Offer one output slice.
   *
   * A slice for a terminal with no sink is counted and dropped: it is not
   * buffered (a missing view can be minutes away) and it is not acknowledged
   * (nothing rendered it).
   *
   * @param body the slice, as the sender produced it
   */
  deliver(body: TermOutputBody): void;

  /**
   * Forward the peer's report that it dropped bytes.
   *
   * @param notice the terminal and the number of dropped bytes
   */
  notice(notice: TerminalNotice): void;

  /**
   * Release every sink, timer and queued byte.
   *
   * Idempotent. A `done` that arrives afterwards is ignored: the view it would
   * have confirmed is gone.
   */
  dispose(): void;

  /** Live counters; each read is a fresh object, so it cannot be used to mutate the router. */
  readonly stats: TerminalRouterStats;
}

/** Default batch size: 32 KiB, four slices at the frozen 8 KiB slice size. */
const DEFAULT_BATCH_BYTES = 32 * 1024;

/** Default deadline for an incomplete batch: one animation frame. */
const DEFAULT_INTERVAL_MS = 16;

/** One terminal's unacknowledged bytes and the timer that will send them. */
interface PendingBatch {
  bytes: number;
  /** `null` when no deadline is armed for this batch. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Create a terminal router for one bridge session.
 *
 * One router per session: its sinks point at views that do not outlive the
 * session, so a reconnection builds a new one rather than reviving this one.
 *
 * @param options how to send acks and notices, and the batching policy
 * @returns a router with no sinks registered
 * @throws RangeError when `batchBytes` is not a positive finite number or
 *   `intervalMs` is not a finite non-negative number, since either would
 *   silently disable batching or the deadline rather than reach the peer
 */
export function createTerminalRouter(options: TerminalRouterOptions): TerminalRouter {
  return new TerminalRouterMachine(options);
}

/**
 * The implementation behind {@link createTerminalRouter}.
 *
 * Kept private so no instance can be built with a hand-written pending map: the
 * only way to queue bytes is {@link deliver}, through a sink.
 */
class TerminalRouterMachine implements TerminalRouter {
  readonly #ack: TerminalRouterOptions["ack"];
  readonly #onNotice: TerminalRouterOptions["onNotice"];
  readonly #batchBytes: number;
  readonly #intervalMs: number;

  /** Registered sinks, by terminal. */
  readonly #sinks = new Map<string, TerminalSink>();

  /** Unacknowledged bytes and their deadline, by terminal. */
  readonly #pending = new Map<string, PendingBatch>();

  #delivered = 0;
  #noSink = 0;
  #ackedBytes = 0;
  #notices = 0;

  constructor(options: TerminalRouterOptions) {
    const batchBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

    if (!Number.isFinite(batchBytes) || batchBytes <= 0) {
      throw new RangeError(
        `invalid batchBytes: ${String(batchBytes)}; an ack batch must be a positive finite ` +
          "number of bytes, or every slice would be acknowledged on its own",
      );
    }

    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new RangeError(
        `invalid intervalMs: ${String(intervalMs)}; the ack deadline must be a finite ` +
          "non-negative number of milliseconds",
      );
    }

    this.#ack = options.ack;
    this.#onNotice = options.onNotice;
    this.#batchBytes = batchBytes;
    this.#intervalMs = intervalMs;
  }

  register(terminalId: string, sink: TerminalSink): () => void {
    this.#sinks.set(terminalId, sink);

    // The returned function compares identity at call time instead of holding a
    // slot, so an unregister that remembers an already replaced sink cannot take
    // the current one down with it.
    return () => {
      if (this.#sinks.get(terminalId) !== sink) {
        return;
      }

      this.#sinks.delete(terminalId);
      this.#discard(terminalId);
    };
  }

  deliver(body: TermOutputBody): void {
    const { terminal_id: terminalId } = body;
    const sink = this.#sinks.get(terminalId);

    if (sink === undefined) {
      this.#noSink += 1;
      return;
    }

    // Counted before the write because the sink may confirm synchronously: an
    // ack callback that reads `stats` must already see this slice as delivered.
    this.#delivered += 1;

    let confirmed = false;
    const done = (): void => {
      if (confirmed) {
        return;
      }

      // A sink that was unregistered or disposed while the write was in flight
      // no longer has a view to confirm, so its late callback is dropped.
      if (this.#sinks.get(terminalId) === undefined) {
        return;
      }

      confirmed = true;
      this.#confirm(terminalId, body.bytes);
    };

    sink.write(body.text, done);
  }

  notice(notice: TerminalNotice): void {
    this.#notices += 1;
    this.#onNotice(notice);
  }

  dispose(): void {
    for (const batch of this.#pending.values()) {
      if (batch.timer !== null) {
        clearTimeout(batch.timer);
      }
    }

    this.#pending.clear();
    this.#sinks.clear();
  }

  get stats(): TerminalRouterStats {
    return {
      delivered: this.#delivered,
      noSink: this.#noSink,
      ackedBytes: this.#ackedBytes,
      notices: this.#notices,
    };
  }

  /**
   * Add confirmed bytes to a terminal's batch, acknowledging at the threshold or
   * arming the deadline when the batch is still small.
   *
   * @param terminalId the terminal that confirmed
   * @param bytes how many bytes its sink reported rendered
   */
  #confirm(terminalId: string, bytes: number): void {
    let batch = this.#pending.get(terminalId);

    if (batch === undefined) {
      batch = { bytes: 0, timer: null };
      this.#pending.set(terminalId, batch);
    }

    batch.bytes += bytes;

    if (batch.bytes >= this.#batchBytes) {
      this.#flush(terminalId);
      return;
    }

    // An empty batch has nothing to send, so it needs no deadline; an armed one
    // already covers every byte confirmed before it expires.
    if (batch.bytes <= 0 || batch.timer !== null) {
      return;
    }

    batch.timer = setTimeout(() => {
      batch.timer = null;
      this.#flush(terminalId);
    }, this.#intervalMs);
  }

  /**
   * Send one ack for everything queued for a terminal.
   *
   * The queue is cleared before the callback runs, so an ack that re-enters the
   * router -- or throws -- cannot leave the same bytes queued for a second ack.
   *
   * @param terminalId the terminal to flush
   */
  #flush(terminalId: string): void {
    const batch = this.#pending.get(terminalId);

    if (batch === undefined) {
      return;
    }

    this.#discard(terminalId);

    if (batch.bytes <= 0) {
      return;
    }

    this.#ackedBytes += batch.bytes;
    this.#ack({ terminal_id: terminalId, bytes: batch.bytes });
  }

  /**
   * Drop a terminal's queued bytes and its deadline, without sending them.
   *
   * @param terminalId the terminal being detached or flushed
   */
  #discard(terminalId: string): void {
    const batch = this.#pending.get(terminalId);

    if (batch === undefined) {
      return;
    }

    if (batch.timer !== null) {
      clearTimeout(batch.timer);
    }

    this.#pending.delete(terminalId);
  }
}
