/**
 * The shapes D3's main-process pieces agree on.
 *
 * Types live here, implementations live next to them, and the tests can build a
 * fake of any one piece from this file alone. That matters for a transport: the
 * question "does a frame survive the trip byte for byte" must be answerable
 * without launching Electron.
 *
 * Nothing here imports `electron`. `SendTarget` is the two members the transport
 * needs from a `WebContents`, so a test can pass a destroyed or a recording
 * target without a browser process.
 */

import type { Frame } from "@haruyuki/protocol";

/** Why a renderer target was attached. Diagnostic only. */
export type AttachReason = "boot" | "load" | "rebuild";

/** Why a renderer target was detached. Diagnostic only. */
export type DetachReason = "reload" | "crash" | "close" | "fail-load";

/** The slice of `WebContents` the transport uses. */
export interface SendTarget {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/** The producer-side error when there is no session to send through. */
export const BRIDGE_NO_SESSION = "BRIDGE_NO_SESSION" as const;

/** A producer's stable handle on the current session. */
export interface FrameSink {
  send(frame: Frame): void;
  readonly stats: BridgeSessionStats;
}

/** Per-generation counters. */
export interface BridgeSessionStats {
  generation: number;
  accepted: boolean;
  rejected: boolean;
  beforeAccept: number;
  noSession: number;
  closeFailures: number;
}

/** The host a shell holds for the lifetime of the app. */
export interface BridgeSessionHost extends FrameSink {
  attach(target: SendTarget, reason: AttachReason): void;
  detach(reason: DetachReason): void;
  submit(payload: string): void;
  ack(terminalId: string, bytes: number): void;
  dispose(): void;
}

/** Per-channel delivery counters. */
export interface BridgeTransportStats {
  sent: number;
  dropped: Record<"control" | "stream" | "bulk", number>;
  parseFailures: number;
  beforeAccept: number;
  lastSeq: number | null;
  generation: number;
}

/** The byte mover. It never owns a session; the host tells it which one is live. */
export interface BridgeTransport {
  attach(target: SendTarget, reason: AttachReason): void;
  detach(reason: DetachReason): void;
  deliver(payload: string): void;
  stats(): BridgeTransportStats;
  dispose(): void;
}

/**
 * Body of one `term.output` slice (requirement doc 38 section 6.2).
 *
 * D3 defines this for its E3 hand-off; C5 froze the frame type and the 8 KB
 * slicing, not the body. `text` is already a JS string: D3 never decodes bytes
 * to text, so a slice can never split a UTF-8 code point.
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

/** The terminal ingress counters a diagnostic can read. */
export interface TerminalIngressStats {
  terminals: number;
  sentBytes: number;
  ackedBytes: number;
  droppedBytes: number;
  pendingBytes: number;
  unackedBytes: number;
}

/**
 * The bounded terminal entry.
 *
 * `accept` is called by the host for every `term.output`; `ack` by the host when
 * the renderer confirms bytes. `attach` receives the send function once the
 * renderer's handshake is accepted -- before that, there is no one to send to.
 */
export interface TerminalIngress {
  accept(payload: string, body: TermOutputBody): void;
  ack(terminalId: string, bytes: number): void;
  attach(send: (channel: string, payload: unknown) => void): void;
  detach(): void;
  flushNotices(): void;
  stats(): TerminalIngressStats;
  dispose(): void;
}
