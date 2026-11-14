/**
 * Frame layer: the wire envelope every host and the core agree on.
 *
 * A frame is a flat, self-describing
 * envelope, never a class and never a union discriminant on `body`: the
 * transport must be able to route on `ch` alone, before a body decoder is
 * chosen. That is why `Frame["t"]` stays a plain `string` -- a host may inject
 * frame types this package does not know about (C5-Q24); the repository's own
 * literals are checked against `FRAME_TYPES` by `scripts/check-frame.mjs`
 * instead of by narrowing the type.
 *
 * The three channels are physically different streams, not three labels for
 * the same one:
 *
 * - `control` carries ordered, acknowledged request/response traffic;
 * - `stream` carries byte progress (`term.output`) where dropping a frame is a
 *   correctness bug, so coalescing is off;
 * - `bulk` carries paged snapshot content whose pages are independently
 *   resumable through a watermark plus a token.
 *
 * Nothing here validates: parsing and rejection belong to the core, so this
 * file stays a pure description that a renderer can type-import.
 */

/**
 * Wire version of the frame envelope.
 *
 * Bumped only when an existing envelope field changes meaning. Adding a frame
 * type is a `FRAME_TYPES` row, not a version bump: the type table is
 * append-only, and unknown `t` values are meant to be
 * carried, not refused.
 */
export const FRAME_PROTOCOL_VERSION = 1 as const;

/**
 * The physical stream a frame travels on.
 *
 * A frame belongs to exactly one channel for its whole life; the channel is
 * part of the envelope so a router never has to decode `body` first.
 */
export type FrameChannel = "control" | "stream" | "bulk";

/**
 * The common envelope of every frame on every channel.
 *
 * @typeParam T the frame type literal, e.g. `"bulk.page"`. Deliberately open:
 *   a host-injected table is a legal producer (C5-Q24).
 * @typeParam B the decoded body. `unknown` by default so a consumer must
 *   narrow before reading, rather than inheriting an unchecked shape.
 */
export interface Frame<T extends string = string, B = unknown> {
  v: typeof FRAME_PROTOCOL_VERSION;
  ch: FrameChannel;
  /** Global monotonic counter, assigned by the core's single sequencer. */
  seq: number;
  t: T;
  body: B;
}

/**
 * A control-channel frame: the envelope plus the correlation id of the
 * request that caused it.
 *
 * `reqId` lives on the envelope rather than inside `body` because the core
 * matches an answer to a pending request before any body decoder runs.
 */
export interface ControlFrame<T extends string = string, B = unknown> extends Frame<T, B> {
  ch: "control";
  reqId: string;
}

/**
 * A bulk-channel frame: the envelope plus the paging cursor of a snapshot.
 *
 * The three paging fields travel together on purpose. A watermark alone cannot
 * distinguish "nothing new" from "a resumed stream", and a token alone cannot
 * say where in the snapshot the page starts, so a resumable read needs both.
 */
export interface BulkFrame<T extends string = string, B = unknown> extends Frame<T, B> {
  ch: "bulk";
  page: {
    /** Snapshot position this page starts at; monotonic within one snapshot. */
    watermark: number;
    /** Opaque resume handle; the core mints it, the host only passes it back. */
    token: string;
    /** `true` when at least one further page follows this one. */
    more: boolean;
  };
}
