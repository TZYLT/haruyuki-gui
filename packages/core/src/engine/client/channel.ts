/**
 * Channel kernel: one agent's in-flight table, event dispatch, capability
 * snapshot and diagnostic wiring.
 *
 * This module is the *kernel*, not the whole client:
 *
 * - **No transport.** It never opens, owns or inspects a socket. It writes
 *   through an injected `write` function and is fed by `ingest(raw: string)`,
 *   which the transport layer (`transport.ts`) and the pool (`pool.ts`) wire
 *   together.
 * - **No wire vocabulary.** Every engine spelling this layer would otherwise
 *   have to know - the field carrying the correlation id, the field carrying the
 *   success flag, the envelope's own names as they appear on the wire, the field
 *   carrying the advertised slash commands - arrives through one of the injected
 *   ports below, or through the frozen types in `types.ts`. That keeps this file
 *   free of wire vocabulary by construction rather than by review.
 * - **No policy other modules own.** The timeout table belongs to
 *   `timeouts.ts` and the bounded, redacted diagnostic history belongs to
 *   `diagnostics.ts`. Both are injected with the real implementation as the
 *   default, so this file composes them instead of growing a second copy that
 *   would drift from theirs.
 * - **No delivery judgement.** It settles an in-flight entry; it does not decide
 *   what `success: false` means. That decode is the response port's job,
 *   so the REJECTED-versus-UNKNOWN_COMMAND split has one home, not two.
 *
 * Four rules the tests are built around, because each of them leaks or hangs
 * when it is broken:
 *
 * 1. **Every settle path removes the entry.** Resolve, reject, timeout and close
 *    all go through {@link EngineChannel.takeEntry}, the only place an entry
 *    leaves the table and its timer is cleared. A missing delete is a slot that
 *    never comes back (256 sends and the channel is dead) plus a timer that keeps
 *    the process alive.
 * 2. **A late answer is not an error.** The lookup after a timeout, or for a
 *    duplicate frame, misses, and a miss is the documented normal path: the frame
 *    is then treated as an event, never thrown.
 * 3. **`unknown` is not empty.** The capability union is returned untouched, so a
 *    consumer cannot mistake "nobody probed yet" for "the engine has no slash
 *    commands".
 * 4. **One subscriber cannot hurt another.** Each delivery is wrapped, so a
 *    consumer that throws loses its own frame and nothing else - not the next
 *   subscriber, not the next frame.
 */

/*
 * Imports: the frozen types plus the two collaborators this kernel composes
 * rather than re-implements - the timeout family table (`timeouts.ts`) and the
 * bounded, redacting history (`diagnostics.ts`). The envelope passthrough and the
 * failure constructors live beside this file; they are re-exported below so a
 * caller keeps importing from `./channel` and does not learn the split.
 */
import type { CapabilityName } from "@haruyuki/protocol";

import { completionOf } from "./capability-names";
import type { CompletionMode } from "./capability-names";
import {
  diagnosticFor,
  duplicateIdError,
  notConnectedError,
  sendFailedError,
  tableFullError,
  timeoutError,
} from "./channel-errors";
import { DiagnosticLog } from "./diagnostics";
import type { DiagnosticDraft } from "./diagnostics";
import { envelopeOf } from "./envelope";
import type { EngineClientError } from "./errors";
import { resolveTimeout } from "./timeouts";
import type { CapabilitySnapshot, Channel, CommandRequest, CommandResult } from "./types";
import type { DiagnosticKind, DiagnosticRecord, EngineEventFrame } from "./types";

// Re-exported so `import { createChannel, ChannelOptions } from "./channel"` keeps
// working: the split below is an implementation detail, not a second surface.
export {
  diagnosticFor,
  duplicateIdError,
  notConnectedError,
  sendFailedError,
  tableFullError,
  timeoutError,
} from "./channel-errors";
export { ENVELOPE_KEYS, envelopeOf } from "./envelope";

