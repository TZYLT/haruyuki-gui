/**
 * The bounded terminal entry (requirement doc 38 section 10.2).
 *
 * `term.output` is produced faster than a renderer can paint it, so two buffers
 * absorb the difference: a per-terminal window of unacknowledged bytes, and a
 * FIFO of the slices that did not fit into that window. The FIFO is capped, so
 * a terminal nobody drains cannot grow main-process memory without bound. A
 * drop is never silent: the slice leaves the queue and the terminal owes a
 * notice that `flushNotices()` reports on `TERMINAL_NOTICE`.
 *
 * Three constraints shaped this module:
 *
 *   no `electron`   `attach` receives the send function, exactly like
 *                   `BridgeTransport`. Every path is unit-testable without a
 *                   browser process.
 *   no timers       the coalescing tick belongs to the callers. This module exports
 *                   the interval and only answers `flushNotices()`.
 *   no reordering   a terminal's bytes leave in arrival order, including the
 *                   slices that waited for the renderer's handshake.
 *
 * Byte accounting is per terminal and trusted from the caller when it is
 * plausible (`body.bytes` finite and non-negative); otherwise the text is
 * measured, so a producer that cannot count bytes cannot be charged zero by
 * accident.
 */

import { FRAME_DELIVER, TERMINAL_NOTICE } from "./channels.js";
import type { TermOutputBody, TerminalIngress, TerminalIngressStats } from "./types.js";

/** Unacknowledged bytes one terminal may have in flight. */
export const ACK_WINDOW_BYTES = 256 * 1024;

/** Bytes one terminal may have queued behind the window before drops start. */
export const PENDING_CAP_BYTES = 1024 * 1024;

/**
 * The preferred ack batch size, in bytes.
 *
 * Unused here: the renderer batches its acks and the bridge wires that loop. The
 * number lives beside the window so the two cannot drift apart.
 */
export const ACK_BATCH_BYTES = 32 * 1024;

/** The preferred ack interval, in milliseconds. The timer lives in the wiring. */
export const ACK_INTERVAL_MS = 16;

/** The notice coalescing interval, in milliseconds. The timer lives in the wiring. */
export const NOTICE_COALESCE_MS = 250;

/** The knobs a test or a future host may override. */
export interface TerminalIngressOptions {
  /** Defaults to {@link ACK_WINDOW_BYTES}; `Infinity` disables backpressure. */
  windowBytes?: number;
  /** Defaults to {@link PENDING_CAP_BYTES}; `Infinity` removes the cap. */
  pendingCapBytes?: number;
}

/** One queued `term.output` string and the bytes charged for it. */
interface PendingSlice {
  readonly payload: string;
  bytes: number;
}

/** Everything the entry remembers about one terminal. */
interface TerminalBucket {
  /** FIFO; `pending[0]` is the next byte to deliver. */
  pending: PendingSlice[];
  pendingBytes: number;
  /**
   * Slices already handed to the renderer but not yet acked.
   *
   * Retaining them is what makes a reload replay the bytes the old renderer had
   * received but never confirmed. A count alone would bound the window but
   * could not put the content back.
   */
  inflight: PendingSlice[];
  inflightBytes: number;
  unackedBytes: number;
  /** Bytes dropped since the last notice, not since process start. */
  noticeBytes: number;
  needsNotice: boolean;
}

/** A `TextEncoder` is stateless; one instance avoids recreating it per slice. */
const textEncoder = new TextEncoder();

/** The send function a handshake hands over. */
type Send = (channel: string, payload: unknown) => void;

/**
 * Create the per-session bounded terminal entry.
 *
 * @param options window and cap overrides; omitted fields keep the constants
 */
