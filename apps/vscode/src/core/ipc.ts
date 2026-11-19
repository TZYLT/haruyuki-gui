/**
 * The private message protocol between the extension host and the core child.
 *
 * The core is a separate Node process (ESM) started by `CoreHost`, and the only
 * thing the two sides share is this file: the transport contract plus the value
 * shapes that may cross it. It is deliberately not part of `@haruyuki/core` or
 * `@haruyuki/protocol`:
 *
 * - `@haruyuki/core` is host-agnostic and must not learn how one shell talks to
 *   its own child.
 * - `@haruyuki/protocol` is the browser-facing wire; the host/child pipe carries
 *   opaque `payload` strings, never protocol objects, so that the frame schema
 *   can change without changing this channel.
 *
 * Two rules keep the channel honest:
 *
 * 1. Only the JSON subset crosses it. `fork` serializes with JSON, so a `Date`,
 *    a `Map`, a `BigInt` or a cycle would either be silently mangled or throw on
 *    send. {@link isJsonValue} is the single check for that, and the host uses it
 *    before it mints an id, so a bad call fails at the caller instead of
 *    corrupting the pipe.
 * 2. Every inbound message is narrow-checked. Anything unrecognised is refused
 *    as a value, never thrown: a child that sends garbage must degrade the
 *    feature, not the extension host. The narrowing helpers rebuild the message
 *    field by field, which also drops unknown keys before the value is used.
 */

import type { CommandCall, CommandReply } from "@haruyuki/core";

/**
 * Directory roots the core may write into, resolved by the host.
 *
 * The core never asks the shell for a path: it is handed the whole set once, in
 * `init`, so a later message never has to wait on the shell's filesystem APIs.
 */
export type CorePaths = {
  readonly userData: string;
  readonly logs: string;
  readonly cache: string;
  readonly temp: string;
};

/** Where the engine bundle the child will host lives on disk. */
export type EngineSource = {
  /** `bundled` ships inside the extension; `external` is a directory the user picked. */
  readonly kind: "bundled" | "external";
  /** Engine package root; used as the engine child's working directory. */
  readonly dir: string;
  /** Absolute path of the engine entry bundle. The child must load it as ESM. */
  readonly bundlePath: string;
  /** Version read from the engine's own manifest, when one was readable. */
  readonly version?: string;
};

/**
 * The phase the core reports for the engine it hosts.
 *
 * Deliberately coarser than the engine facade's own state machine: the shell
 * shows a status line and a failure page, and every intermediate transport state
 * is noise there. `starting` covers spawn, port discovery and handshake.
 */
export const RUNTIME_PHASES = ["starting", "ready", "failed", "stopped"] as const;

/** One phase of the hosted runtime. */
export type RuntimePhase = (typeof RUNTIME_PHASES)[number];

/** Why the runtime could not reach `ready`, in the page's own vocabulary. */
export const RUNTIME_FAILURE_KINDS = [
  "missing-engine",
  "start-failed",
  "crash",
  "internal",
  /**
   * The engine was found, but not the build this shell was measured against.
   * A distinct kind because it is a question rather than a dead end: the page
   * offers to connect anyway, and the host needs to know what it is offering.
   */
  "untested-engine",
  /**
   * No folder is open, so there is no working directory the engine may write in.
   * An offered answer exists (the home directory) and it is the user's to give,
   * which is why this is not folded into `start-failed`.
   */
  "no-workspace",
  /**
   * A directory that was inspected and refused: it exists, it is not an engine.
   *
   * Distinct from `start-failed` because the two are different questions. A
   * refused directory has a repair list -- the entries it is missing -- and the
   * user's next move is to pick the right folder. `start-failed` means the
   * engine we chose did not come up, and the move there is to try it again.
   * Reporting both as `start-failed` left the page unable to tell which.
   */
  "invalid-dir",
] as const;

/** One kind of runtime failure. */
export type RuntimeFailureKind = (typeof RUNTIME_FAILURE_KINDS)[number];

