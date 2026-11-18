/**
 * The core's frame outlet: one in-process frame in, one pipe message out.
 *
 * A frame leaves the core as an opaque JSON string. Everything downstream -- the
 * extension host and the webview -- treats that string as bytes to carry, not as
 * a value to inspect, because the frame schema is allowed to change without
 * changing the pipe or the panel bridge. This module is therefore the single
 * place where a frame is serialized, and it serializes exactly once:
 *
 * - serializing twice would let a re-encode, a key reorder or a whitespace
 *   change reach the renderer, and "the payload the core emitted" would stop
 *   being one verifiable string;
 * - decoding here and re-encoding later would put a second, drifting copy of the
 *   frame schema in the host.
 *
 * The outlet is shaped like the engine handle's `onFrame` subscription, so a
 * composition root can hand it to the child lifecycle without an adapter:
 * the lifecycle forwards whatever the subscription hands it.
 *
 * Failure policy: encoding never throws. A frame that cannot be carried (a cycle,
 * a `BigInt`, a class instance) is refused with a reason and dropped, because a
 * subscriber that cannot produce bytes must not take the pipe down.
 */

import type { Frame, FrameChannel } from "@haruyuki/protocol";

import { isJsonValue, type CoreFrame } from "./ipc.js";

/** The outcome of encoding one frame: the payload, or the reason it was refused. */
export type FrameEncoding =
  { readonly ok: true; readonly payload: string } | { readonly ok: false; readonly reason: string };

/**
 * What the outlet subscribes to. Structural, so the command service fits it.
 *
 * The callback receives the routing channel as its own argument (the frame still
 * carries `ch`); the outlet checks the two agree rather than trusting one.
 */
export interface FrameSource {
  /** Subscribe to every frame from now on; returns an idempotent unsubscribe. */
  onFrame(callback: (channel: FrameChannel, frame: Frame) => void): () => void;
}

/** The subscription shape the core child's engine handle expects. */
export type EngineFrameSubscription = (
  listener: (channel: FrameChannel, payload: string) => void,
) => () => void;

/**
 * Serialize one frame into the pipe payload.
 *
 * @param frame the frame to carry
 * @returns the JSON string, or the reason the frame is not carryable
 */
export function encodeFrame(frame: Frame): FrameEncoding {
  // `JSON.stringify` can throw on a `BigInt`, on a cycle and on a throwing
  // `toJSON`; the value check rejects more than it does, and the catch covers
  // what remains, so this function keeps its "never throws" promise.
  if (!isJsonValue(frame)) return { ok: false, reason: "the frame is not a JSON value" };

  let payload: string;

  try {
    payload = JSON.stringify(frame);
  } catch (error) {
    return { ok: false, reason: `the frame could not be serialized: ${describe(error)}` };
  }

  if (typeof payload !== "string") return { ok: false, reason: "the frame serialized to nothing" };

  return { ok: true, payload };
}

/**
 * Wrap one encoded frame in the message the pipe carries.
 *
 * @param channel the route the frame travels on
 * @param frame the frame to carry
 * @returns the pipe message, or the reason the frame is not carryable
 */
export function frameMessage(
  channel: FrameChannel,
  frame: Frame,
):
  | { readonly ok: true; readonly message: CoreFrame }
  | { readonly ok: false; readonly reason: string } {
  // The channel is both an envelope field and a routing argument. A frame that
  // disagrees with its own route would be delivered on one channel and read as
  // another, so it is refused here instead of being reconciled silently.
  if (frame.ch !== channel) {
    return {
      ok: false,
      reason: `the frame route ${channel} disagrees with its channel ${frame.ch}`,
    };
  }

  const encoded = encodeFrame(frame);

  if (!encoded.ok) return encoded;

  return { ok: true, message: { kind: "frame", channel, payload: encoded.payload } };
}

/** The handle the composition root keeps while the outlet is subscribed. */
export interface ServiceFrameOutlet {
  /**
   * Subscribe the pipe to the source's frames.
   *
   * The returned function has the engine handle's own signature, so it can be
   * assigned to `engine.onFrame` directly, and it unsubscribes the source.
   */
  readonly onFrame: EngineFrameSubscription;
  /** Drop the subscription. Idempotent; a frame that arrives afterwards is ignored. */
  dispose(): void;
}

/**
 * Build the outlet that turns one source's frames into pipe-ready payloads.
 *
 * @param source the frame source, usually the command service
 * @param log diagnostic sink for refused frames; never receives a payload
 * @returns the outlet; nothing is subscribed until its `onFrame` is called
 */
export function createFrameOutlet(
  source: FrameSource,
  log: (code: string, detail?: Record<string, unknown>) => void = () => undefined,
): ServiceFrameOutlet {
  const live = new Set<(channel: FrameChannel, payload: string) => void>();
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  /** Hand one frame to every live listener as the payload string it encodes to. */
  function deliver(channel: FrameChannel, frame: Frame): void {
    if (disposed) return;

    const encoded = frameMessage(channel, frame);

    if (!encoded.ok) {
      log("CORE_FRAME_REFUSED", { channel, reason: encoded.reason });

      return;
    }

    for (const listener of [...live]) {
      try {
        listener(encoded.message.channel, encoded.message.payload);
      } catch {
        // The pipe failing for one frame is the parent-loss path, which the
        // lifecycle already answers; one listener must not silence the rest.
        log("CORE_FRAME_LISTENER_FAILED", { channel });
      }
    }
  }

  /** Subscribe to the source once, on the first listener. */
  function subscribeOnce(): void {
    if (unsubscribe !== null || disposed) return;

    try {
      unsubscribe = source.onFrame((channel, frame) => {
        deliver(channel, frame);
      });
    } catch {
      // A source that cannot be subscribed is a lifecycle bug at the composition
      // root. Reporting it keeps the pipe silent instead of throwing into it.
      log("CORE_FRAME_SUBSCRIBE_FAILED", {});
    }
  }

  function onFrame(listener: (channel: FrameChannel, payload: string) => void): () => void {
    if (disposed) return () => undefined;

    live.add(listener);
    subscribeOnce();

    let subscribed = true;

    return () => {
      if (!subscribed) return;

      subscribed = false;
      live.delete(listener);
    };
  }

  function dispose(): void {
    if (disposed) return;

    disposed = true;
    live.clear();

    const off = unsubscribe;
    unsubscribe = null;

    try {
      off?.();
    } catch {
      // The outlet is what remains authoritative; a source that throws on
      // unsubscribe must not keep the handle from reporting itself disposed.
      log("CORE_FRAME_UNSUBSCRIBE_FAILED", {});
    }
  }

  return { onFrame, dispose };
}

/**
 * @param value a thrown value
 * @returns its message when it is an `Error`, else its rendering
 */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
