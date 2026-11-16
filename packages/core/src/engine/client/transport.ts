/**
 * 一根 socket 的发送与接收接缝，含「首帧可能早于订阅者」这一窗口的修复。
 *
 * ## 这一层管什么
 *
 * 只做三件事：把文本发出去、把入站帧交给订阅者、把「首帧可能早于订阅者」这个
 * 窗口关掉。**不解析命令、不管在途表、不做去重**——那些在 `channel.ts` 与
 * `send.ts`。
 *
 * ## 为什么发送要能失败得明确
 *
 * 调用方必须能区分「发出去了」和「没发出去」。静默吞掉写失败会让上游以为命令
 * 走了，然后在等一个永不到来的回应——那正是「挂起的 promise 让别处超时」那类
 * 缺陷，定位成本极高。
 *
 * ## 只有一层队列
 *
 * 早到的帧只在 `createTransport` 内部的一处队列里存。曾经想过「`onOpen` 捕获
 * 一份、transport 再存一份」，那会**重复投递**——同一个窗口由两处各自记录，第二个
 * 订阅者会看到两遍。窗口只该有一个所有者。
 */

import { connectEngine } from "../connection";
import type { ConnectEngineOptions, EngineSocket } from "../connection";

/** One frame as it came off the wire, plus when this process saw it. */
export type InboundFrame = {
  /** The frame text, unmodified. Parsing is the caller's business. */
  readonly raw: string;
  /** Local receive time, epoch ms. Never the engine's `emitted_at`. */
  readonly at: number;
};

/** What {@link EngineTransport.send} reports. */
export type TransportWrite =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** Subscriber handle returned by {@link EngineTransport.onFrame}. */
export type Unsubscribe = () => void;

/**
 * The transport seam: one socket, text in, text out.
 *
 * Deliberately not an `EventEmitter`: a plain callback set makes "who sees this
 * frame" answerable by reading one function, and there is one subscriber per
 * channel.
 */
export interface EngineTransport {
  /** True until a close is observed. */
  readonly isOpen: boolean;
  /**
   * Write one frame.
   *
   * @param raw already-serialised frame text
   * @returns `ok:false` with a reason when nothing was written
   */
  send(raw: string): TransportWrite;
  /**
   * Subscribe to inbound frames. Idempotent unsubscribe.
   *
   * Frames that arrived before this call are delivered synchronously, in arrival
   * order, before it returns.
   *
   * @param listener receives each frame with its local receive time
   * @returns unsubscribe
   */
  onFrame(listener: (frame: InboundFrame) => void): Unsubscribe;
  /** Subscribe to the transport closing. Idempotent unsubscribe. */
  onClose(listener: (reason: string) => void): Unsubscribe;
  /** Close the socket. Idempotent. */
  close(): void;
}

/** Options of {@link createTransport} and {@link openTransport}. */
export type TransportOptions = ConnectEngineOptions & {
  /** Local clock, injected so tests need no real time. Defaults to `Date.now`. */
  readonly now?: () => number;
};

/**
 * Frames that arrive before the first subscriber, bounded.
 *
 * The bound is small on purpose: this holds only what a server can emit before our
 * promise resumes - a handful of frames at most. An unbounded queue would let a
 * flooding server turn a wiring bug into growing memory.
 */
const EARLY_FRAME_LIMIT = 64;

/**
 * Wrap a connected socket as a transport.
 *
 * @param socket the socket to adopt; this function installs the listeners
 * @param options clock injection
 * @returns the transport
 */
export function createTransport(
  socket: EngineSocket,
  options: TransportOptions = {},
): EngineTransport {
  const now = options.now ?? Date.now;
  const frameListeners = new Set<(frame: InboundFrame) => void>();
  const closeListeners = new Set<(reason: string) => void>();

  /** The one queue for frames that arrived before anyone subscribed. */
  const early: InboundFrame[] = [];
  let sawSubscriber = false;
  let open = true;

  const deliver = (frame: InboundFrame): void => {
    for (const listener of frameListeners) {
      // One subscriber throwing must not stop the others or lose the frame for
      // them. Letting it propagate would take down the socket's message handler
      // and stop all delivery for everyone.
      try {
        listener(frame);
      } catch {
        // Swallowed on purpose; the channel reports its own failures.
      }
    }
  };

  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      return;
    }

    const frame: InboundFrame = { raw: data.toString("utf8"), at: now() };

    if (!sawSubscriber) {
      // Dropping past the limit is a signal, not silent loss: the channel sees a
      // gap in frames and the diagnostic ring records it. Growing without bound
      // would hide the same problem as an out-of-memory crash instead.
      if (early.length < EARLY_FRAME_LIMIT) {
        early.push(frame);
      }
      return;
    }

    deliver(frame);
  });

  socket.on("close", (_code: number, reason: Buffer) => {
    if (!open) {
      return;
    }

    open = false;
    const text = reason.toString("utf8");

    for (const listener of closeListeners) {
      try {
        listener(text);
      } catch {
        // Same reasoning as in `deliver`.
      }
    }
  });

  return {
    get isOpen(): boolean {
      return open;
    },

    send(raw: string): TransportWrite {
      if (!open) {
        return { ok: false, detail: "the transport is closed" };
      }

      try {
        socket.send(raw);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    },

    onFrame(listener: (frame: InboundFrame) => void): Unsubscribe {
      frameListeners.add(listener);

      if (!sawSubscriber) {
        sawSubscriber = true;

        // Drain before returning, so the caller cannot observe a state where it
        // is subscribed but the first frames are still queued behind it.
        while (early.length > 0) {
          const frame = early.shift();
          if (frame !== undefined) {
            listener(frame);
          }
        }
      }

      return () => {
        frameListeners.delete(listener);
      };
    },

    onClose(listener: (reason: string) => void): Unsubscribe {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    },

    close(): void {
      if (!open) {
        return;
      }

      open = false;
      try {
        socket.close();
      } catch {
        // A socket that is already gone cannot be closed again; the caller's
        // intent (stop using it) is satisfied either way.
      }
    },
  };
}