/**
 * A failure the shell can explain.
 *
 * `detail` is a human sentence for the status page and the log; it is never
 * parsed for control flow. `logPath` points at the child's captured stderr when
 * there is one, because that is where the user has to look next.
 *
 * The optional fields below are the facts the page has to *show* rather than
 * restate: which directories were searched, which entries a folder is missing,
 * which two versions were compared, where the offered degradation would run.
 * They are data, not sentences, because a page that printed `detail` would show
 * one English string under a header in another language -- and a page that
 * parsed `detail` to recover them would be reading prose for control flow.
 *
 * Every one of them is optional and none of them changes an existing field, so a
 * producer that knows nothing about them still emits a valid failure.
 */
export type RuntimeFailure = {
  readonly kind: RuntimeFailureKind;
  readonly detail: string;
  readonly logPath?: string;
  /** Directories the engine search looked in, in the order it tried them. */
  readonly searchedPaths?: readonly string[];
  /** Entries the chosen folder has to hold and does not, e.g. `haruyuki.js`. */
  readonly missingEntries?: readonly string[];
  /** The folder that was inspected and refused, absolute. */
  readonly candidateDir?: string;
  /** Build this shell was measured against, for the untested pair. */
  readonly expectedVersion?: string;
  /** Build the engine reports, for the untested pair. */
  readonly actualVersion?: string;
  /** Where the no-workspace degradation would run, when one is offered. */
  readonly homeDir?: string;
};

/** The `init` the host sends exactly once per child. */
export type CoreInit = {
  readonly kind: "init";
  readonly paths: CorePaths;
  /** Working directory for the core child and for the engine it starts. */
  readonly cwd: string;
  /** BCP 47 tag the child should assume for engine-produced text. */
  readonly locale: string;
  readonly engine: EngineSource;
  /** Engine build the host expects; the child refuses to report `ready` otherwise. */
  readonly expectedVersion: string;
};

/** Host to core. */
export type HostToCore =
  | CoreInit
  | { readonly kind: "command.invoke"; readonly callId: string; readonly call: CommandCall }
  | {
      readonly kind: "secure.request";
      readonly requestId: string;
      readonly op: SecureOp;
      readonly key: string;
      readonly value?: string;
    }
  | { readonly kind: "shutdown" };

/** The three operations the shell may perform on the core's secret store. */
export const SECURE_OPS = ["get", "set", "delete"] as const;

/** One secret-store operation. */
export type SecureOp = (typeof SECURE_OPS)[number];

/** The three channels a frame can arrive on. */
export const FRAME_CHANNELS = ["control", "stream", "bulk"] as const;

/** One frame channel. */
export type FrameChannel = (typeof FRAME_CHANNELS)[number];

/** Core to host. */
export type CoreToHost =
  | { readonly kind: "ready" }
  | { readonly kind: "frame"; readonly channel: FrameChannel; readonly payload: string }
  | { readonly kind: "command.reply"; readonly callId: string; readonly reply: CommandReply }
  | {
      readonly kind: "secure.reply";
      readonly requestId: string;
      readonly value?: string;
      readonly error?: string;
    }
  | {
      readonly kind: "status";
      readonly phase: RuntimePhase;
      readonly failure?: RuntimeFailure;
      readonly engineVersion?: string;
      readonly source?: string;
      readonly cwd?: string;
    }
  | { readonly kind: "log"; readonly line: string };

/** The status message with its tag removed: what a subscriber is handed. */
export type CoreStatusSnapshot = Omit<Extract<CoreToHost, { kind: "status" }>, "kind">;

/** One frame message. */
export type CoreFrame = Extract<CoreToHost, { kind: "frame" }>;

/** One log message. */
export type CoreLog = Extract<CoreToHost, { kind: "log" }>;

/** A narrowed message, or the reason it was refused. Never throws. */
export type NarrowResult<T> =
  { readonly ok: true; readonly message: T } | { readonly ok: false; readonly reason: string };

