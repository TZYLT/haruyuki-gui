/**
 * Frame body serializability: the guard that keeps a frame body inside the JSON
 * subset every host can transport.
 *
 * `JSON.stringify` is not a validator. It silently rewrites a `Date` through
 * `toJSON`, flattens a `Map` and a `Set` to `{}`, throws a bare `TypeError` for
 * a `BigInt`, drops an `undefined` property, and gives up on a cycle with an
 * error that names no field. A frame that loses a field that way is accepted by
 * the producer and decoded as something else by the peer, which is the one
 * failure mode this layer exists to prevent. So the check is explicit and
 * structural: walk the value, stop at the first offending node, and report the
 * path a human can type into a debugger.
 *
 * Two safeguards, both required, and neither is a substitute for the other:
 *
 * - the depth cap ({@link MAX_DEPTH}) bounds the recursion, so a structure that
 *   is merely enormous can never exhaust the stack and surface as a generic
 *   "too deep" crash instead of a diagnosable `depth` violation;
 * - the cycle set records the objects on the *current* path, so a self-reference
 *   or a mutual reference is reported as `cycle` at its exact field rather than
 *   being mistaken for a very deep structure.
 *
 * A cycle is removed from the set when its subtree has been walked, so a value
 * that is merely *shared* (the same object appearing in two sibling fields) is
 * legal: it serializes to two equal copies, which is what the wire carries.
 *
 * Path convention
 *   The path is relative to the value passed in, which is normally a frame body
 *   or a whole frame: properties are joined with `.` and array positions use
 *   `[n]`, so `body.items[3].createdAt` names a `Date`. The empty string means
 *   the value passed in is itself the violation. Property names are appended
 *   verbatim, so a name that contains a dot or a bracket makes the path
 *   ambiguous; that is accepted because the path is a diagnostic, not an
 *   identifier, and quoting every segment would make the common case unreadable.
 *
 * `toJSON` is deliberately NOT honored
 *   A value that defines `toJSON` is not validated through that hook. The hook
 *   is arbitrary code: calling it during validation (a) runs side effects and may
 *   throw, (b) can return another unsupported value, which would have to be
 *   re-validated to a fixpoint, and (c) makes the answer depend on state the
 *   validator cannot see, so the same frame could validate differently twice.
 *   There is also no way to ask a `Date` for its identity after `toJSON` has
 *   hidden it: honoring the hook would make `Date`, the first of the rejected
 *   classes, undetectable and would quietly bless the lossy rewrite this layer
 *   exists to reject. The rule is therefore "a producer that wants a `toJSON`
 *   shape must call it itself, before handing the value over"; the hook itself
 *   is then rejected as the `function` property it is. This is stated in the
 *   tests as well, because a validator that disagrees with `JSON.stringify` has
 *   to say so out loud.
 *
 * Scope, stated so a reader does not expect more than this
 *   Rejected: `Date`, `Map`, `Set`, `BigInt`, `undefined`, functions, symbols,
 *   cycles, and anything deeper than {@link MAX_DEPTH}. Symbol-keyed and
 *   non-enumerable properties are ignored, exactly as `JSON.stringify` ignores
 *   them, so they cannot smuggle an unsupported value onto the wire either.
 *   Accepted: `null`, booleans, strings, numbers (a non-finite number is inside
 *   JSON's grammar -- it becomes `null` -- and its loss is a separate contract
 *   concern, see `testing/transport/delivery.ts`), arrays, and ordinary objects.
 *   A class instance is walked as the plain object it serializes to; this guard
 *   decides transportability, not shape.
 *
 * Errors, not result objects: the repository convention is that a violated
 * invariant throws a typed error carrying its machine-readable code, so this
 * module offers both {@link findSerializationViolation} (for a caller that wants
 * to inspect before deciding) and {@link assertSerializable} (for a caller that
 * wants the throw).
 */

/** Machine-readable code carried by {@link FrameSerializationError}. */
export const FRAME_NOT_SERIALIZABLE = "FRAME_NOT_SERIALIZABLE" as const;

/**
 * Maximum container depth, counted as edges from the value passed in.
 *
 * The root value is at depth 0, so a leaf reached through 64 nested containers
 * is accepted and one reached through 65 is a `depth` violation. The cap is
 * small on purpose: it is a frame body, and a body that deep is a bug in the
 * producer, not a legitimate payload.
 */
export const MAX_DEPTH = 64 as const;

/**
 * Short, stable identifier for the class of violation.
 *
 * `function` and `symbol` are separate from `undefined` on purpose: a caller
 * that logs or metrics these needs to tell "a field was left out" from "someone
 * handed us a callback", and collapsing them would lose that.
 */
export type SerializationViolationKind =
  "date" | "map" | "set" | "bigint" | "undefined" | "function" | "symbol" | "cycle" | "depth";

/** The first offending node: where it is, and which class of value it is. */
export interface FrameSerializationViolation {
  /** Path from the value passed in; `""` means the value itself. */
  readonly path: string;
  readonly kind: SerializationViolationKind;
}