/**
 * Connect and wrap in one step, keeping frames that arrive before anyone
 * subscribes.
 *
 * The `onOpen` hook is what closes the early-frame window: the socket's `message`
 * listener is installed inside the `open` handler, before this promise resolves,
 * so a server writing in the accept tick cannot write into a gap. Capture and
 * delivery share the one queue inside {@link createTransport} - two queues would
 * deliver the same early frame twice.
 *
 * @param url engine WebSocket endpoint
 * @param token capability token
 * @param options upgrade budget and clock
 * @returns a transport whose early frames are already queued inside it
 */
export async function openTransport(
  url: string,
  token: string,
  options: TransportOptions = {},
): Promise<EngineTransport> {
  const now = options.now ?? Date.now;

  /** Frames captured between `open` and the transport adopting the socket. */
  const captured: InboundFrame[] = [];

  /**
   * The capture listener, so it can be detached once the transport takes over.
   *
   * Assigned inside `onOpen`, which runs before `connectEngine` resolves, so by the
   * time the line below is reached it is either the function or `undefined` (no
   * socket ever opened).
   */
  let captureListener: ((data: Buffer, isBinary: boolean) => void) | undefined;

  const socket = await connectEngine(url, token, {
    ...options,
    onOpen: (opened) => {
      const onCapturedFrame = (data: Buffer, isBinary: boolean): void => {
        if (!isBinary) {
          captured.push({ raw: data.toString("utf8"), at: now() });
        }
      };
      // Detached the moment the transport adopts the socket - see below. Kept as a
      // named function only so the removal can name the same listener.
      captureListener = onCapturedFrame;
      opened.on("message", onCapturedFrame);
    },
  });

  // Stop capturing before `createTransport` installs its own listener. Two
  // listeners alive at once would put a frame arriving in this window into BOTH
  // queues: the capture buffer and the transport's own early queue. The first
  // subscriber would then receive it twice, and the capture buffer - which has no
  // bound - would keep growing for the life of the socket.
  //
  // The window is genuinely narrow (between `connectEngine` resolving and this
  // line), but "narrow" is how a frame arrives twice under load and never in a
  // test.
  if (captureListener !== undefined) {
    socket.removeListener("message", captureListener);
    captureListener = undefined;
  }

  const transport = createTransport(socket, options);

  // Replay what the capture saw, in order, before returning. `createTransport`'s
  // own queue starts empty and its listener is installed by the time this runs,
  // so these frames take the same path as any later one.
  //
  // The queue is emptied by `splice`, and that is deliberately the ONLY thing
  // preventing a second replay - not also a boolean flag. Two guards over the same
  // mistake hide each other: with both present, disabling either leaves the other
  // correct, so no test can tell which one is doing the work. Measured: a
  // flag-plus-splice pair survived the flag being disabled. One mechanism, one test.
  const deliverEarly = transport.onFrame;

  return {
    // `isOpen` must stay live, so it is re-declared as a getter rather than spread
    // in. Spreading evaluates the getter once and freezes the answer: the copy
    // would report `isOpen === true` forever, including after the connection went
    // away. Everything else on this object is a method or a stable value, so the
    // spread is fine for them.
    get isOpen(): boolean {
      return transport.isOpen;
    },
    onFrame(listener: (frame: InboundFrame) => void): Unsubscribe {
      for (const frame of captured.splice(0, captured.length)) {
        listener(frame);
      }

      return deliverEarly(listener);
    },
    // Bound to the transport rather than spread, because they are called as
    // properties of the returned object and spreading would keep the original
    // `this`. Explicit for the same reason `isOpen` is explicit.
    send: (raw: string): TransportWrite => transport.send(raw),
    onClose: (listener: (reason: string) => void): Unsubscribe => transport.onClose(listener),
    close: (): void => transport.close(),
  };
}