/**
 * In-flight slots.
 *
 * The measured ceiling for a single conversation is three concurrent requests
 * across the whole recording corpus, so 256 is two orders of magnitude of
 * headroom; a channel that reaches it has a caller bug, and queueing would hide
 * that bug until memory or a 180 s timeout reported it instead.
 */
const MAX_IN_FLIGHT = 256;
/** Subject used for diagnostics about a frame that is not a readable object. */
const FRAME_SUBJECT = "frame";

/* ------------------------------------------------------------------------- */
/* Injected ports                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Opaque timer handle.
 *
 * `unknown` rather than `ReturnType<typeof setTimeout>` so a fake clock can hand
 * back anything; the default clock below is the only code that knows what its
 * own handles are.
 */
export type ChannelTimer = unknown;

/**
 * The clock every time-dependent decision goes through.
 *
 * Injecting it is what makes the timeout tests instant: a real
 * `setTimeout(..., 180_000)` in a test would spend three minutes of the
 * repository's gate budget proving nothing a fake clock does not prove faster.
 */
export interface ChannelClock {
  /** Milliseconds since the epoch, used for `at`, `sentAt` and `probedAt`. */
  now(): number;
  /**
   * Start a one-shot timer; the callback fires at most once.
   *
   * The kernel may call {@link ChannelClock.stopTimer} with `undefined` when a
   * timer fired before its handle was stored, so an implementation must ignore
   * that case rather than throw.
   */
  startTimer(callback: () => void, delayMs: number): ChannelTimer;
  /** Cancel a timer that has not fired; a no-op for one that has, or for none. */
  stopTimer(timer: ChannelTimer | undefined): void;
}

/**
 * One inbound frame, decoded far enough for the kernel to route it.
 *
 * A response is recognised by the reader, not by the kernel: the correlation
 * field lives on the wire, and reading it here would put the engine's spelling
 * of it inside this file.
 */
export type DecodedResponse =
  | { readonly requestId: string; readonly ok: true; readonly data: unknown }
  | { readonly requestId: string; readonly ok: false; readonly error: EngineClientError };

/**
 * Everything the kernel needs to know about one inbound frame's engine side.
 *
 * `typeOf` returns the engine's event type; `responseOf` returns the correlated
 * answer when the frame is one, and `undefined` when it is a pure event. Both are
 * total over `unknown` input: a frame that is not an object, or that has no
 * usable type, answers `undefined` rather than throwing.
 */
export interface EngineFrameReader {
  typeOf(raw: unknown): string | undefined;
  responseOf(raw: unknown): DecodedResponse | undefined;
}

/**
 * What one frame said about the engine's capabilities.
 *
 * Both members are *optional* because the two sources arrive on different
 * frames: the handshake advertises the boolean flags and the first device status
 * advertises the slash commands. A reading may carry
 * either, both, or - by not being returned at all - neither.
 *
 * `slashCommands: []` is meaningful and different from an absent field: an empty
 * array is the engine explicitly saying "none", which is the `confirmed-empty`
 * state, while an absent field means "this frame did not say" and leaves the
 * snapshot `unknown`. Flattening those two is exactly the defect this union
 * exists to prevent.
 */
export type CapabilityProbeReading = {
  readonly booleans?: Readonly<Record<string, boolean>>;
  /** Present (possibly empty) only when the frame carried the advertised list. */
  readonly slashCommands?: readonly string[];
};

/** Extracts capability readings from frames; the engine's field names stay here. */
export interface CapabilityProbePort {
  read(raw: unknown): CapabilityProbeReading | undefined;
}

/**
 * Whether a command may be written right now, and whether it ever could be.
 *
 * The second half exists because `NOT_CONNECTED` must distinguish "never came
 * up" (a startup problem, reported through the diagnostics) from "was up and
 * dropped" (a reconnect problem, owned by the reconnect layer). The
 * kernel cannot derive that from a socket it does not own, so the transport layer
 * states it.
 */
export type ChannelReadiness = {
  readonly ready: boolean;
  readonly everReady: boolean;
};

