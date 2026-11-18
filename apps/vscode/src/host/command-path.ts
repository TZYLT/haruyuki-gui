/**
 * The extension host's command and frame path: the two directions between the
 * webview, this host and the core child.
 *
 *   core -> pipe -> host -> webview
 *     The core serializes a frame once and hand it over as an opaque JSON
 *     string. This module forwards that string unchanged. It does NOT parse it,
 *     reorder its keys or re-encode it, and that is a load-bearing rule rather
 *     than an optimisation: parsing here would make the host a second, silently
 *     drifting reader of a schema it does not own, and any re-encode would mean
 *     the bytes the renderer receives are the host's rendering of the frame
 *     instead of the core's. A payload that is not valid JSON still has to
 *     travel: it is bytes to carry, not a value to inspect.
 *
 *   webview -> host -> pipe -> core
 *     The panel sends `command.invoke`; this module validates the id and the call
 *     before forwarding it, because the panel is a browser context whose message
 *     may be anything at all. The core answers `command.reply`, which travels back
 *     correlated by the host's own id.
 *
 * Id ownership, deliberately split across the two legs:
 *
 * - The id the CORE sees is minted by the host-side pipe (`CoreProcessHost`
 *   uses a fresh UUID per invoke) and echoed by the core. The panel's id is never
 *   reused for it, so two panels cannot collide inside one command budget.
 * - The id the PANEL sees is the one it sent, echoed back so it can correlate its
 *   own pending entry. When the panel omits it, the host mints one instead of
 *   making the caller guess.
 *
 * Failure policy: nothing here rejects. A bad message is refused with a reason,
 * a command that cannot be answered becomes the failure arm of `CommandReply`,
 * and an in-flight command is settled on reply, on its budget and on `dispose`.
 * A closed panel or a crashed core therefore produces a failed command, never a
 * caller waiting for an answer that cannot come.
 */

import { randomUUID } from "node:crypto";

import type { CommandCall, CommandReply } from "@haruyuki/core";
import type { FrameChannel } from "@haruyuki/protocol";

import { narrowCommandCall, type CoreFrame } from "../core/ipc.js";

/** The longest panel id this host will carry back; long ids are a panel bug. */
const CALL_ID_LIMIT = 128;

/**
 * Default budget for the panel leg.
 *
 * Deliberately longer than the pipe's own command budget: the host-side pipe
 * answers `TIMEOUT` first in the normal case, and its code is the more precise
 * one. This budget exists for the case where the port itself goes silent.
 */
const DEFAULT_REPLY_TIMEOUT_MS = 65_000;

/** One message this host hands to the panel. The panel bridge owns the rest. */
export type HostToWebview =
  | { readonly kind: "frame"; readonly channel: FrameChannel; readonly payload: string }
  | { readonly kind: "command.reply"; readonly callId: string; readonly reply: CommandReply };

/** The one ability this module needs from a panel: post a message into it. */
export type WebviewPost = (message: HostToWebview) => void;

/** Where frames and replies leave this host, whichever panel is connected. */
export interface HostOutbox {
  /** Carry one frame's payload. The payload is never inspected on the way. */
  postFrame(channel: FrameChannel, payload: string): void;
  /** Answer one panel command. */
  postReply(callId: string, reply: CommandReply): void;
}

/** One command leg: everything this module needs to reach the core. */
export interface CommandPort {
  /** Send one command. The port answers a failure arm rather than rejecting. */
  invoke(call: CommandCall): Promise<CommandReply>;
}

/** One frame leg: the pipe's frame subscription. */
export interface FramePort {
  /** Subscribe to frames from now on; returns an idempotent unsubscribe. */
  onFrame(callback: (frame: CoreFrame) => void): () => void;
}

/** Both legs, so a composition root can pass one object. */
export type HostPorts = CommandPort & FramePort;

/** Diagnostic sink: codes and ids, never frame bodies or secrets. */
export type HostPathLog = (code: string, detail?: Record<string, unknown>) => void;

/** The answer to one inbound panel message. Never throws. */
export type InboundResult =
  | { readonly ok: true; readonly handled: "command" }
  | { readonly ok: false; readonly reason: string }
  /** A well-formed message this module does not own; the panel bridge handles it. */
  | { readonly ok: true; readonly handled: "ignored" };

/**
 * Build the outbox a panel is reachable through.
 *
 * The post function is injected so this module never binds the VSCode API: the
 * composition root passes `(message) => panel.webview.postMessage(message)`.
 *
 * @param post the panel's postMessage, bound to one panel
 * @param log diagnostic sink for a panel that refuses a message
 * @returns the outbox the paths below hand frames and replies to
 */