const HOST_TO_CORE_KINDS = ["init", "command.invoke", "secure.request", "shutdown"] as const;

const CORE_TO_HOST_KINDS = [
  "ready",
  "frame",
  "command.reply",
  "secure.reply",
  "status",
  "log",
] as const;

/** Maximum nesting {@link isJsonValue} walks before refusing the value. */
const JSON_DEPTH_LIMIT = 32;

/** How much of an offending `kind` is quoted back in a refusal reason. */
const KIND_QUOTE_LIMIT = 32;

/**
 * Whether a value is a non-array object.
 *
 * The check is intentionally shallow: this file only decides whether a message is
 * shaped like a record, and the per-kind narrowing decides the rest.
 *
 * @param value any value, typically one that arrived from another process
 * @returns `true` for a non-null, non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether a value survives the child pipe unchanged.
 *
 * `undefined` is permitted (JSON.stringify drops it, and callers build optional
 * fields that way). Everything else outside JSON is refused: functions, symbols,
 * bigints, non-finite numbers, class instances, `Date`, `Map`, `Set`, `RegExp`,
 * and any cycle.
 *
 * @param value candidate payload
 * @returns `true` when `JSON.stringify` can carry the value without loss
 */
export function isJsonValue(value: unknown): boolean {
  return walkJsonValue(value, 0, new Set<object>());
}

/**
 * Recursion body of {@link isJsonValue}.
 *
 * @param value candidate
 * @param depth current nesting depth
 * @param ancestors objects on the current path, used to detect cycles
 * @returns whether the value is JSON-safe
 */
function walkJsonValue(value: unknown, depth: number, ancestors: Set<object>): boolean {
  if (value === null || value === undefined) return true;

  if (depth > JSON_DEPTH_LIMIT) return false;

  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      break;
    default:
      return false;
  }

  const object = value as object;

  if (ancestors.has(object)) return false;

  ancestors.add(object);

  try {
    if (Array.isArray(object)) {
      return object.every((item) => walkJsonValue(item, depth + 1, ancestors));
    }

    const prototype: unknown = Object.getPrototypeOf(object);

    // A class instance, `Date`, `Map`, `Set` or typed array: JSON would keep only
    // its enumerable own fields and silently change what the other side reads.
    if (prototype !== Object.prototype && prototype !== null) return false;

    return Object.values(object as Record<string, unknown>).every((item) =>
      walkJsonValue(item, depth + 1, ancestors),
    );
  } finally {
    ancestors.delete(object);
  }
}

/** @returns whether the value is a non-empty string */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @returns whether the value is a string or absent */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** @returns whether the value is a list of strings, or absent */
function isOptionalStringList(value: unknown): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string"))
  );
}

/** @returns whether the value is one of the closed set */
function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** @returns a short, human-readable rendering of an offending `kind` */
function describeKind(kind: unknown): string {
  if (typeof kind === "string") return JSON.stringify(kind.slice(0, KIND_QUOTE_LIMIT));
  return typeof kind;
}

/** Build a refusal. */
function refuse<T>(reason: string): NarrowResult<T> {
  return { ok: false, reason };
}

/**
 * Check the two command-envelope fields this channel must not forward blindly.
 *
 * A `CommandCall` body is opaque here, but the envelope is not: capability must
 * be a non-empty name, the body must be a plain JSON record, and a scope, when
 * present, must carry both of its fields.
 *
 * @param value candidate `CommandCall`
 * @returns a narrowed copy, or the reason it was refused
 */
