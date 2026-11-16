/**
 * The main-process byte mover.
 *
 * A frame leaves the core as one string and must reach the renderer as that same
 * string. The transport therefore parses only to ROUTE: it reads `ch`, `t` and
 * `seq`, then hands the caller's original payload to `send`. It never
 * re-serializes, because parse-then-stringify is not the identity on a JSON
 * string -- whitespace and the spelling of escapes are lost, and either one
 * changes the bytes a receiver hashes or forwards. Re-serializing would also
 * give this module an opinion about the body, which belongs to the core.
 *
 * The parse is read-only and defensive: a payload that is not a JSON object, or
 * whose `ch` is not one of the three frame channels, is counted and dropped. A
 * guessed channel was rejected -- a wrong guess files a frame under a limit that
 * does not describe it (see `channels.ts`), and the guess is unrecoverable
 * because the renderer only sees the channel it was sent on.
 *
 * `term.output` takes a different road. Terminal bytes go to the bounded
 * terminal ingress, not to a frame channel, so the transport hands them to the
 * injected `onTerminal`. That hand-off happens before the acceptance gate for
 * the same reason the ingress buffers at all: a slice can be produced while the
 * renderer has not finished its handshake, and dropping it there would lose
 * bytes the user is owed. The ingress decides what an unaccepted renderer means;
 * the transport only keeps the route honest. For the same reason `detach` does
 * not silence the terminal sink: slices accepted across a reload are replayed by
 * the ingress once a renderer is attached again.
 *
 * Nothing is queued, reordered or rewritten here. Delivery is synchronous and in
 * call order. A frame that finds no target is counted per channel and dropped,
 * because the alternative -- buffering -- would be a second session store, and an
 * ordered stream with a hidden backlog is worse than an honest miss the counters
 * expose. A throw from a live target is deliberately left to escape: that means
 * the channel itself is broken, and counting it as "no renderer" would hide a
 * bug behind a normal-looking drop.
 */

import { FRAME_DELIVER, isFrameChannelKey } from "./channels.js";
import type { FrameChannelKey } from "./channels.js";
import type {
  AttachReason,
  BridgeTransport,
  BridgeTransportStats,
  DetachReason,
  SendTarget,
} from "./types.js";

/** The frame type that belongs to terminal ingress rather than a frame channel. */
const TERM_OUTPUT = "term.output";

/** What the composition root injects. Both members are optional. */
export interface BridgeTransportOptions {
  /**
   * The terminal ingress entry (`TerminalIngress.accept`).
   *
   * Optional so a transport can exist before that piece is wired. With no sink,
   * a `term.output` is counted as dropped rather than vanishing silently.
   */
  onTerminal?: (payload: string, body: unknown) => void;
  /**
   * Whether the current renderer has completed the handshake.
   *
   * Read per frame rather than captured, because acceptance changes under a live
   * transport. Absent means "no gate": callers that do not manage a handshake
   * still get delivery, and only an explicit `false` drops.
   */
  isAccepted?: () => boolean;
}

/** The fields routing needs, plus the body only terminal ingress consumes. */
interface RoutedFrame {
  readonly body: unknown;
  readonly ch: FrameChannelKey;
  readonly seq: number | null;
  readonly t: unknown;
}

/**
 * Read enough of a payload to route it.
 *
 * @returns the routing fields, or `null` when the payload is not a frame. `seq`
 *   is reported only when it is a usable number; a malformed `seq` is a
 *   diagnostic gap, not a reason to refuse a frame whose channel is known.
 */
function readFrame(payload: string): RoutedFrame | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(payload);
  } catch {
    // A truncated or half-written string is not a frame on any channel. It must
    // not abort the caller's delivery loop either, hence the return, not a throw.
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const ch = record["ch"];

  if (!isFrameChannelKey(ch)) return null;

  const seq = record["seq"];

  return {
    body: record["body"],
    ch,
    seq: typeof seq === "number" && Number.isFinite(seq) ? seq : null,
    t: record["t"],
  };
}

/**
 * Build one transport.
 *
 * @param options the terminal sink and the acceptance gate, both optional
 */
export function createBridgeTransport(options: BridgeTransportOptions = {}): BridgeTransport {
  const { onTerminal, isAccepted } = options;

  let target: SendTarget | null = null;
  let disposed = false;
  let generation = 0;
  let sent = 0;
  let parseFailures = 0;
  let beforeAccept = 0;
  let lastSeq: number | null = null;
  const dropped: Record<FrameChannelKey, number> = { control: 0, stream: 0, bulk: 0 };

  function deliver(payload: string): void {
    const frame = readFrame(payload);

    if (frame === null) {
      parseFailures += 1;
      return;
    }

    const { body, ch, seq, t } = frame;

    // A disposed transport is a closed door: even a terminal slice is counted
    // rather than handed to an ingress the host has already torn down.
    if (disposed) {
      dropped[ch] += 1;
      return;
    }

    if (t === TERM_OUTPUT) {
      if (onTerminal === undefined) {
        dropped[ch] += 1;
        return;
      }

      onTerminal(payload, body);
      return;
    }

    if (isAccepted?.() === false && t !== "bridge.accept" && t !== "bridge.reject") {
      beforeAccept += 1;
      return;
    }

    if (target === null || target.isDestroyed()) {
      dropped[ch] += 1;
      return;
    }

    // The original string, not `JSON.stringify(frame)` -- see the file header.
    target.send(FRAME_DELIVER[ch], payload);

    sent += 1;

    // Only frames that crossed IPC move the marker. Terminal slices travel
    // through the ingress, whose own counters say where they are; letting them
    // advance `lastSeq` would make it claim the renderer is further along than
    // it is.
    if (seq !== null) lastSeq = seq;
  }

  function attach(next: SendTarget, _reason: AttachReason): void {
    // Attach is the re-arm point as well as the generation boundary. The
    // transport owns no OS resource, so a host that reuses it after `dispose`
    // (a window recreated after the last one closed) gets delivery back instead
    // of a silently dead pipe.
    target = next;
    disposed = false;
    generation += 1;
  }

  function detach(_reason: DetachReason): void {
    target = null;
  }

  function stats(): BridgeTransportStats {
    // A copy: a diagnostic must not be able to write into the counters it reads.
    return {
      sent,
      dropped: { ...dropped },
      parseFailures,
      beforeAccept,
      lastSeq,
      generation,
    };
  }

  function dispose(): void {
    target = null;
    disposed = true;
  }

  return { attach, detach, deliver, stats, dispose };
}
