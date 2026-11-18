/**
 * One bridge session: the sender and the handshake for a single renderer
 * generation.
 *
 * C5's handshake is a terminal state machine: once it has answered
 * `bridge.accept` or `bridge.reject`, a second `bridge.ready` produces no reply.
 * Reusing a session across a reload would therefore leave the new page waiting
 * forever -- its ready would land on a machine that already answered. The only
 * correct shape is one session per attach, which is what this module makes
 * explicit.
 *
 * The session owns the sender but not its transport: the host passes `deliver`,
 * so the same session type can be tested with a recording function and used in
 * production with the real IPC path.
 */

import type { Frame } from "@haruyuki/protocol";
import { createFrameSender, createHandshake, type FrameSender } from "@haruyuki/core/bridge";

/** What one session needs from its host. */
export interface SessionOptions {
  /** Delivers one serialized frame; must not rewrite it. */
  readonly deliver: (payload: string) => void;
  /** The exact version this core accepts (C5-Q07). */
  readonly expectedBridgeVersion: string;
  /** Reported in `bridge.accept`, diagnostic only. */
  readonly coreVersion: string;
  /** Number of bulk pages the renderer should expect; 0 means "single page". */
  readonly bulkPages: number;
}

/** The per-generation counters the host aggregates. */
export interface SessionStats {
  closeFailures: number;
  submitFailures: number;
}

/** One generation's producer. */
export interface Session {
  readonly sender: FrameSender;
  readonly accepted: boolean;
  readonly rejected: boolean;
  readonly stats: SessionStats;
  /** Feed one renderer-originated frame (the ready frame and later UI controls). */
  submit(payload: string): void;
  /** Called by the host when the sender emitted `bridge.accept`. */
  markAccepted(): void;
  /** Called by the host when the sender emitted `bridge.reject`. */
  markRejected(): void;
  /** Close the sender; idempotent, and never throws. */
  close(): void;
}

/** Build one session. */
export function createSession(options: SessionOptions): Session {
  let accepted = false;
  let rejected = false;
  let closed = false;
  const stats: SessionStats = { closeFailures: 0, submitFailures: 0 };

  const handshake = createHandshake({
    expectedBridgeVersion: options.expectedBridgeVersion,
    coreVersion: options.coreVersion,
    bulkPages: options.bulkPages,
  });

  const sender = createFrameSender({
    transport: options.deliver,
    handshake,
  });

  return {
    sender,
    get accepted() {
      return accepted;
    },
    get rejected() {
      return rejected;
    },
    stats,
    submit(payload) {
      if (closed) {
        stats.submitFailures += 1;
        return;
      }

      let frame: Frame;

      try {
        frame = JSON.parse(payload) as Frame;
      } catch {
        stats.submitFailures += 1;

        return;
      }

      try {
        sender.send(frame);
      } catch {
        // A malformed frame is a renderer bug, not a reason to tear the session
        // down. The count is the diagnostic; the next valid frame still works.
        stats.submitFailures += 1;
      }
    },
    markAccepted() {
      accepted = true;
    },
    markRejected() {
      rejected = true;
    },
    close() {
      if (closed) return;

      closed = true;

      try {
        sender.close();
      } catch {
        // The flag above already makes send refuse. A throwing transport must
        // not stop the host from detaching every other piece of the session.
        stats.closeFailures += 1;
      }
    },
  };
}
