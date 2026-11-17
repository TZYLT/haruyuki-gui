/**
 * WebSocket session of one hosted engine attempt.
 *
 * Split out of `engine.ts` so that file no longer carried five
 * responsibilities: connect, adopt, dispatch and drop is a
 * closed loop that owns its own listeners, so it can be reasoned about without
 * the facade's process bookkeeping.
 *
 * What stays the facade's business, and deliberately does not move here:
 *
 * - **State meaning.** A closed socket is recorded as `socketState = "closed"`
 *   and reported to nobody. The signed facade contract keeps `socketState` a
 *   transport fact; what a close *means* (a crash, a reconnect, a user stop) is
 *   decided one layer up. the reconnect layer owns that, so this module must not guess.
 * - **Frame semantics.** `onFrame(at)` is frozen by the facade contract, so this module
 *   captures the timestamp once and fans it out unchanged. `handleSocketData`
 *   is a separate listener on purpose: widening `onFrame` would move a frozen
 *   signature.
 * - **The endpoint.** `release` tells the host, because the advertised endpoint
 *   is part of the facade's frozen surface, not of the transport.
 */

import { connectEngine } from "./connection";
import type { EngineSocket } from "./connection";
import { raceWithFault } from "./start-internals";
import type { FaultSignal } from "./start-internals";

/** Socket lifecycle exposed as `Engine.socketState` (section 3.3 (c)). */
export type EngineSocketState = "idle" | "connecting" | "open" | "closed";

/** What the facade owns while the session owns the socket itself. */
export interface SocketSessionHost {
  /** The socket is gone, so the endpoint the facade advertised is gone too. */
  released(): void;
}

export class SocketSession {
  #socket: EngineSocket | null = null;

  #state: EngineSocketState = "idle";

  #latestFrameAt: number | null = null;

  /** Subscribers of "a frame arrived" (`onFrame`). */
  readonly #frameListeners = new Set<(at: number) => void>();

  /** Raw-frame subscribers for B2's `onMessage`; separate from `#frameListeners`. */
  readonly #messageListeners = new Set<(data: string) => void>();

  /** Forget the previous attempt's transport facts (a new attempt starts idle). */
  reset(): void {
    this.#latestFrameAt = null;
    this.#state = "idle";
  }

  get state(): EngineSocketState {
    return this.#state;
  }

  get lastFrameAt(): number | null {
    return this.#latestFrameAt;
  }

  /**
   * Subscribe to inbound frames. The timestamp is captured before any listener
   * runs, so every subscriber sees the same `at` and `lastFrameAt` already
   * carries it.
   */
  onFrame(callback: (at: number) => void): () => void {
    this.#frameListeners.add(callback);
    return () => {
      this.#frameListeners.delete(callback);
    };
  }

  /** Subscribe to raw decoded text frames. Returns an unsubscribe function. */
  onMessage(callback: (data: string) => void): () => void {
    this.#messageListeners.add(callback);
    return () => {
      this.#messageListeners.delete(callback);
    };
  }

  /** Writes one already-serialised frame; the text passes through unmodified. */
  send(raw: string): void {
    const socket = this.#socket;

    if (socket === null || this.#state !== "open") {
      throw new Error(`the engine socket is "${this.#state}"; only an open one can be written`);
    }

    socket.send(raw);
  }

  /** Connect and adopt the socket; `socketState` tracks the transport. */
  async open(url: string, token: string, fault: FaultSignal): Promise<EngineSocket> {
    this.#state = "connecting";

    const socket = await raceWithFault(connectEngine(url, token), fault.promise);

    this.#socket = socket;
    this.#state = "open";
    socket.on("message", this.#handleMessage);
    socket.on("message", this.#handleData);
    socket.on("close", this.#handleClose);

    return socket;
  }

  /** Capture the frame timestamp first, then notify every subscriber. */
  readonly #handleMessage = (): void => {
    const at = Date.now();
    this.#latestFrameAt = at;

    for (const listener of [...this.#frameListeners]) {
      try {
        listener(at);
      } catch {
        // A subscriber's exception is caught so one bad listener cannot abort
        // the notification of the others or the transport callback. The facade
        // owns no logging channel; the host logs what it subscribes to.
      }
    }
  };

  /**
   * Deliver one raw frame to the `onMessage` subscribers.
   *
   * A **separate** listener rather than a widened `#handleMessage`: `onFrame(at)`
   * is frozen, so its one-argument signature must not move.
   * Binary frames are skipped (the protocol is text), and each
   * subscriber is isolated so one throw cannot stop the next.
   */
  readonly #handleData = (data: Buffer, isBinary: boolean): void => {
    if (isBinary || this.#messageListeners.size === 0) {
      return;
    }

    const text = data.toString("utf8");

    for (const listener of [...this.#messageListeners]) {
      try {
        listener(text);
      } catch {
        // The facade owns no logging channel.
      }
    }
  };

  /** The transport closed; the facade state is untouched here. */
  readonly #handleClose = (): void => {
    this.#state = "closed";
  };

  /**
   * Drop the socket, optionally terminating instead of closing politely.
   *
   * Also used when no socket was adopted (a failed upgrade), so the transport
   * state always ends at `closed` after a failure instead of freezing at the
   * `connecting` it reached.
   */
  release(hard: boolean, host: SocketSessionHost): void {
    const socket = this.#socket;
    this.#socket = null;

    if (socket !== null) {
      socket.removeListener("message", this.#handleMessage);
      socket.removeListener("message", this.#handleData);
      socket.removeListener("close", this.#handleClose);

      try {
        if (hard) {
          socket.terminate();
        } else {
          socket.close(1000, "engine stopping");
        }
      } catch {
        // Already closed by the peer or by the peer's death; nothing to release.
      }
    }

    this.#state = "closed";
    host.released();
  }
}