/**
 * Writes one command to the wire.
 *
 * `requestId` is the correlation the kernel has decided on: a minted or
 * caller-supplied id for a tracked command, a minted (never caller-supplied) one
 * for a silent command, and `undefined` for the commands whose wire has no
 * request id at all. Turning `(request, requestId)` into bytes - envelope,
 * capability mapping, serialization - belongs to the send path (`send.ts`).
 * Handing it
 * the id rather than a whole frame keeps the decisions this layer exists for
 * (which class, which id, track or not) in one place.
 */
export type ChannelWriter = (request: CommandRequest, requestId: string | undefined) => void;

/** Everything a channel needs, all of it injected. */
export interface ChannelOptions {
  readonly agentId: string;
  /** Writes one command; throws when the write itself fails. */
  readonly write: ChannelWriter;
  /** Decodes an inbound frame; defaults to a reader that routes on `type` only. */
  readonly reader?: EngineFrameReader;
  /** Feeds the capability snapshot; omitted means the snapshot stays `unknown`. */
  readonly probe?: CapabilityProbePort;
  /**
   * How the end of a command is observed. Defaults to the table in
   * `capability-names.ts`, which classifies all 68 capabilities (60 response,
   * 2 silent, 5 untracked, 1 duplex); injected only by tests that want a synthetic
   * classification.
   */
  readonly completionOf?: (name: CapabilityName) => CompletionMode;
  /**
   * The budget for one request, given the caller's override. Defaults to
   * `resolveTimeout` (`timeouts.ts`), so the family table and the 10x clamp live
   * in one place.
   */
  readonly resolveTimeoutMs?: (name: CapabilityName, requestedMs?: number) => ResolvedBudget;
  /** Readiness at send time; defaults to "ready, and always was". */
  readonly readiness?: () => ChannelReadiness;
  /**
   * Event types this build models. Omitting it means "this channel has no type
   * table", and then no `unknown-event` is reported: without a table the kernel
   * cannot tell an unmodelled type from an unknown one, and a diagnostic for
   * every frame would be noise rather than a signal.
   */
  readonly knownEventTypes?: ReadonlySet<string>;
  /**
   * Secrets that must never reach a diagnostic - in practice the endpoint's
   * token. The channel never holds the endpoint itself; it only knows what to
   * erase, so a token whose shape the redaction rules do not recognise (a test
   * token, a future format) is still removed by value before the record is
   * stored.
   */
  readonly secrets?: readonly string[];
  /** Time source and timers; defaults to the system clock. */
  readonly clock?: ChannelClock;
  /** Mints a request id; defaults to a per-channel counter plus noise. */
  readonly mintRequestId?: () => string;
  /**
   * Diagnostic history; defaults to a fresh log at its documented capacity.
   */
  readonly diagnostics?: DiagnosticLog;
}

/** A resolved per-request budget, mirroring `ResolvedTimeout` in `timeouts.ts`. */
export type ResolvedBudget = {
  readonly ms: number;
  /**
   * `true` when the caller's `timeoutMs` was cut to the 10x cap. Exposed because
   * the channel reports it rather than failing: a defensive parameter must not
   * cost the caller their command.
   */
  readonly clamped: boolean;
};

/* ------------------------------------------------------------------------- */
/* Default collaborators                                                     */
/* ------------------------------------------------------------------------- */

/**
 * The default reader: routing only.
 *
 * It reads the one field the frozen `EngineEventFrame` already names - `type` -
 * and reports no response, because recognising a correlated answer means reading
 * the correlation field and the success flag, and both belong to the send path
 * (`send.ts`) where the engine's spelling of them already lives. A channel built
 * without a reader therefore delivers every frame as an event, which is the
 * normal fallback for an unmatched frame rather than a special case.
 *
 * The `typeof` guard is not decoration: `type` is engine output, so it can be a
 * number, null or absent, and the kernel must not turn that into the string
 * `"undefined"`. A frame without a usable type is reported as malformed.
 */
const DEFAULT_READER: EngineFrameReader = {
  typeOf: (raw) => {
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const type = (raw as { type?: unknown }).type;
    return typeof type === "string" && type.length > 0 ? type : undefined;
  },
  responseOf: () => undefined,
};

