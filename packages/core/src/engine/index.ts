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
//
// Each name comes from the module that declares it, not from the layer's own
// `index.ts`: that file was a barrel with twenty-two forwarding statements and one
// consumer - this one - so it added a hop without adding a boundary, and the
// module gate rightly refused it. Inlining the names removes the hop; the rule the
// barrel's header described (the sequence is assembled in `agent.ts`, never by a
// caller) is a property of that module and is unaffected.
export { createReconnectAgent } from "./reconnect/agent.js";
export { createEndpointWatcher } from "./reconnect/endpoints.js";
export { createRestartPort } from "./reconnect/restart.js";
export { detectHistoryGap, streamTruncated } from "./reconnect/gaps.js";
export { runRecovery } from "./reconnect/recovery.js";
export type {
  // `Endpoint` is deliberately not re-exported: the client already publishes one,
  // and two meanings for one word is how a boundary starts lying.
  ReconnectAgent,
  ReconnectAgentOptions,
} from "./reconnect/agent.js";
export type {
  ReconnectCause,
  ReconnectState,
  ReconnectStatus,
  RecoveryStep,
  ReplayGap,
  ReplaySink,
  ReplayStateKind,
} from "./reconnect/types.js";
export type { RecoveryOutcome, RecoveryStopReason } from "./reconnect/recovery.js";