/**
 * Thrown by {@link assertSerializable}.
 *
 * `code` is a literal so a host can switch on it without a cast, and `path` /
 * `kind` mirror the violation that produced the error. The message repeats the
 * path because a caught error is usually all a field report carries.
 */
export class FrameSerializationError extends Error {
  readonly code = FRAME_NOT_SERIALIZABLE;

  /** Path from the value passed in; `""` means the value itself. */
  readonly path: string;

  readonly kind: SerializationViolationKind;

  constructor(violation: FrameSerializationViolation) {
    super(
      `frame body is not JSON-serializable: ${violation.kind} at path ${describePath(violation.path)}`,
    );
    this.name = "FrameSerializationError";
    this.path = violation.path;
    this.kind = violation.kind;
  }
}

/** Render a path for the error message, naming the root explicitly. */
function describePath(path: string): string {
  return path.length === 0 ? "<root>" : `"${path}"`;
}

/**
 * Object identity check for the recursion.
 *
 * `typeof null` is `"object"`, so the null guard is part of the predicate rather
 * than a separate branch at every call site.
 */
function isContainer(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Classify a value that is unsupported regardless of its position.
 *
 * Returns `null` for a supported primitive and for any container, because a
 * container is judged by its contents (and by the cycle set) instead. `Date`,
 * `Map` and `Set` are checked before the container branch, so they are never
 * walked as plain objects: doing so would flatten a `Map` to `{}` and then call
 * it valid.
 */
function classifyUnsupported(value: unknown): SerializationViolationKind | null {
  const type = typeof value;

  if (type === "undefined") {
    return "undefined";
  }

  if (type === "bigint") {
    return "bigint";
  }

  if (type === "symbol") {
    return "symbol";
  }

  if (type === "function") {
    return "function";
  }

  if (value instanceof Date) {
    return "date";
  }

  if (value instanceof Map) {
    return "map";
  }

  if (value instanceof Set) {
    return "set";
  }

  return null;
}

/** Append a property name to a path. */
function propertyPath(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/** Append an array index to a path; the root array yields `[0]`. */
function indexPath(path: string, index: number): string {
  return `${path}[${index}]`;
}

/**
 * Walk one node and return the first violation below it, or `null`.
 *
 * Order matters. The depth cap is checked first so no other branch can recurse
 * past it; then the class check, because a `Map` is a container whose entries
 * are not its properties; then the cycle check, before descending, so the
 * current node is on the path when its children look up at it.
 */
function findViolation(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): FrameSerializationViolation | null {
  if (depth > MAX_DEPTH) {
    return { path, kind: "depth" };
  }

  const unsupported = classifyUnsupported(value);

  if (unsupported !== null) {
    return { path, kind: unsupported };
  }

  if (!isContainer(value)) {
    return null;
  }

  if (ancestors.has(value)) {
    return { path, kind: "cycle" };
  }

  ancestors.add(value);

  const violation = Array.isArray(value)
    ? findInArray(value, path, depth, ancestors)
    : findInObject(value, path, depth, ancestors);

  // Removed on every exit path, including the failure one: a sibling may legally
  // hold the same sub-object, and only the current path defines a cycle.
  ancestors.delete(value);

  return violation;
}

/** Walk array elements in index order. Holes read as `undefined` and fail. */
function findInArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
): FrameSerializationViolation | null {
  for (let index = 0; index < value.length; index += 1) {
    const violation = findViolation(value[index], indexPath(path, index), depth + 1, ancestors);

    if (violation !== null) {
      return violation;
    }
  }

  return null;
}

/**
 * Walk own enumerable string-keyed properties in `Object.keys` order.
 *
 * That is exactly the set `JSON.stringify` visits, so a symbol-keyed or
 * non-enumerable value can neither reach the wire nor fail this check.
 */
function findInObject(
  value: object,
  path: string,
  depth: number,
  ancestors: Set<object>,
): FrameSerializationViolation | null {
  const record = value as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    const violation = findViolation(record[key], propertyPath(path, key), depth + 1, ancestors);

    if (violation !== null) {
      return violation;
    }
  }

  return null;
}

/**
 * Return the first place where `value` leaves the JSON-serializable subset, or
 * `null` when it is entirely inside it.
 *
 * Total: every input, including `undefined`, a function or a hostile object,
 * produces a verdict rather than an exception. Callers that treat a violation as
 * fatal should use {@link assertSerializable} instead.
 *
 * @param value the value to inspect, normally a frame body or a whole frame
 */
export function findSerializationViolation(value: unknown): FrameSerializationViolation | null {
  return findViolation(value, "", 0, new Set<object>());
}

/**
 * Assert that `value` is inside the JSON-serializable subset.
 *
 * @param value the value to inspect, normally a frame body or a whole frame
 * @throws {FrameSerializationError} with code {@link FRAME_NOT_SERIALIZABLE} and
 *   the offending path, when the first violation is found
 */
export function assertSerializable(value: unknown): void {
  const violation = findSerializationViolation(value);

  if (violation !== null) {
    throw new FrameSerializationError(violation);
  }
}