/** The system clock: `Date.now` plus one real timer per request. */
const SYSTEM_CLOCK: ChannelClock = {
  now: () => Date.now(),
  startTimer: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  stopTimer: (timer) => {
    if (timer === undefined) {
      return;
    }
    globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>);
  },
};
/* ------------------------------------------------------------------------- */
/* The channel                                                               */
/* ------------------------------------------------------------------------- */

/** One tracked request: the atom of the in-flight table. */
interface InFlightEntry {
  readonly capability: CapabilityName;
  readonly requestId: string;
  readonly sentAt: number;
  /** The budget granted, so the TIMEOUT message quotes the real number. */
  readonly timeoutMs: number;
  resolve: (result: CommandResult) => void;
  reject: (error: EngineClientError) => void;
  timer: ChannelTimer;
}

/**
 * One agent's channel.
 *
 * Implements the frozen `Channel` surface and nothing else public beyond the
 * read-only accessors the pool and the tests need (`inFlightCount`,
 * `diagnostics`, `unknownEventCounts`, `isClosed`, `ingest`). It is safe to
 * construct directly; `createChannel` is the convenience form that fills in the
 * defaults.
 */
export class EngineChannel implements Channel {
  readonly agentId: string;

  private readonly write: ChannelWriter;
  private readonly reader: EngineFrameReader;
  private readonly probe: CapabilityProbePort | undefined;
  private readonly completionOfCapability: (name: CapabilityName) => CompletionMode;
  private readonly resolveBudget: (name: CapabilityName, requestedMs?: number) => ResolvedBudget;
  private readonly readiness: () => ChannelReadiness;
  private readonly knownEventTypes: ReadonlySet<string> | undefined;
  private readonly secrets: readonly string[];
  private readonly clock: ChannelClock;
  private readonly mint: () => string;
  private readonly log: DiagnosticLog;

  private readonly table = new Map<string, InFlightEntry>();
  private readonly eventSubscribers = new Set<(frame: EngineEventFrame) => void>();
  private readonly diagnosticSubscribers = new Set<(record: DiagnosticRecord) => void>();
  private readonly unsubscribeLog: () => void;

  private probedFlags: Record<string, boolean> = {};
  private slashCommands: readonly string[] | undefined;
  private probedAt: number | undefined;

  private closedState = false;
  private minted = 0;

  constructor(options: ChannelOptions) {
    this.agentId = options.agentId;
    this.write = options.write;
    this.reader = options.reader ?? DEFAULT_READER;
    this.probe = options.probe;
    this.completionOfCapability = options.completionOf ?? completionOf;
    this.resolveBudget = options.resolveTimeoutMs ?? resolveTimeout;
    this.readiness = options.readiness ?? (() => ({ ready: true, everReady: true }));
    this.knownEventTypes = options.knownEventTypes;
    this.secrets = options.secrets ?? [];
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.mint = options.mintRequestId ?? (() => this.mintRequestId());
    this.log = options.diagnostics ?? new DiagnosticLog();

    // The log notifies its own subscribers; the channel is one of them, and
    // it fans the sanitised record out to `onDiagnostic` subscribers. Going
    // through the log rather than calling them directly is what makes "a stored
    // record" and "a delivered record" the same object.
    this.unsubscribeLog = this.log.onRecord((record) => {
      for (const subscriber of [...this.diagnosticSubscribers]) {
        try {
          subscriber(record);
        } catch {
          // Same isolation rule as event delivery: a diagnostics panel that
          // throws must not stop the next panel, nor the channel.
        }
      }
    });
  }

  /* --------------------------------------------------------------------- */
  /* Send                                                                  */
  /* --------------------------------------------------------------------- */

