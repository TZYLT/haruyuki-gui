/**
 * Public surface of the core's bridge layer.
 *
 * One import path for the producer half of the frame contract: the sender and
 * the parts it assembles. `packages/core/src/index.ts` re-exports this module,
 * so a host writes `@haruyuki/core` and never reaches into a sibling file --
 * moving or renaming a part then stays an internal change.
 *
 * The local declaration below is the layer's own identity string. It is a real
 * value this layer owns, and it keeps the module from being a pure forwarding
 * barrel, which `scripts/check-module-ownership.mjs` rejects: a module whose
 * every statement re-exports another one hides who owns the dependency edge.
 * `packages/ui/src/bridge/index.ts` and the sibling layers (`components`,
 * `i18n`, `icons`, `tokens`) carry the same kind of constant for the same
 * reason.
 *
 * Everything here is producer side. The receiver lives in the renderer
 * (`packages/ui/src/bridge/entry.ts`) and cannot be shared: the renderer may
 * only type-import this package (rule R6), so the two halves agree by contract
 * rather than by importing one implementation.
 */

/** Identifies the core's bridge layer in diagnostics. */
export const BRIDGE_LAYER = "bridge" as const;

/*
 * The sender: the only entry a host calls to emit a frame.
 *
 * Its error classes travel with it because they are part of the frozen
 * vocabulary -- a caller that catches `BRIDGE_QUEUE_OVERFLOW` also has to be
 * able to name `UNREGISTERED_FRAME_TYPE` and `BULK_OVER_LIMIT`.
 */
export {
  BulkOverLimitError,
  UNREGISTERED_FRAME_TYPE,
  UnregisteredFrameTypeError,
  createFrameSender,
} from "./sender";
export type { FrameSender, FrameSenderOptions } from "./sender";

/* The serializer guard: what "a body must be JSON" means, and its error. */
export {
  FRAME_NOT_SERIALIZABLE,
  MAX_DEPTH,
  FrameSerializationError,
  assertSerializable,
  findSerializationViolation,
} from "./validate";
export type { FrameSerializationViolation, SerializationViolationKind } from "./validate";

/* The single global issuer. Hosts read `currentSeq` for diagnostics only. */
export { currentSeq, nextSeq } from "./sequencer";

/* The bounded three-channel backlog, its defaults and its refusal. */
export {
  BRIDGE_QUEUE_OVERFLOW,
  BridgeQueueOverflowError,
  DEFAULT_LIMITS,
  createBoundedQueue,
} from "./queue";
export type { BoundedQueue } from "./queue";

/* The coalescing window; idle for every registered frame type today. */
export {
  BATCH_WINDOW_DEFAULT_MS,
  BATCH_WINDOW_MAX_MS,
  BATCH_WINDOW_MIN_MS,
  createBatchWindow,
} from "./batch";
export type { BatchWindow, BatchWindowOptions } from "./batch";

/*
 * The bulk pager: where a page ends, and the budget the sender splits against.
 * `BULK_OVER_LIMIT` lives here rather than in the sender block because the pager
 * is the module that defines it; the sender only raises it.
 */
export { BULK_OVER_LIMIT, DEFAULT_PAGE_BUDGET_BYTES, createPager } from "./page";
export type { PageResult, Pager } from "./page";

/* The handshake machine and its three frozen bodies. */
export { BRIDGE_VERSION_MISMATCH, createHandshake, evaluateReady } from "./handshake";
export type {
  BridgeAcceptBody,
  BridgeReadyBody,
  BridgeRejectBody,
  HandshakeOptions,
  HandshakeOutcome,
  HandshakeReply,
  HandshakeState,
} from "./handshake";