export function narrowCommandCall(value: unknown): NarrowResult<CommandCall> {
  if (!isRecord(value)) return refuse("command.call is not an object");

  const capability = value.capability;
  const body = value.body;

  if (!isNonEmptyString(capability)) return refuse("command.call.capability is not a name");
  if (!isRecord(body)) return refuse("command.call.body is not an object");
  if (!isJsonValue(body)) return refuse("command.call.body is not a JSON value");

  const runtime = value.runtime;

  if (runtime === undefined) {
    return { ok: true, message: { capability, body } };
  }

  if (!isRecord(runtime)) return refuse("command.call.runtime is not an object");

  const agentId = runtime.agent_id;
  const conversationId = runtime.conversation_id;

  if (agentId !== null && typeof agentId !== "string") {
    return refuse("command.call.runtime.agent_id is neither a string nor null");
  }

  if (!isNonEmptyString(conversationId)) {
    return refuse("command.call.runtime.conversation_id is not a name");
  }

  return {
    ok: true,
    message: { capability, body, runtime: { agent_id: agentId, conversation_id: conversationId } },
  };
}

/**
 * Check a reply before it is handed to a caller that will branch on `ok`.
 *
 * @param value candidate `CommandReply`
 * @returns whether the value is one of the three reply arms
 */
export function isCommandReply(value: unknown): value is CommandReply {
  if (!isRecord(value)) return false;
  if (typeof value.ok !== "boolean") return false;

  if (value.ok) {
    return value.completion === "answered" || value.completion === "accepted";
  }

  return typeof value.code === "string";
}

/**
 * Narrow one host-to-core message.
 *
 * @param raw whatever the child sent
 * @returns the message, or the reason it is not one
 */
export function narrowHostToCore(raw: unknown): NarrowResult<HostToCore> {
  if (!isRecord(raw)) return refuse("message is not an object");

  switch (raw.kind) {
    case "init":
      return narrowInit(raw);
    case "command.invoke": {
      const callId = raw.callId;

      if (!isNonEmptyString(callId)) return refuse("command.invoke.callId is not an id");

      const call = narrowCommandCall(raw.call);

      if (!call.ok) return refuse(call.reason);

      return { ok: true, message: { kind: "command.invoke", callId, call: call.message } };
    }
    case "secure.request":
      return narrowSecureRequest(raw);
    case "shutdown":
      return { ok: true, message: { kind: "shutdown" } };
    default:
      return refuse(`unknown host-to-core kind ${describeKind(raw.kind)}`);
  }
}

/**
 * Narrow the `init` message.
 *
 * Every field is required: the child starts exactly once and cannot ask a
 * follow-up question, so a partial `init` is a programming error at the host.
 *
 * @param raw the candidate message
 * @returns the message, or the reason it was refused
 */
function narrowInit(raw: Record<string, unknown>): NarrowResult<CoreInit> {
  const paths = raw.paths;

  if (!isRecord(paths)) return refuse("init.paths is not an object");

  const userData = paths.userData;
  const logs = paths.logs;
  const cache = paths.cache;
  const temp = paths.temp;

  if (
    !isNonEmptyString(userData) ||
    !isNonEmptyString(logs) ||
    !isNonEmptyString(cache) ||
    !isNonEmptyString(temp)
  ) {
    return refuse("init.paths requires userData, logs, cache and temp");
  }

  const engine = raw.engine;

  if (!isRecord(engine)) return refuse("init.engine is not an object");

  const kind = engine.kind;
  const dir = engine.dir;
  const bundlePath = engine.bundlePath;
  const version = engine.version;

  if (kind !== "bundled" && kind !== "external") {
    return refuse("init.engine.kind is neither bundled nor external");
  }

  if (!isNonEmptyString(dir)) return refuse("init.engine.dir is not a path");
  if (!isNonEmptyString(bundlePath)) return refuse("init.engine.bundlePath is not a path");
  if (!isOptionalString(version)) return refuse("init.engine.version is not a string");

  const cwd = raw.cwd;
  const locale = raw.locale;
  const expectedVersion = raw.expectedVersion;

  if (!isNonEmptyString(cwd)) return refuse("init.cwd is not a path");
  if (!isNonEmptyString(locale)) return refuse("init.locale is not a tag");
  if (!isNonEmptyString(expectedVersion)) return refuse("init.expectedVersion is not a version");

  return {
    ok: true,
    message: {
      kind: "init",
      paths: { userData, logs, cache, temp },
      cwd,
      locale,
      engine:
        version === undefined ? { kind, dir, bundlePath } : { kind, dir, bundlePath, version },
      expectedVersion,
    },
  };
}

