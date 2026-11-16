/**
 * The public surface of the engine client: everything B2 owns, nothing else.
 *
 * Shape source:  section 3.3 (this file is the "export only" entry
 * point), section 3.2 (the three data flows) and section 5.1 (the frozen
 * `Channel` / `ChannelPool` signatures).
 *
 * ## What this module is
 *
 * A consumer (C1's event merger, C2's capability gate, B3's reconnect logic, B4's
 * typed helpers, D4's diagnostics panel) imports from here and nowhere else under
 * `client/`. The per-layer modules stay importable for their own tests, but the
 * surface is this file: it names what is promised, so a change to a layer module
 * that would leak through here has to be a deliberate edit here too.
 *
 * ## Why it is not a pure forwarding module
 *
 * {@link CLIENT_MODULE_NAME} is a real local declaration, and it is load-bearing
 * twice over:
 *
 * - `scripts/check-module-ownership.mjs` rejects a module whose every statement
 *   forwards (`isBarrel`), because a pure barrel hides the dependency edge and
 *   makes a cycle invisible. `barrels.allow` names only
 *   `packages/core/src/engine/index.ts`, so a pure barrel here fails `verify
 *   --full`.
 * - It follows the repository's own precedent: `packages/core/src/index.ts`
 *   exports `CORE_PACKAGE_NAME` and `packages/protocol/src/index.ts` exports
 *   `PROTOCOL_PACKAGE_NAME`. A barrel that identifies itself is a barrel a log
 *   line or an assertion can name.
 *
 * ## What is deliberately absent
 *
 * - **No wire vocabulary**: no frame field name, command id or event type
 *   appears anywhere under `client/`, this file included. A caller states a
 *   capability name; `send.ts` resolves the wire.
 * - **No `Engine` import.** This direction would be `client -> engine`, and the
 *   facade's own additions are D4's file. The wiring takes a structural
 *   `{ endpoint }` instead ({@link EndpointSource}), which the real `Engine`
 *   satisfies by construction.
 * - **No test doubles.** `*-test-support.ts`, `*-harness.ts` and every
 *   `*.test.ts` import these layers directly; they are not part of the promise.
 */

/** The module's own name, for logs and for the barrel-ownership gate. */
export const CLIENT_MODULE_NAME = "@haruyuki/core/engine/client" as const;

/* ------------------------------------------------------------------------- */
/* Types: the frozen contract                                                */
/* ------------------------------------------------------------------------- */

export type {
  CapabilitySnapshot,
  Channel,
  ChannelPool,
  CommandRequest,
  CommandResult,
  DiagnosticKind,
  DiagnosticRecord,
  Endpoint,
  EngineEventEnvelope,
  EngineEventFrame,
  RuntimeScope,
} from "./types";
export { DIAGNOSTIC_KINDS } from "./types";

/* ------------------------------------------------------------------------- */
/* Failures                                                                  */
/* ------------------------------------------------------------------------- */

export { CODE_TO_KEY, ENGINE_CLIENT_ERROR_CODES, messageKeyFor } from "./errors";
export type { EngineClientError, EngineClientErrorCode } from "./errors";

/* ------------------------------------------------------------------------- */
/* Capability names                                                          */
/* ------------------------------------------------------------------------- */

export {
  CAPABILITIES,
  CAPABILITY_NAMES,
  capabilityEntry,
  completionOf,
  findCapability,
  hasOptionalRequestId,
  isCapabilityName,
  replyWireOf,
  scopeOf,
  shapeOf,
  tracksInFlight,
  tracksInFlightWith,
  wireIdOf,
} from "./capability-names";
export type { CapabilityEntry, CompletionMode } from "./capability-names";

/* ------------------------------------------------------------------------- */
/* Timeouts                                                                  */
/* ------------------------------------------------------------------------- */

export { defaultTimeoutMs, maxTimeoutMs, resolveTimeout, timeoutFamilyOf } from "./timeouts";
export type { ResolvedTimeout, TimeoutFamily } from "./timeouts";

/* ------------------------------------------------------------------------- */
/* Transport, kernel, send path                                              */
/* ------------------------------------------------------------------------- */

export { createTransport, openTransport } from "./transport";
export type { EngineTransport, InboundFrame, TransportWrite } from "./transport";

export { createChannel, EngineChannel } from "./channel";
export type { ChannelClock, ChannelOptions, ChannelReadiness, EngineFrameReader } from "./channel";

export { createFrameReader } from "./frame-reader";

export { buildFrame } from "./send";
export type { OutgoingFrame } from "./send";

export { ENVELOPE_KEYS, envelopeOf } from "./envelope";

/* ------------------------------------------------------------------------- */
/* Diagnostics and dedupe                                                    */
/* ------------------------------------------------------------------------- */

export {
  DiagnosticLog,
  describeEndpoint,
  redactDiagnosticText,
  sanitizeDiagnosticRecord,
} from "./diagnostics";

export { DEDUPE_LIMIT, OutboundDedupe } from "./dedupe";
export type { DedupeVerdict } from "./dedupe";

/* ------------------------------------------------------------------------- */
/* Pool                                                                      */
/* ------------------------------------------------------------------------- */

export { ChannelPoolReentryError, createChannelPool, EngineChannelPool } from "./pool";
export type { ChannelFactory, ChannelOpenContext, PoolOptions } from "./pool";

/* ------------------------------------------------------------------------- */
/* Wiring: the one call the shell makes                                      */
/* ------------------------------------------------------------------------- */

export {
  createWiredChannelFactory,
  createWiredChannelPool,
  wiringStateOf,
  WIRING_STATE,
} from "./wiring";
export type {
  EndpointSource,
  TransportOpener,
  WiredChannel,
  WiringOptions,
  WiringState,
} from "./wiring";