export function createTerminalIngress(options: TerminalIngressOptions = {}): TerminalIngress {
  const windowBytes = normalizeLimit(options.windowBytes, ACK_WINDOW_BYTES);
  const pendingCapBytes = normalizeLimit(options.pendingCapBytes, PENDING_CAP_BYTES);

  const buckets = new Map<string, TerminalBucket>();

  let send: Send | null = null;
  let sentBytes = 0;
  let ackedBytes = 0;
  let droppedBytes = 0;
  let disposed = false;

  /** The bucket for a terminal, created on first sight (even before attach). */
  function bucketFor(terminalId: string): TerminalBucket {
    const existing = buckets.get(terminalId);

    if (existing !== undefined) return existing;

    const bucket: TerminalBucket = {
      pending: [],
      pendingBytes: 0,
      inflight: [],
      inflightBytes: 0,
      unackedBytes: 0,
      noticeBytes: 0,
      needsNotice: false,
    };

    buckets.set(terminalId, bucket);

    return bucket;
  }

  /** Deliver from the queue while the same terminal's window has room. */
  function pump(bucket: TerminalBucket): void {
    const target = send;

    if (target === null) return;

    while (bucket.pending.length > 0) {
      const head = bucket.pending[0];

      if (head === undefined) return;
      if (bucket.unackedBytes + head.bytes > windowBytes) return;

      bucket.pending.shift();
      bucket.pendingBytes -= head.bytes;

      target(FRAME_DELIVER.stream, head.payload);

      bucket.inflight.push(head);
      bucket.inflightBytes += head.bytes;
      bucket.unackedBytes += head.bytes;
      sentBytes += head.bytes;
    }
  }

  function accept(payload: string, body: TermOutputBody): void {
    if (disposed) return;

    // The body is typed, but a malformed producer must not crash the host's
    // term.output path. A missing id shares one bucket instead of vanishing.
    const terminalId = typeof body?.terminal_id === "string" ? body.terminal_id : "";
    const bytes = sliceBytes(body);
    const bucket = bucketFor(terminalId);

    // Straight through only when nothing older is waiting: a queue exists
    // precisely because the window is full, and sending the newcomer first
    // would reorder the terminal's bytes.
    if (
      send !== null &&
      bucket.pending.length === 0 &&
      bucket.unackedBytes + bytes <= windowBytes
    ) {
      send(FRAME_DELIVER.stream, payload);

      bucket.inflight.push({ payload, bytes });
      bucket.inflightBytes += bytes;
      bucket.unackedBytes += bytes;
      sentBytes += bytes;

      return;
    }

    bucket.pending.push({ payload, bytes });
    bucket.pendingBytes += bytes;

    // Drop oldest until the queue fits again. Several slices may go in one
    // step when a single accept pushed the queue well past the cap.
    while (bucket.pendingBytes > pendingCapBytes) {
      const oldest = bucket.pending.shift();

      if (oldest === undefined) break;

      bucket.pendingBytes -= oldest.bytes;
      droppedBytes += oldest.bytes;
      bucket.noticeBytes += oldest.bytes;
      bucket.needsNotice = true;
    }
  }

  function ack(terminalId: string, bytes: number): void {
    if (disposed) return;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return;

    const bucket = buckets.get(terminalId);

    if (bucket === undefined) return;

    // An ack larger than the window is a renderer bug; clamp it rather than
    // letting the excess free capacity that was never in use.
    const acknowledged = Math.min(bytes, bucket.unackedBytes);

    releaseInflight(bucket, acknowledged);

    bucket.unackedBytes = Math.max(0, bucket.unackedBytes - acknowledged);
    ackedBytes += acknowledged;

    pump(bucket);
  }

  /** Drop acked bytes from the front of the inflight list, splitting a partial slice. */
  function releaseInflight(bucket: TerminalBucket, bytes: number): void {
    let remaining = bytes;

    while (remaining > 0 && bucket.inflight.length > 0) {
      const head = bucket.inflight[0];

      if (head === undefined) return;

      if (head.bytes <= remaining) {
        bucket.inflight.shift();
        bucket.inflightBytes -= head.bytes;
        remaining -= head.bytes;
      } else {
        head.bytes -= remaining;
        bucket.inflightBytes -= remaining;
        remaining = 0;
      }
    }
  }

  function attach(target: Send): void {
    if (disposed) return;

    send = target;

    // The handshake is the first moment anything can leave, so drain every
    // terminal that buffered while it was pending.
    for (const bucket of buckets.values()) pump(bucket);
  }

  function detach(): void {
    // Queued bytes stay: a reload keeps the terminal's scrollback unread, and
    // dropping it here would lose data the renderer never saw.
    //
    // In-flight bytes move back to the FRONT of the queue. They were sent to a
    // renderer that is now gone and will never ack them; the next renderer has
    // an empty xterm and needs them replayed. Keeping only a count would bound
    // the window but lose the content, which is exactly the "looks fine until
    // Ctrl+R" failure.
    for (const bucket of buckets.values()) {
      if (bucket.inflight.length > 0) {
        bucket.pending = [...bucket.inflight, ...bucket.pending];
        bucket.pendingBytes += bucket.inflightBytes;
        bucket.inflight = [];
        bucket.inflightBytes = 0;
      }

      bucket.unackedBytes = 0;

      // Replay shares the ring's cap. The window is smaller than the cap, so
      // this is the only path that can push the queue over it; dropping here
      // keeps the bound honest and owes the same notice as an overflow.
      while (bucket.pendingBytes > pendingCapBytes) {
        const oldest = bucket.pending.shift();

        if (oldest === undefined) break;

        bucket.pendingBytes -= oldest.bytes;
        droppedBytes += oldest.bytes;
        bucket.noticeBytes += oldest.bytes;
        bucket.needsNotice = true;
      }
    }

    send = null;
  }

  function flushNotices(): void {
    const target = send;

    if (disposed || target === null) return;

    for (const [terminalId, bucket] of buckets) {
      if (!bucket.needsNotice || bucket.noticeBytes <= 0) continue;

      const dropped = bucket.noticeBytes;

      // Clear before sending so a reentrant send cannot report the same debt
      // twice.
      bucket.noticeBytes = 0;
      bucket.needsNotice = false;

      target(TERMINAL_NOTICE, { terminal_id: terminalId, droppedBytes: dropped });
    }
  }

  function stats(): TerminalIngressStats {
    let pendingBytes = 0;
    let unackedBytes = 0;

    for (const bucket of buckets.values()) {
      pendingBytes += bucket.pendingBytes;
      unackedBytes += bucket.unackedBytes;
    }

    return {
      terminals: buckets.size,
      sentBytes,
      ackedBytes,
      droppedBytes,
      pendingBytes,
      unackedBytes,
    };
  }

  function dispose(): void {
    disposed = true;
    send = null;
    buckets.clear();
    // The counters stay as lifetime totals: `pendingBytes` and `unackedBytes`
    // are derived from the buckets, so they read zero after the clear without
    // erasing what the session did.
  }

  return { accept, ack, attach, detach, flushNotices, stats, dispose };
}

/**
 * A limit that a caller may override, with a guard against nonsense.
 *
 * `Infinity` is a meaningful value (the unbounded variant a test compares
 * against), so only `NaN` and negatives fall back to the default.
 */
function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (Number.isNaN(value) || value < 0) return fallback;

  return value;
}

/** The bytes one slice is charged: declared when plausible, measured otherwise. */
function sliceBytes(body: TermOutputBody): number {
  const declared = body?.bytes;

  if (typeof declared === "number" && Number.isFinite(declared) && declared >= 0) {
    return declared;
  }

  const text = typeof body?.text === "string" ? body.text : "";

  return textEncoder.encode(text).byteLength;
}
