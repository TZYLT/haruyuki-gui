/**
 * @haruyuki/protocol
 *
 * Responsibility: transport-neutral contracts (message envelopes, payload types
 * and version descriptors) shared by the Electron shell, the VSCode extension
 * shell and the shared core.
 *
 * Placeholder only: real contracts are filled in by later work packages.
 */
export const PROTOCOL_PACKAGE_NAME = "@haruyuki/protocol" as const;

/**
 * The generated wire <-> capability map. Re-exported only: this package
 * must not add logic around it, and the artifact itself is never edited by hand.
 */
export {
  CAPABILITY_META,
  CAPABILITY_SNAPSHOT_ENGINE,
  CAPABILITY_TO_WIRE,
} from "./contract/command-map.generated";
export type {
  CapabilityMeta,
  CapabilityName,
  CapabilityScope,
  CapabilityShape,
} from "./contract/command-map.generated";

/**
 * The frame layer: the envelope every channel shares, plus the
 * append-only frame type table that `scripts/check-frame.mjs` scans.
 *
 * Re-exported from the defining modules rather than through a `frame/index.ts`
 * barrel. This repository forbids pure forwarding modules below a package root
 * (`scripts/module-ownership.json`): they hide the real dependency edge and
 * make a cycle invisible. `contract/` above follows the same rule.
 */
export * from "./frame/frame.js";
export * from "./frame/frame-types.js";

/**
 * The layout wire contract: the document schema and the one
 * `layout.snapshot` payload set. These are transport-neutral types only; the
 * store and channel that use them live in @haruyuki/core.
 */
export * from "./layout/layout-doc.js";
export * from "./layout/layout-frame.js";

/**
/**
 * The conversation content contract: the block union a surface draws and the
 * update envelope a conversation store files under one message. Plain data
 * only; the model that produces blocks and the store that keeps turns live in
 * @haruyuki/core.
 */
export * from "./content/index.js";

/**
 * The session contract: the nine entity shapes a renderer folds state into, the
 * derived views it renders, the codes it maps to its own wording, and the
 * selector request/result pair the store answers on a control frame.
 *
 * Types only. The store that produces them lives in @haruyuki/core.
 */
export * from "./session/types.js";
export * from "./session/select.js";

/**
 * The typed capability layer (docs/62 §6.1, docs/63 §3.1): one row per
 * capability, `{ input; output }`, composed per domain. E1's `FZ-12` types
 * `CommandCall.capability`/`body` and `CommandReply.data` with the two aliases
 * below; pages never import the rows directly.
 *
 * The dependency on `@letta-ai/letta-client` is type-only and deliberate
 * three domain roots (`AgentState`, `Conversation`, `Message`)
 * are defined by that SDK, so referencing the definition beats re-declaring a
 * shape that silently drifts. Their member types expand from the SDK's `.d.ts`;
 * this package does not re-export any SDK type.
 */
export type {
  CapabilityInput,
  CapabilityIo,
  CapabilityIoTypes,
  CapabilityOutput,
} from "./contract/capability-types/types.js";
