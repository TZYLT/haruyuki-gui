/**
 * Start-path internals of the engine facade.
 *
 * Everything here is machinery the `Engine` class in `./engine` needs and
 * nothing else: the classified error it rejects with, the single-shot fault
 * signal that lets a dead child end an awaited step early, the race that combines
 * the two, the spawn-spec validation that runs before anything is created, and
 * three small readers that treat a thrown value as untrusted input.
 *
 * Why a separate module: the facade file is the state machine and nothing else.
 * These pieces are pure - no socket, no child, no state - so they can be read and
 * tested on their own, and the facade stays inside the repository's file-size
 * limit.
 *
 * Not re-exported from `./index`: `EngineStartError` is the rejection value of
 * `start`/`attach`, and consumers narrow it with `isEngineError` (see
 * `./errors`) instead of importing a class.
 */

import type { EngineErrorCode, EngineSpawnSpec } from "./types";

/** The eight fields of the frozen spawn spec, in data order. */
const SPAWN_SPEC_FIELDS = [
  "exePath",
  "env",
  "argvPrefix",
  "bundlePath",
  "cwd",
  "stdio",
  "windowsHide",
  "detached",
] as const;

/**
 * One classified failure, thrown as the facade's rejection value.
 *
 * It is an `Error` (so Node and a debugger keep a stack) that also satisfies the
 * frozen `EngineError` shape: `code`, `detail` and an optional `wireHint`.
 * `isEngineError` accepts it unchanged, so `toEngineError(thrown)` round-trips
 * without a second classification pass.
 */
export class EngineStartError extends Error {
  readonly code: EngineErrorCode;

  readonly detail: string;

  readonly wireHint?: string;

  constructor(code: EngineErrorCode, detail: string, wireHint?: string) {
    super(detail);
    this.name = "EngineStartError";
    this.code = code;
    this.detail = detail;
    if (wireHint !== undefined) {
      this.wireHint = wireHint;
    }
  }
}

/**
 * A fault signal that can end an awaited start step early.
 *
 * A child can die between two awaited steps (or while one is pending), and a
 * dead process never produces a WebSocket URL or a handshake answer; without
 * this signal every such failure would wait out the full timeout and be
 * classified as a timeout instead of as the spawn failure it is. The promise is
 * single-shot and always carries a handled rejection, so a fault raised after
 * the start path finished cannot surface as an unhandled rejection.
 */
export class FaultSignal {
  readonly promise: Promise<never>;

  // Assigned by the promise executor below, which TypeScript cannot prove.
  private reject!: (error: EngineStartError) => void;

  private settled = false;

  private failure: EngineStartError | null = null;

  constructor() {
    this.promise = new Promise<never>((_resolve, reject) => {
      this.reject = reject;
    });
    this.promise.catch(() => undefined);
  }

  /** The classified fault, or `null` while the child is healthy. */
  get raised(): EngineStartError | null {
    return this.failure;
  }

  /** Raise the fault once; later calls are ignored because the first wins. */
  fail(error: EngineStartError): void {
    if (this.settled) {
      return;
    }

    this.settled = true;
    this.failure = error;
    this.reject(error);
  }
}

/**
 * The one engine facade.
 *
 * Not a singleton: the host may construct one per hosted engine. All mutable
/** Run `work` and the fault signal in parallel; never leaves a rejection unhandled. */
export async function raceWithFault<T>(work: Promise<T>, fault: Promise<never>): Promise<T> {
  const guarded = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const faulted = fault.then(
    () => ({ ok: false as const, error: new Error("engine fault") }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const result = await Promise.race([guarded, faulted]);

  if (result.ok) {
    return result.value;
  }

  throw result.error;
}

/** Validate the frozen eight-field spawn spec; throw `SPAWN_FAILED` with all faults. */
export function assertSpawnSpec(spec: unknown): void {
  const problems = spawnSpecProblems(spec);

  if (problems.length > 0) {
    throw new EngineStartError("SPAWN_FAILED", `invalid spawn spec: ${problems.join("; ")}`);
  }
}

/**
 * Collect the missing or mistyped spawn-spec fields as human sentences.
 *
 * Missing fields are reported first and on their own line, because a missing
 * field usually means the wrong object was passed and reporting types as well
 * would bury that.
 */
function spawnSpecProblems(spec: unknown): string[] {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return ["spawn spec is not an object"];
  }

  const record = spec as Record<string, unknown>;
  const missing = SPAWN_SPEC_FIELDS.filter((field) => !(field in record));

  if (missing.length > 0) {
    return missing.map((field) => `missing field "${field}"`);
  }

  const problems: string[] = [];

  for (const field of ["exePath", "bundlePath", "cwd"] as const) {
    if (!isNonEmptyString(record[field])) {
      problems.push(`"${field}" must be a non-empty string`);
    }
  }

  if (!isStringRecord(record.env)) {
    problems.push('"env" must be a record of string values');
  }

  const argvPrefix = record.argvPrefix;
  if (!Array.isArray(argvPrefix) || argvPrefix.some((item) => typeof item !== "string")) {
    problems.push('"argvPrefix" must be an array of strings');
  }

  if (record.stdio !== "pipe") {
    problems.push('"stdio" must be "pipe"');
  }

  if (typeof record.windowsHide !== "boolean") {
    problems.push('"windowsHide" must be a boolean');
  }

  if (typeof record.detached !== "boolean") {
    problems.push('"detached" must be a boolean');
  }

  return problems;
}

/** True for a non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** True for a record whose every value is a string. */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((item) => typeof item === "string");
}

/**
 * Normalize a caller-supplied budget: a non-finite value falls back to the
 * documented default and a negative value means "no waiting".
 */
export function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

/** Readable message for a thrown value of unknown shape. */
export function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return String(error);
}

/** Read a Node fault code without trusting the thrown value. */
export function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}
