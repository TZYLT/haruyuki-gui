/**
 * Engine host entry point.
 *
 * Public surface of `packages/core/src/engine`, consumed through this barrel and
 * never by reaching into a sibling file. Kept export-only so the module graph
 * stays acyclic and the facade can grow without changing import sites.
 *
 * The host port is not re-exported here: it is a shell-side contract and lives in
 * `packages/core/src/port`.
 */
export * from "./types";
export * from "./spawn";
export * from "./token";
export * from "./port-discovery";
export * from "./connection";
export * from "./engine";
export * from "./errors";
export * from "./attach";

// The reconnect layer is exported by name, not by wildcard: its `createPager` and
// `PageResult` mean a different thing from the bridge's, and a wildcard would let
// two unrelated types claim one name at this boundary.
export {
  createReconnectAgent,
  createEndpointWatcher,
  createRestartPort,
  detectHistoryGap,
  runRecovery,
  streamTruncated,
} from "./reconnect";
export type {
  // `Endpoint` is deliberately not re-exported: the client already publishes one,
  // and two meanings for one word is how a boundary starts lying.
  ReconnectAgent,
  ReconnectAgentOptions,
  ReconnectCause,
  ReconnectState,
  ReconnectStatus,
  RecoveryOutcome,
  RecoveryStep,
  RecoveryStopReason,
  ReplayGap,
  ReplaySink,
  ReplayStateKind,
} from "./reconnect";
