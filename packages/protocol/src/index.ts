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