export function createOutbox(post: WebviewPost, log: HostPathLog = () => undefined): HostOutbox {
  function deliver(message: HostToWebview, label: string): void {
    try {
      post(message);
    } catch {
      // A disposed panel is the normal case here, not an error to surface: the
      // frame is already lost, and retrying would duplicate it if the failure
      // was in the acknowledgement rather than in the write.
      log("HOST_WEBVIEW_POST_FAILED", { label });
    }
  }

  return {
    postFrame(channel: FrameChannel, payload: string): void {
      deliver({ kind: "frame", channel, payload }, "frame");
    },
    postReply(callId: string, reply: CommandReply): void {
      deliver({ kind: "command.reply", callId, reply }, "command.reply");
    },
  };
}

/** The handle the composition root keeps for the frame direction. */
export interface FrameForwarder {
  /** Drop the pipe subscription. Idempotent. */
  dispose(): void;
}

/**
 * Forward every core frame to the panel, payload byte for byte.
 *
 * @param options the frame leg, the outbox and the diagnostic sink
 * @returns the forwarder; the subscription is installed immediately
 */
export function createFrameForwarder(options: {
  readonly host: FramePort;
  readonly outbox: HostOutbox;
  readonly log?: HostPathLog;
}): FrameForwarder {
  const log = options.log ?? ((): void => undefined);
  let off: (() => void) | null = null;
  let disposed = false;

  try {
    off = options.host.onFrame((frame) => {
      if (disposed) return;

      // The narrowed pipe message guarantees a string; the check is here because
      // a payload that is not a string cannot be carried and must not be
      // stringified into one, which would be the re-encode this module forbids.
      if (typeof frame.payload !== "string") {
        log("HOST_FRAME_REFUSED", { channel: frame.channel, reason: "payload is not a string" });

        return;
      }

      // The exact string the core emitted. No parse, no stringify, no reorder.
      options.outbox.postFrame(frame.channel, frame.payload);
    });
  } catch {
    log("HOST_FRAME_SUBSCRIBE_FAILED", {});
  }

  return {
    dispose(): void {
      if (disposed) return;

      disposed = true;

      const current = off;
      off = null;

      try {
        current?.();
      } catch {
        log("HOST_FRAME_UNSUBSCRIBE_FAILED", {});
      }
    },
  };
}

/** One command waiting for the core's answer. */
type PendingCommand = {
  readonly timer: ReturnType<typeof setTimeout>;
};

/** The handle the composition root keeps for the command direction. */
export interface CommandPath {
  /**
   * Take one raw message from the panel.
   *
   * @param raw whatever the panel sent, unvalidated
   * @returns what happened, as a value; never a throw
   */
  receive(raw: unknown): InboundResult;
  /** How many commands are in flight right now. */
  readonly pending: number;
  /** Settle every in-flight command as failed and ignore anything later. */
  dispose(): void;
}

/**
 * Build the webview -> host -> core command path.
 *
 * @param options the command leg, the outbox and the panel-leg budget override
 * @returns the path
 */
