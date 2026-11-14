/**
 * Engine error classification: every failure funnels into the five frozen codes.
 *
 * Shape source: no recursive-B1 sections 3.1 (module split), 3.2 (the log owns this
 * file), 3.3 (c) (`EngineError`), 3.3 (f) (the classification table) and 4.2
 * (work package).
 *
 * The layering rule behind this file: the lower layers already own their local
 * classification, so this module never re-inspects a message string to guess a
 * code. It only maps the shapes the start path can actually throw:
 *
 * - `EngineConnectionError` -> its own `toEngineError()`, wire hint included;
 * - `PortNotFoundError` -> `PORT_NOT_FOUND` with the parser's detail;
 * - a spawn-side failure (ENOENT / EACCES / EPERM, or a future
 *   `EngineSpawnError`) -> `SPAWN_FAILED`, because section 3.3 (f) classes
 *   "spawn threw" as `start` 前置;
 * - an already-classified `EngineError` -> itself, so the facade can classify in
 *   layers without the code drifting (mapping is idempotent);
 * - anything else -> `TIMEOUT`, the documented fallback, with the original
 *   message kept as the detail so a field report still carries the raw fault.
 *
 * `spawn.ts` raises plain Node errors (`ENOENT`, `EACCES`, ...) rather than an
 * `EngineSpawnError` class, so the spawn branch recognises those Node fault
 * codes and also the class NAME. That keeps this mapper stable if a spawn layer
 * ever introduces the named class.
 *
 * `detail` is for humans and logs only (see `types.ts`): nothing branches on it,
 * and no error code is redefined here - the frozen tuple in `./types` is the
 * single source of truth.
 */

import { EngineConnectionError } from "./connection";
import { PortNotFoundError } from "./port-discovery";
import { ENGINE_ERROR_CODES } from "./types";
import type { EngineError } from "./types";

/**
 * Node fault codes that mean "the child process could not be started".
 *
 * `ENOENT` (interpreter missing), `EACCES` / `EPERM` (not executable or blocked
 * by policy), `ENOEXEC` (wrong format), `ENOTDIR` / `EISDIR` (bad path shape) and
 * the descriptor-exhaustion pair are all spawn-time faults, not port or
 * handshake faults.
 */
const SPAWN_FAULT_CODES: ReadonlySet<string> = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ENOEXEC",
  "ENOTDIR",
  "EISDIR",
  "EMFILE",
  "ENFILE",
]);

/** Class name a future spawn layer may use for the same faults. */
const SPAWN_ERROR_NAME = "EngineSpawnError";

/** Upper bound of a detail built from a thrown value. */
const MAX_DETAIL_CHARS = 500;

/** Upper bound of a `wireHint` copied from a thrown value. */
const MAX_HINT_CHARS = 200;

/**
 * Translate any thrown value into the frozen {@link EngineError} shape.
 *
 * The five codes are a closed set, so this function is total: every input,
 * total: every input, including a string or `null` thrown from user code, comes
 * back as one `EngineError`. The original text is preserved in `detail` (clipped
 * to one readable length) because the host has no other channel into the cause.
 *
 * @param error whatever a start or attach step threw
 */
export function toEngineError(error: unknown): EngineError {
  if (error instanceof EngineConnectionError) {
    return error.toEngineError();
  }

  if (error instanceof PortNotFoundError) {
    return { code: "PORT_NOT_FOUND", detail: error.detail };
  }

  if (isEngineError(error)) {
    return normalizeEngineError(error);
  }

  if (isSpawnFault(error)) {
    return withHint(
      { code: "SPAWN_FAILED", detail: `engine process could not be started: ${describe(error)}` },
      codeOf(error),
    );
  }

  return {
    code: "TIMEOUT",
    detail: `unclassified engine failure: ${describe(error)}`,
  };
}

/**
 * Guard for the frozen {@link EngineError} shape.
 *
 * Checks the two invariants a consumer relies on: `code` is one of the five
 * frozen values and `detail` is a string. `wireHint` is optional, but when it is
 * present it must be a string, so a half-built object cannot masquerade as a
 * classified error.
 */
export function isEngineError(value: unknown): value is EngineError {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as { code?: unknown; detail?: unknown; wireHint?: unknown };

  if (typeof record.detail !== "string") {
    return false;
  }

  if (record.wireHint !== undefined && typeof record.wireHint !== "string") {
    return false;
  }

  return (
    typeof record.code === "string" &&
    (ENGINE_ERROR_CODES as readonly string[]).includes(record.code)
  );
}

/**
 * Copy an already-classified error, dropping the hint when it is absent.
 *
 * A fresh object is returned so a caller cannot mutate the original through the
 * mapped value, and so an absent `wireHint` stays absent under
 * `exactOptionalPropertyTypes` instead of becoming an explicit `undefined`.
 */
function normalizeEngineError(error: EngineError): EngineError {
  return withHint({ code: error.code, detail: error.detail }, error.wireHint);
}

/** Attach a non-empty, clipped hint to `error` when there is one. */
function withHint(error: EngineError, hint: string | undefined): EngineError {
  const clipped = clip(hint, MAX_HINT_CHARS);

  if (clipped === undefined) {
    return error;
  }

  return { code: error.code, detail: error.detail, wireHint: clipped };
}

/** True when the value is a spawn-side fault (see `SPAWN_FAULT_CODES`). */
function isSpawnFault(value: unknown): boolean {
  if (nameOf(value) === SPAWN_ERROR_NAME) {
    return true;
  }

  const code = codeOf(value);
  return code !== undefined && SPAWN_FAULT_CODES.has(code);
}

/** Read a Node fault code (`ENOENT`, ...) without trusting the value. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }

  const code = (value as { code?: unknown }).code;
  return clip(typeof code === "string" ? code : undefined, MAX_HINT_CHARS);
}

/** Read `error.name` without trusting the value. */
function nameOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("name" in value)) {
    return undefined;
  }

  const name = (value as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/**
 * Render a thrown value as one line.
 *
 * An `Error` contributes its message (falling back to its name), a string is
 * used verbatim, and anything else is serialised defensively - `JSON.stringify`
 * can throw on a cycle, so the plain `String` form is the last resort.
 */
function describe(value: unknown): string {
  if (value instanceof Error) {
    const text = value.message.length > 0 ? value.message : value.name;
    return clip(text, MAX_DETAIL_CHARS) ?? "unknown error";
  }

  if (typeof value === "string") {
    return clip(value, MAX_DETAIL_CHARS) ?? "empty message";
  }

  let serialised: string | undefined;

  try {
    serialised = JSON.stringify(value) ?? undefined;
  } catch {
    serialised = undefined;
  }

  return clip(serialised ?? String(value), MAX_DETAIL_CHARS) ?? "unknown value";
}

/**
 * Clip a value to `limit` characters with an ellipsis, keeping `undefined` as
 * `undefined`. Whitespace is compacted so a multi-line engine output cannot
 * break the one-line shape of a log record.
 */
function clip(value: string | undefined, limit: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const compact = value.replace(/\s+/g, " ").trim();

  if (compact.length === 0) {
    return undefined;
  }

  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}