  /**
   * Sends one command. Never rejects; every failure is the `ok: false` arm.
   *
   * The three-way split is made here and nowhere else:
   *
   * - `response` (60) enters the table, so a missing answer becomes a TIMEOUT;
   * - `silent` (2: `file.watch`, `file.unwatch`) carries a request id but the
   *   engine never answers, so entering the table would make every send a false
   *   timeout - it resolves `ok: true` as soon as the frame is written;
   * - `untracked` (5) and `duplex` (1) have no correlation to wait on, so they
   *   are written as they are and resolve `ok: true`.
   *
   * @param request the capability and body the caller stated
   * @returns the answer, or a classified failure
   */
  send(request: CommandRequest): Promise<CommandResult> {
    if (this.closedState) {
      return Promise.resolve({
        ok: false,
        error: notConnectedError(this.readiness().everReady, "the channel is closed"),
      });
    }

    const readiness = this.readiness();
    if (!readiness.ready) {
      return Promise.resolve({ ok: false, error: notConnectedError(readiness.everReady) });
    }

    const mode = this.completionOfCapability(request.capability);
    return mode === "response" ? this.sendTracked(request) : this.sendUntracked(request, mode);
  }

  /**
   * The write-and-forget path: `silent`, `untracked` and `duplex`.
   *
   * @param request the command
   * @param mode the completion class that kept it out of the table
   * @returns `ok: true` once the write returns
   */
  private sendUntracked(request: CommandRequest, mode: CompletionMode): Promise<CommandResult> {
    // A silent capability still carries a request id, and an untracked one must
    // never carry it - not even one the caller
    // passed: the wire has no such field, so forwarding it would be a field the
    // engine does not read.
    const requestId = mode === "silent" ? (request.requestId ?? this.mint()) : undefined;
    try {
      this.write(request, requestId);
    } catch {
      this.diagnose("send-failed", request.capability);
      return Promise.resolve({ ok: false, error: sendFailedError(request.capability) });
    }
    // Nothing answered this command, so there is no `raw` and no `data`: both are
    // `undefined` by definition, not a placeholder for missing output.
    return Promise.resolve({ ok: true, data: undefined, raw: undefined });
  }