export function createCommandPath(options: {
  readonly host: CommandPort;
  readonly outbox: HostOutbox;
  readonly log?: HostPathLog;
  /** Override for the panel-leg budget. */
  readonly replyTimeoutMs?: number;
}): CommandPath {
  const log = options.log ?? ((): void => undefined);
  const replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

  const inFlight = new Map<string, PendingCommand>();
  let disposed = false;

  /** Answer one panel command once, whether the core replied or the budget ran out. */
  function settle(callId: string, reply: CommandReply): void {
    const pending = inFlight.get(callId);

    if (pending === undefined) return;

    inFlight.delete(callId);
    clearTimeout(pending.timer);

    if (disposed) return;

    options.outbox.postReply(callId, reply);
  }

  /** Refuse one message: the panel is told, and the host log records why. */
  function refuse(callId: string | null, detail: string): InboundResult {
    log("HOST_COMMAND_REFUSED", { code: "REJECTED", detail });

    // A refusal with no id has nobody to answer; the log line is the record.
    if (callId !== null && !disposed) {
      options.outbox.postReply(callId, { ok: false, code: "REJECTED", detail });
    }

    return { ok: false, reason: detail };
  }

  /**
   * Run one validated command and answer the panel.
   *
   * @param callId the id the panel correlates on
   * @param call the validated command
   */
  function run(callId: string, call: CommandCall): void {
    // The budget is this leg's own: the pipe settles its in-flight commands on a
    // shorter budget and on every stop, so this one only fires when the port
    // itself went silent. Leaving the entry in the table would keep the id
    // unusable for the rest of the session.
    const timer = setTimeout(() => {
      settle(callId, {
        ok: false,
        code: "TIMEOUT",
        detail: `no command reply within ${String(replyTimeoutMs)} ms`,
      });
    }, replyTimeoutMs);

    inFlight.set(callId, { timer });

    let answer: Promise<CommandReply>;

    try {
      answer = options.host.invoke(call);
    } catch (error) {
      // The port promises a failure arm rather than a rejection; if that ever
      // regresses, the panel still gets an answer instead of a hung command.
      answer = Promise.resolve({ ok: false, code: "REJECTED", detail: describe(error) });
    }

    void answer
      .then((reply) => {
        settle(callId, reply);
      })
      .catch((error: unknown) => {
        settle(callId, { ok: false, code: "REJECTED", detail: describe(error) });
      });
  }

  function receive(raw: unknown): InboundResult {
    if (disposed) return { ok: false, reason: "the command path is disposed" };

    // Not ours. The panel bridge routes the other message families, and refusing
    // an unrecognised kind here would make this module claim a vocabulary it
    // does not own, so the caller decides instead.
    const kind = isRecord(raw) ? raw.kind : undefined;

    if (kind !== "command.invoke") return { ok: true, handled: "ignored" };

    const narrowed = narrowInvoke(raw);

    if (!narrowed.ok) {
      // A malformed call has no reliable id to answer, so it is only logged: a
      // reply the panel cannot correlate would be a second protocol invention.
      return refuse(narrowed.callId, narrowed.reason);
    }

    const { callId, call } = narrowed;

    // One id, one answer. Accepting a duplicate would make the reply ambiguous
    // and would let a panel overwrite another command's pending entry.
    if (inFlight.has(callId)) {
      return refuse(callId, `the callId ${consoleSafe(callId)} is already in flight`);
    }

    run(callId, call);

    return { ok: true, handled: "command" };
  }

  return {
    receive,
    get pending(): number {
      return inFlight.size;
    },
    dispose(): void {
      if (disposed) return;

      disposed = true;

      for (const pending of inFlight.values()) {
        clearTimeout(pending.timer);
      }

      inFlight.clear();
    },
  };
}

/** One validated panel command, or the reason it was not forwarded. */
type NarrowedInvoke =
  | { readonly ok: true; readonly callId: string; readonly call: CommandCall }
  | { readonly ok: false; readonly callId: string | null; readonly reason: string };

/**
 * Validate one `command.invoke` from the panel.
 *
 * The id is checked for shape and length, and the call is narrowed by the pipe's
 * own helper: the two sides must agree on what a command is, and re-deciding it
 * here would be exactly the drift the shared narrowing exists to prevent.
 *
 * @param raw the candidate message
 * @returns the command to forward, or the reason it is refused
 */
function narrowInvoke(raw: unknown): NarrowedInvoke {
  if (!isRecord(raw)) return { ok: false, callId: null, reason: "the message is not an object" };

  const rawId = raw.callId;
  const usableId = typeof rawId === "string" && rawId.length > 0 && rawId.length <= CALL_ID_LIMIT;

  // An id that is present but unusable is refused rather than replaced: a silent
  // remint would answer a request the panel never made.
  if (rawId !== undefined && !usableId) {
    return {
      ok: false,
      callId: null,
      reason:
        typeof rawId === "string"
          ? `the callId exceeds ${String(CALL_ID_LIMIT)} characters`
          : "the callId is not a string",
    };
  }

  const narrowed = narrowCommandCall(raw.call);

  if (!narrowed.ok) return { ok: false, callId: usableId ? rawId : null, reason: narrowed.reason };

  return {
    ok: true,
    callId: usableId ? rawId : mintPanelId(),
    call: narrowed.message,
  };
}

/**
 * @param callId a validated panel id
 * @returns it, quoted for a log line
 */
function consoleSafe(callId: string): string {
  return JSON.stringify(callId.slice(0, CALL_ID_LIMIT));
}

/** @returns a fresh id for a panel command that carried none */
function mintPanelId(): string {
  return `host-${randomUUID()}`;
}

/**
 * @param value a thrown value
 * @returns its message when it is an `Error`, else its rendering
 */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * @param value any value
 * @returns whether it is a non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
