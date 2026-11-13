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