/**
 * Narrow one secret-store request.
 *
 * `set` requires a value; `get` and `delete` must not carry one, so a host bug
 * that sends the wrong operation cannot leave a secret behind as a side effect.
 *
 * @param raw the candidate message
 * @returns the message, or the reason it was refused
 */
function narrowSecureRequest(raw: Record<string, unknown>): NarrowResult<HostToCore> {
  const requestId = raw.requestId;
  const op = raw.op;
  const key = raw.key;
  const value = raw.value;

  if (!isNonEmptyString(requestId)) return refuse("secure.request.requestId is not an id");
  if (!oneOf(SECURE_OPS, op)) return refuse("secure.request.op is not get, set or delete");
  if (!isNonEmptyString(key)) return refuse("secure.request.key is empty");
  if (!isOptionalString(value)) return refuse("secure.request.value is not a string");

  if (op === "set" && value === undefined) return refuse("secure.request.set requires a value");
  if (op !== "set" && value !== undefined)
    return refuse("secure.request carries a value it cannot use");

  return {
    ok: true,
    message:
      value === undefined
        ? { kind: "secure.request", requestId, op, key }
        : { kind: "secure.request", requestId, op, key, value },
  };
}

/**
 * Narrow one core-to-host message.
 *
 * Unrecognised kinds are refused, not forwarded: the host has one subscription
 * point per message family, and a subscriber must never see a shape it cannot
 * narrow on.
 *
 * @param raw whatever the child sent
 * @returns the message, or the reason it is not one
 */
export function narrowCoreToHost(raw: unknown): NarrowResult<CoreToHost> {
  if (!isRecord(raw)) return refuse("message is not an object");

  switch (raw.kind) {
    case "ready":
      return { ok: true, message: { kind: "ready" } };
    case "frame": {
      const channel = raw.channel;
      const payload = raw.payload;

      if (!oneOf(FRAME_CHANNELS, channel)) return refuse("frame.channel is unknown");
      if (typeof payload !== "string") return refuse("frame.payload is not a string");

      return { ok: true, message: { kind: "frame", channel, payload } };
    }
    case "command.reply": {
      const callId = raw.callId;
      const reply = raw.reply;

      if (!isNonEmptyString(callId)) return refuse("command.reply.callId is not an id");
      if (!isCommandReply(reply)) return refuse("command.reply.reply is not a command reply");

      return { ok: true, message: { kind: "command.reply", callId, reply } };
    }
    case "secure.reply":
      return narrowSecureReply(raw);
    case "status":
      return narrowStatus(raw);
    case "log": {
      const line = raw.line;

      if (typeof line !== "string") return refuse("log.line is not a string");

      return { ok: true, message: { kind: "log", line } };
    }
    default:
      return refuse(`unknown core-to-host kind ${describeKind(raw.kind)}`);
  }
}

/**
 * Narrow a secret-store answer.
 *
 * Exactly one of `value` and `error` may be present: a reply that carries both
 * would leave the host to guess whether the read succeeded.
 *
 * @param raw the candidate message
 * @returns the message, or the reason it was refused
 */
function narrowSecureReply(raw: Record<string, unknown>): NarrowResult<CoreToHost> {
  const requestId = raw.requestId;
  const value = raw.value;
  const error = raw.error;

  if (!isNonEmptyString(requestId)) return refuse("secure.reply.requestId is not an id");
  if (!isOptionalString(value)) return refuse("secure.reply.value is not a string");
  if (!isOptionalString(error)) return refuse("secure.reply.error is not a string");
  if (value !== undefined && error !== undefined) {
    return refuse("secure.reply carries both a value and an error");
  }

  return {
    ok: true,
    message: {
      kind: "secure.reply",
      requestId,
      ...(value === undefined ? {} : { value }),
      ...(error === undefined ? {} : { error }),
    },
  };
}

