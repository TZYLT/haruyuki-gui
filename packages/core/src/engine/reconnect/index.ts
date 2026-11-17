/**
 * The reconnect layer's public surface.
 *
 * One import for a caller that wants any part of it: the assembled per-agent
 * controller for the normal case, and the individual pieces for the callers that
 * need only one of them (a banner that reads a status, a test that drives the
 * probe, a store that owns its own pager).
 *
 * What is deliberately not exported: the internal wiring of the sequence. If a
 * caller needs the order changed, that is a change here, not a composition done
 * from outside -- an order assembled by each caller is an order nobody can test.
 */

export { createReconnectAgent } from "./agent";
export type { ReconnectAgent, ReconnectAgentOptions } from "./agent";

export { createTransportWatch, createWatchedChannelFactory } from "./watcher";
export type { TransportWatch, Unsubscribe } from "./watcher";

export { createProbe } from "./probe";
export type { Probe, ProbeClock, ProbeOptions, ProbeSend, ProbeState } from "./probe";

export { createStateMachine } from "./state-machine";
export type { AgentStateMachine, StateClock, StateMachineOptions } from "./state-machine";

export { createPager } from "./messages";
export type { PagerOptions } from "./messages";

export { createLedger } from "./approvals";
export type { LedgerOptions } from "./approvals";

export { detectHistoryGap, streamTruncated } from "./gaps";
export type { GapInput } from "./gaps";

export { runRecovery } from "./recovery";
export type { RecoveryOutcome, RecoveryPorts, RecoveryStopReason, SyncOutcome } from "./recovery";

export { createEndpointWatcher } from "./endpoints";
export type { Endpoint, EndpointWatcher, EndpointWatcherOptions } from "./endpoints";

export { createRestartPort } from "./restart";
export type {
  RestartEndpoint,
  RestartOptions,
  RestartPort,
  RestartPorts,
  RestartTimer,
} from "./restart";

export type {
  ApprovalLedger,
  ApprovalReconciliation,
  MessagePage,
  MessagePager,
  PageFetcher,
  PageResult,
  PendingApproval,
  Reconnecting,
  ReconnectController,
  ReconnectDeps,
} from "./controller";
export type {
  MessageId,
  ReconnectCause,
  ReconnectState,
  ReconnectStatus,
  RecoveryStep,
  ReplayGap,
  ReplaySink,
  ReplayStateKind,
  ReplayStates,
} from "./types";
