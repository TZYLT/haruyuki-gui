/**
 * The composition root for one app's bridge.
 *
 * Three pieces meet here and nowhere else:
 *
 *   transport   moves frame strings to the current renderer
 *   session     owns one generation's sender and handshake
 *   ingress     buffers terminal bytes and enforces the ack window
 *
 * The host exists so the producer (core / B2) holds one stable `FrameSink` for
 * the app's lifetime while the thing behind it is replaced on every reload. The
 * producer must never see a closed sender: that is what produces
 * "works until you press Ctrl+R" bridges.
 *
 * `bridge.accept` and `bridge.reject` are produced by C5's sender through the
 * transport. The host observes them on the way out to learn whether the current
 * generation is usable; it does not decide the verdict itself.
 */

import type { Frame } from "@haruyuki/protocol";

import { BRIDGE_NO_SESSION } from "./types.js";
import type {
  AttachReason,
  BridgeSessionHost,
  BridgeSessionStats,
  DetachReason,
  SendTarget,
  TermOutputBody,
} from "./types.js";
import { createBridgeTransport } from "./transport.js";
import { createTerminalIngress } from "./terminal-ingress.js";
import { createSession, type Session } from "./session.js";

/** The host's optional log sink; it must never throw. */
export type BridgeHostLog = (event: string, detail?: Record<string, unknown>) => void;

/** What the app injects once. */
export interface BridgeHostOptions {
  /** The exact version C5's handshake accepts (C5-Q07). */
  readonly expectedBridgeVersion: string;
  /** Reported in `bridge.accept`; diagnostic only. */
  readonly coreVersion: string;
  /** Bulk pages the renderer should expect. 0 means "single page". */
  readonly bulkPages: number;
  /** Optional; used for the few paths with no other visible signal. */
  readonly log?: BridgeHostLog;
}

/**
 * Build the app-wide host.
 *
 * @param options the version facts and an optional log sink
 */
export function createBridgeHost(options: BridgeHostOptions): BridgeSessionHost {
  let target: SendTarget | null = null;
  let current: Session | null = null;
  let generation = 0;
  let noSession = 0;
  let closedFailures = 0;

  const ingress = createTerminalIngress();

  /**
   * Send on the ingress's behalf.
   *
   * The transport has its own target; the ingress does not, because it is
   * attached at handshake time rather than at window time. Both check
   * `isDestroyed` -- a window can disappear between the accept and a timer.
   */
  const sendToRenderer = (channel: string, payload: unknown): void => {
    if (target === null || target.isDestroyed()) return;

    target.send(channel, payload);
  };

  const transport = createBridgeTransport({
    isAccepted: () => current?.accepted ?? false,
    onTerminal: (payload, body) => {
      const term = readTermBody(body);

      if (term === null) {
        options.log?.("bridge.terminal.body.invalid");
        return;
      }

      ingress.accept(payload, term);
    },
  });

  /**
   * The sender's `deliver`, with one observation added.
   *
   * `accept`/`reject` are the only frames whose meaning the host needs. They are
   * emitted synchronously by C5's sender while `submit` runs, so marking the
   * session here is safe and keeps the verdict in one place.
   */
  const deliver = (payload: string): void => {
    const t = peekType(payload);

    if (t === "bridge.accept") {
      current?.markAccepted();
      ingress.attach(sendToRenderer);
    } else if (t === "bridge.reject") {
      current?.markRejected();
    }

    transport.deliver(payload);
  };

  function attach(next: SendTarget, reason: AttachReason): void {
    // A second attach without a detach is a reload path that skipped its own
    // cleanup; close the old generation rather than leaking it.
    if (current !== null) detach("reload");

    target = next;
    generation += 1;

    transport.attach(next, reason);

    current = createSession({
      deliver,
      expectedBridgeVersion: options.expectedBridgeVersion,
      coreVersion: options.coreVersion,
      bulkPages: options.bulkPages,
    });
  }

  function detach(reason: DetachReason): void {
    transport.detach(reason);
    ingress.detach();

    if (current !== null) {
      closedFailures += current.stats.closeFailures;
      current.close();
      current = null;
    }

    target = null;
  }

  function send(frame: Frame): void {
    if (current === null) {
      noSession += 1;
      throw new Error(BRIDGE_NO_SESSION);
    }

    current.sender.send(frame);
  }

  function submit(payload: string): void {
    if (current === null) {
      noSession += 1;
      throw new Error(BRIDGE_NO_SESSION);
    }

    current.submit(payload);
  }

  function ack(terminalId: string, bytes: number): void {
    ingress.ack(terminalId, bytes);
  }

  function stats(): BridgeSessionStats {
    const beforeAccept = transport.stats().beforeAccept;

    return {
      generation,
      accepted: current?.accepted ?? false,
      rejected: current?.rejected ?? false,
      beforeAccept,
      noSession,
      closeFailures: closedFailures + (current?.stats.closeFailures ?? 0),
    };
  }

  function dispose(): void {
    detach("close");
    transport.dispose();
    ingress.dispose();
  }

  return {
    send,
    get stats() {
      return stats();
    },
    attach,
    detach,
    submit,
    ack,
    dispose,
  };
}

/** Read only the type field; a malformed payload is not a handshake reply. */
function peekType(payload: string): unknown {
  try {
    const parsed: unknown = JSON.parse(payload);

    if (typeof parsed !== "object" || parsed === null) return undefined;

    return (parsed as Record<string, unknown>)["t"];
  } catch {
    return undefined;
  }
}

/**
 * Accept a term.output body from C5.
 *
 * The numeric fields are diagnostics; the two the ingress cannot work without
 * are the terminal id and the text. A body missing them is a producer bug and
 * is dropped with a log line rather than charged to an empty terminal id.
 */
function readTermBody(body: unknown): TermOutputBody | null {
  if (typeof body !== "object" || body === null) return null;

  const record = body as Record<string, unknown>;
  const terminalId = record["terminal_id"];
  const text = record["text"];

  if (typeof terminalId !== "string" || terminalId === "") return null;
  if (typeof text !== "string") return null;

  return {
    terminal_id: terminalId,
    text,
    slice: readNumber(record["slice"]),
    slices: readNumber(record["slices"]),
    offset: readNumber(record["offset"]),
    bytes: readNumber(record["bytes"]),
    final: record["final"] === true,
  };
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