/**
 * Narrow a status snapshot.
 *
 * A `failed` phase without a failure would render an empty page, so the pairing
 * is checked here rather than at every subscriber.
 *
 * @param raw the candidate message
 * @returns the message, or the reason it was refused
 */
function narrowStatus(raw: Record<string, unknown>): NarrowResult<CoreToHost> {
  const phase = raw.phase;

  if (!oneOf(RUNTIME_PHASES, phase)) return refuse("status.phase is unknown");

  const failure = raw.failure;

  if (failure !== undefined) {
    if (!isRecord(failure)) return refuse("status.failure is not an object");
    if (!oneOf(RUNTIME_FAILURE_KINDS, failure.kind))
      return refuse("status.failure.kind is unknown");
    if (typeof failure.detail !== "string") return refuse("status.failure.detail is not a string");
    if (!isOptionalString(failure.logPath)) return refuse("status.failure.logPath is not a path");
    if (!isOptionalString(failure.candidateDir))
      return refuse("status.failure.candidateDir is not a path");
    if (!isOptionalString(failure.expectedVersion))
      return refuse("status.failure.expectedVersion is not a version");
    if (!isOptionalString(failure.actualVersion))
      return refuse("status.failure.actualVersion is not a version");
    if (!isOptionalString(failure.homeDir)) return refuse("status.failure.homeDir is not a path");
    if (!isOptionalStringList(failure.searchedPaths))
      return refuse("status.failure.searchedPaths is not a list of paths");
    if (!isOptionalStringList(failure.missingEntries))
      return refuse("status.failure.missingEntries is not a list of names");
  }

  const engineVersion = raw.engineVersion;
  const source = raw.source;
  const cwd = raw.cwd;

  if (!isOptionalString(engineVersion)) return refuse("status.engineVersion is not a string");
  if (!isOptionalString(source)) return refuse("status.source is not a string");
  if (!isOptionalString(cwd)) return refuse("status.cwd is not a path");

  if (phase === "failed" && failure === undefined) {
    return refuse("status.failed carries no failure");
  }

  const narrowedFailure: RuntimeFailure | undefined =
    failure === undefined
      ? undefined
      : {
          kind: failure.kind as RuntimeFailureKind,
          detail: failure.detail as string,
          // Rebuilt field by field, never spread: a future field added to the
          // message but not to this list would be silently dropped here, and the
          // symptom would look exactly like the failure the page never received.
          ...(failure.logPath === undefined ? {} : { logPath: failure.logPath as string }),
          ...(failure.searchedPaths === undefined
            ? {}
            : { searchedPaths: [...(failure.searchedPaths as readonly string[])] }),
          ...(failure.missingEntries === undefined
            ? {}
            : { missingEntries: [...(failure.missingEntries as readonly string[])] }),
          ...(failure.candidateDir === undefined
            ? {}
            : { candidateDir: failure.candidateDir as string }),
          ...(failure.expectedVersion === undefined
            ? {}
            : { expectedVersion: failure.expectedVersion as string }),
          ...(failure.actualVersion === undefined
            ? {}
            : { actualVersion: failure.actualVersion as string }),
          ...(failure.homeDir === undefined ? {} : { homeDir: failure.homeDir as string }),
        };

  return {
    ok: true,
    message: {
      kind: "status",
      phase,
      ...(narrowedFailure === undefined ? {} : { failure: narrowedFailure }),
      ...(engineVersion === undefined ? {} : { engineVersion }),
      ...(source === undefined ? {} : { source }),
      ...(cwd === undefined ? {} : { cwd }),
    },
  };
}

/** @returns whether the value is a host-to-core message */
export function isHostToCore(raw: unknown): raw is HostToCore {
  return narrowHostToCore(raw).ok;
}

/** @returns whether the value is a core-to-host message */
export function isCoreToHost(raw: unknown): raw is CoreToHost {
  return narrowCoreToHost(raw).ok;
}