  /**
   * The tracked path: reserve a slot, start one timer, write, then wait.
   *
   * @param request the command
   * @returns the answer, a TIMEOUT, or a refusal
   */
  private sendTracked(request: CommandRequest): Promise<CommandResult> {
    if (this.table.size >= MAX_IN_FLIGHT) {
      // Refused, not queued: a queue would hide the caller bug that
      // filled 256 slots and would make the 257th waiter wait 180 s to learn it.
      this.diagnose("rejected", request.capability);
      return Promise.resolve({
        ok: false,
        error: tableFullError(request.capability, MAX_IN_FLIGHT),
      });
    }

    const requestId = request.requestId ?? this.mint();
    if (this.table.has(requestId)) {
      // A caller-supplied id that is already in flight would make two waiters
      // share one answer; the second is refused rather than silently attached.
      this.diagnose("rejected", request.capability);
      return Promise.resolve({
        ok: false,
        error: duplicateIdError(request.capability, requestId),
      });
    }

    const budget = this.resolveBudget(request.capability, request.timeoutMs);
    const timeoutMs = budget.ms;

    const entry: InFlightEntry = {
      capability: request.capability,
      requestId,
      sentAt: this.clock.now(),
      timeoutMs,
      resolve: () => undefined,
      reject: () => undefined,
      timer: undefined,
    };

    // `new Promise` runs its executor synchronously, so these settle functions are
    // in place before anything else can reach the entry.
    const promise = new Promise<CommandResult>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });

    // Order matters: the entry is in the table BEFORE the timer starts. A clock
    // whose `startTimer` fires inline (a fake clock already past its delay, a
    // stub) would otherwise expire a request the table does not hold yet, and the
    // entry would then be inserted holding an already-fired timer - a slot nobody
    // ever reclaims.
    this.table.set(requestId, entry);
    entry.timer = this.clock.startTimer(() => {
      this.expire(requestId);
    }, timeoutMs);

    try {
      this.write(request, requestId);
    } catch {
      this.diagnose("send-failed", request.capability);
      this.fail(requestId, sendFailedError(request.capability));
    }

    // `send` resolves, never rejects: the internal rejection is the kernel's way
    // of saying "this request ended without an answer".
    return promise.then(
      (result) => result,
      (error: EngineClientError) => ({ ok: false, error }) as CommandResult,
    );
  }

  /**
   * Mints a request id unique within this channel.
   *
   * The counter makes it sortable within a session and the random suffix makes
   * two channels - or two processes writing into one engine - unlikely to collide.
   * Uniqueness is all the engine's correlation needs; this is not an idempotency
   * token: the table does not defend against network duplication, which TCP does
   * not produce.
   *
   * @returns a fresh request id
   */
  private mintRequestId(): string {
    this.minted += 1;
    return `req-${this.minted.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /* --------------------------------------------------------------------- */
  /* The in-flight table                                                   */
  /* --------------------------------------------------------------------- */

  /**
   * Removes and returns one entry, clearing its timer.
   *
   * The **only** place an entry leaves the table. Resolve, reject, timeout, close
   * and a failed write all call it, so a slot cannot leak down one path while
   * being reclaimed on the others.
   *
   * @param requestId the correlation to take
   * @returns the entry, or `undefined` when it was already settled
   */
  private takeEntry(requestId: string): InFlightEntry | undefined {
    const entry = this.table.get(requestId);
    if (entry === undefined) {
      return undefined;
    }
    this.table.delete(requestId);
    this.clock.stopTimer(entry.timer);
    return entry;
  }

  /**
   * Ends one tracked request without an answer.
   *
   * @param requestId the correlation
   * @param error the classified failure the waiting caller receives
   */
  private fail(requestId: string, error: EngineClientError): void {
    const entry = this.takeEntry(requestId);
    if (entry === undefined) {
      return;
    }
    const kind = diagnosticFor(error.code);
    if (kind !== undefined) {
      this.diagnose(kind, entry.capability, error.engineText);
    }
    entry.reject(error);
  }

  /**
   * The timer callback: one request outlived its budget.
   *
   * @param requestId the correlation whose timer fired
   */
  private expire(requestId: string): void {
    const entry = this.takeEntry(requestId);
    if (entry === undefined) {
      // Already settled: close() or an answer that beat the timer. Nothing to do,
      // and nothing to report - the caller already has its result.
      return;
    }
    this.diagnose("timeout", entry.capability);
    entry.reject(timeoutError(entry.capability, entry.timeoutMs));
  }

  /**
   * Ends a tracked request with the answer its frame carried.
   *
   * @param response the decoded answer
   * @param raw the untouched frame, stored as the result's `raw`
   * @returns `true` when the frame matched an entry, `false` when it is a
   *          stranger (a late answer, a duplicate, or a push)
   */
  private settle(response: DecodedResponse, raw: unknown): boolean {
    const entry = this.takeEntry(response.requestId);
    if (entry === undefined) {
      return false;
    }
    if (response.ok) {
      entry.resolve({ ok: true, data: response.data, raw });
      return true;
    }
    const kind = diagnosticFor(response.error.code);
    if (kind !== undefined) {
      this.diagnose(kind, entry.capability, response.error.engineText);
    }
    entry.reject(response.error);
    return true;
  }

  /**
   * How many requests are in flight.
   *
   * Not part of the frozen `Channel` surface; the pool uses it for its own
   * accounting and the tests use it to prove that each settle path frees its slot.
   *
   * @returns the current table size
   */
  inFlightCount(): number {
    return this.table.size;
  }

  /* --------------------------------------------------------------------- */
  /* Inbound                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * Feeds one raw frame from the transport.
   *
   * Routing follows one rule: a frame that matches an in-flight request settles
   * it and is not delivered as an event; everything else - a push, a late answer,
   * a duplicate - becomes an event. A frame that does not parse, or that is not
   * an object, is a diagnostic and nothing more: the next frame still flows.
   *
   * @param raw the frame exactly as it crossed the wire
   */
  ingest(raw: string): void {
    if (this.closedState) {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      this.diagnose("malformed", FRAME_SUBJECT);
      return;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.diagnose("malformed", FRAME_SUBJECT);
      return;
    }

    const response = this.reader.responseOf(value);
    if (response !== undefined && this.settle(response, value)) {
      return;
    }

    const type = this.reader.typeOf(value);
    if (type === undefined) {
      this.diagnose("malformed", FRAME_SUBJECT);
      return;
    }

    this.applyReading(value);

    const at = this.clock.now();
    const envelope = envelopeOf(value);
    const frame: EngineEventFrame =
      envelope === undefined ? { type, raw: value, at } : { type, raw: value, at, envelope };

    this.noteUnknown(frame.type);

    for (const subscriber of [...this.eventSubscribers]) {
      try {
        subscriber(frame);
      } catch {
        // A consumer that throws loses its own frame. It must not cost the next
        // subscriber its frame, nor the channel its next frame: a renderer bug is
        // not a channel fault, and turning it into one would take the whole
        // conversation down.
      }
    }
  }

  /**
   * Counts one frame of an unrecognised event type and reports its first arrival.
   *
   * Counted per type, never stored per frame. 155 of the 295 recorded
   * frames are one type, so per-frame storage would fill the 512-record history
   * with a single answer to "what is the engine pushing that we do not model?".
   * The count lives in the diagnostic log, and only the first frame of a type
   * costs a
   * record - a summary, not a copy of the frame.
   *
   * With no type table injected there is nothing to compare against, so nothing is
   * reported: see {@link ChannelOptions.knownEventTypes}.
   *
   * @param type the engine event type
   */
  private noteUnknown(type: string): void {
    if (this.knownEventTypes === undefined || this.knownEventTypes.has(type)) {
      return;
    }
    const first = this.log.unknownEventCount(type) === 0;
    this.log.recordUnknownEvent(type);
    if (first) {
      this.diagnose("unknown-event", type);
    }
  }

  /**
   * Applies one frame's capability reading to the three-state snapshot.
   *
   * Only an explicit `slashCommands` field moves the state off `unknown`: the
   * flags alone are the handshake talking, and the union cannot express "flags
   * known, commands unknown" without collapsing the two facts into one.
   *
   * @param raw the untouched frame
   */
  private applyReading(raw: unknown): void {
    if (this.probe === undefined) {
      return;
    }
    const reading = this.probe.read(raw);
    if (reading === undefined) {
      return;
    }
    if (reading.booleans !== undefined) {
      this.probedFlags = { ...reading.booleans };
    }
    if (reading.slashCommands !== undefined) {
      this.slashCommands = [...reading.slashCommands];
      this.probedAt = this.clock.now();
    }
  }

  /**
   * The capability snapshot, in one of its three states.
   *
   * `unknown` carries no collections at all, so a consumer that forgets to narrow
   * cannot read an empty list and conclude "no slash commands".
   *
   * @returns a fresh snapshot; mutating it cannot change the channel
   */
  capabilities(): CapabilitySnapshot {
    if (this.probedAt === undefined) {
      return { state: "unknown" };
    }
    const probedAt = this.probedAt;
    if (this.slashCommands !== undefined && this.slashCommands.length === 0) {
      return { state: "confirmed-empty", probedAt };
    }
    return {
      state: "probed",
      booleans: { ...this.probedFlags },
      slashCommands: [...(this.slashCommands ?? [])],
      probedAt,
    };
  }

  /* --------------------------------------------------------------------- */
  /* Subscriptions                                                         */
  /* --------------------------------------------------------------------- */

  /**
   * Subscribes to inbound events.
   *
   * @param subscriber called once per event frame, in arrival order
   * @returns an idempotent unsubscribe function
   */
  onEvent(subscriber: (frame: EngineEventFrame) => void): () => void {
    if (this.closedState) {
      return () => undefined;
    }
    this.eventSubscribers.add(subscriber);
    return () => {
      this.eventSubscribers.delete(subscriber);
    };
  }

  /**
   * Subscribes to diagnostic records.
   *
   * Records are delivered from the moment of subscription; the ring keeps the
   * earlier ones for {@link diagnostics}, which is the read-the-backlog method.
   * Delivery is live-only so a panel cannot be handed a burst of old records it
   * has no way to tell from new ones.
   *
   * @param subscriber called once per record from now on
   * @returns an idempotent unsubscribe function
   */
  onDiagnostic(subscriber: (record: DiagnosticRecord) => void): () => void {
    if (this.closedState) {
      return () => undefined;
    }
    this.diagnosticSubscribers.add(subscriber);
    return () => {
      this.diagnosticSubscribers.delete(subscriber);
    };
  }

  /**
   * The diagnostic history, oldest first.
   *
   * Beyond the frozen surface on purpose: the tests need to read the ring to prove
   * it is bounded and redacted, and a support bundle needs the same read.
   *
   * @returns a copy; mutating it cannot change the history
   */
  diagnostics(): readonly DiagnosticRecord[] {
    return this.log.entries();
  }

  /**
   * Per-type counts of the event types this build did not recognise.
   *
   * @returns a copy keyed by engine type, in first-appearance order
   */
  unknownEventCounts(): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const type of this.log.unknownEventTypes()) {
      counts.set(type, this.log.unknownEventCount(type));
    }
    return counts;
  }

  /* --------------------------------------------------------------------- */
  /* Diagnostics                                                           */
  /* --------------------------------------------------------------------- */

  /**
   * Records one diagnostic through the diagnostic log.
   *
   * The channel's own contribution before handing it over is the by-value secret
   * scrub: the log redacts by *shape* (bearer headers, 64-hex, JWT, provider
   * keys,
   * absolute paths), which covers the real capability token, but the endpoint's
   * token must not survive even if its shape is not one of the recognised ones.
   * Erasing the exact secret first makes that a guarantee rather than a bet on the
   * token's format, and it is the one hard boundary diagnostics must never cross.
   *
   * @param kind the stable signal
   * @param subject what the record is about
   * @param engineText the engine's own words, when it said anything
   */
  private diagnose(kind: DiagnosticKind, subject: string, engineText?: string): void {
    // `at` is this channel's clock, taken here: it answers "when did we see this",
    // which is the only question a diagnostic carries a timestamp for (types.ts).
    // It is never `envelope.emitted_at`, which comes from a different clock, and it
    // is passed explicitly so the injected clock stays the single time source even
    // though the log would stamp it otherwise.
    const draft: DiagnosticDraft =
      engineText === undefined
        ? { at: this.clock.now(), kind, subject: this.scrubSecrets(subject) }
        : {
            at: this.clock.now(),
            kind,
            subject: this.scrubSecrets(subject),
            engineText: this.scrubSecrets(engineText),
          };
    this.log.record(draft);
  }

  /**
   * Replaces every configured secret with a placeholder.
   *
   * @param text the string to clean
   * @returns the same text with each known secret removed
   */
  private scrubSecrets(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret.length === 0) {
        continue;
      }
      out = out.split(secret).join("<redacted-token>");
    }
    return out;
  }

  /* --------------------------------------------------------------------- */
  /* Lifecycle                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Whether {@link close} has run.
   *
   * @returns `true` once the channel is closed
   */
  isClosed(): boolean {
    return this.closedState;
  }

  /**
   * Closes the channel: idempotent, and no subscriber is called again.
   *
   * Pending requests are ended rather than left hanging. A `send` whose answer will
   * never arrive is worse than a failure - the caller would wait for something
   * that cannot happen - so each one resolves `NOT_CONNECTED`, and the table and
   * every timer are emptied on the way out.
   */
  close(): void {
    if (this.closedState) {
      return;
    }
    this.closedState = true;

    const everReady = this.readiness().everReady;
    for (const requestId of [...this.table.keys()]) {
      const entry = this.takeEntry(requestId);
      if (entry === undefined) {
        continue;
      }
      entry.reject(
        notConnectedError(everReady, "the channel closed while the request was in flight"),
      );
    }

    this.eventSubscribers.clear();
    this.diagnosticSubscribers.clear();
    this.unsubscribeLog();
  }
}

/**
 * Builds one channel with the defaults filled in.
 *
 * @param options the injected ports
 * @returns a channel ready to have frames ingested
 */
export function createChannel(options: ChannelOptions): EngineChannel {
  return new EngineChannel(options);
}
