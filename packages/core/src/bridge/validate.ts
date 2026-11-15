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
  | "date"
  | "map"
  | "set"
  | "bigint"
  | "undefined"
  | "function"
  | "symbol"
  | "cycle"
  | "depth"
  | "non-finite"
  | "to-json"
  | "lossy-object"
  | "hostile";

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
 *
 * Two detections are deliberately belt-and-braces:
 *
 * - `instanceof` answers "same realm", which is the common case and the cheapest
 *   check. The class test is then repeated on the internal tag, because the
 *   renderer is a separate realm: a value that crossed a `structuredClone`, a
 *   worker boundary or a `vm` context fails every `instanceof` against this
 *   realm's constructors and would otherwise be walked as an empty object --
 *   exactly the lossy rewrite this module exists to reject.
 * - a non-finite number is inside JSON's *grammar* but not inside its
 *   *information*: `JSON.stringify` writes `NaN` and both infinities as `null`,
 *   so a peer that receives one cannot tell "not a number" from "absent". The
 *   module header already promises to reject values that are rewritten on the
 *   way out, and these are rewritten.
 *
 * @param value the candidate value
 * @returns the violation kind, or `null` when the value is supported
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

  if (type === "number" && !Number.isFinite(value as number)) {
    return "non-finite";
  }

  if (value instanceof Date || internalTag(value) === "[object Date]") {
    return "date";
  }

  if (value instanceof Map || internalTag(value) === "[object Map]") {
    return "map";
  }

  if (value instanceof Set || internalTag(value) === "[object Set]") {
    return "set";
  }

  // Anything that is not a plain object or an array is rewritten by
  // `JSON.stringify` rather than copied: a `RegExp`, an `Error`, an
  // `ArrayBuffer` and an `ArrayBufferView` all become `{}`, and a typed array
  // becomes a plain object keyed by index. Enumerating the offenders one by one
  // is how `Map` and `Set` were caught while their neighbours were missed; the
  // tag is the one place that knows the difference and is already computed.
  const tag = internalTag(value);

  if (tag !== null && tag !== "[object Object]" && tag !== "[object Array]") {
    return "lossy-object";
  }

  return null;
}

/**
 * The `Object.prototype.toString` tag of a value, or `null` when it cannot be
 * read without running caller code.
 *
 * The tag is realm-independent, which is the whole point: `instanceof` compares
 * constructors, and a foreign realm has different ones.
 *
 * @param value any value
 * @returns the tag, or `null` when the read throws
 */
function internalTag(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  try {
    return Object.prototype.toString.call(value);
  } catch {
    // A hostile `Symbol.toStringTag` getter must not escape as a raw error; the
    // walk converts it into a `hostile` violation at the same path.
    return null;
  }
}

/**
 * Whether a value carries its own `toJSON` anywhere on its prototype chain.
 *
 * `toJSON` is rejected rather than honoured (see the module header). The check
 * has to walk the chain, not just the own keys, because the shape that actually
 * appears in a codebase is a *class* with a method -- `class Money { toJSON() }`
 * -- where the function lives on the prototype and `Object.keys` never sees it.
 * Missing that case would let `JSON.stringify` silently rewrite the payload to
 * whatever the method returns, including a value outside the JSON subset.
 *
 * @param value a value already known to be a non-null object and not a Date
 * @returns `true` when calling the value's `toJSON` would run caller code
 */
function hasToJSON(value: object): boolean {
  try {
    return typeof (value as { toJSON?: unknown }).toJSON === "function";
  } catch {
    // A throwing getter is caller code running during validation; the caller
    // reports it as `hostile` at this path.
    throw new HostileRead();
  }
}

/** Marker for "reading this value ran caller code that threw". */
class HostileRead extends Error {}

/**
 * Append a property name to a path.
 *
 * An empty key renders as `[""]` rather than as nothing. Without that, a
 * violation at `value[""]` produced the same path as a violation at `value`
 * itself, and the error message said "<root>" for a field that is demonstrably
 * not the root.
 *
 * @param path path to the containing value
 * @param key the property name
 * @returns the child's path
 */
function propertyPath(path: string, key: string): string {
  if (key.length === 0) {
    return `${path}[""]`;
  }

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
  cleared: WeakSet<object>,
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

  // A subtree already proven clean needs no second walk. Without this, a legal
  // DAG that shares one subtree under both branches is visited 2^depth times:
  // a body 26 levels deep (well inside MAX_DEPTH) took over eight seconds, and
  // the cost is exponential in depth rather than linear in nodes.
  if (cleared.has(value)) {
    return null;
  }

  if (ancestors.has(value)) {
    return { path, kind: "cycle" };
  }

  ancestors.add(value);

  let violation: FrameSerializationViolation | null;

  try {
    violation = Array.isArray(value)
      ? findInArray(value, path, depth, ancestors, cleared)
      : findInObject(value, path, depth, ancestors, cleared);
  } catch (error) {
    // Reading a hostile getter or proxy trap ran caller code that threw. The
    // module promises a verdict rather than an exception, and the caller can
    // only branch on a coded error, so it becomes a violation here.
    if (error instanceof HostileRead) {
      violation = { path, kind: "hostile" };
    } else {
      throw error;
    }
  }

  // Removed on every exit path, including the failure one: a sibling may legally
  // hold the same sub-object, and only the current path defines a cycle.
  ancestors.delete(value);

  if (violation === null) {
    cleared.add(value);
  }

  return violation;
}

/** Walk array elements in index order. Holes read as `undefined` and fail. */
function findInArray(
  value: readonly unknown[],
  path: string,
  depth: number,
  ancestors: Set<object>,
  cleared: WeakSet<object>,
): FrameSerializationViolation | null {
  for (let index = 0; index < value.length; index += 1) {
    let element: unknown;

    try {
      element = value[index];
    } catch {
      return { path: indexPath(path, index), kind: "hostile" };
    }

    const violation = findViolation(element, indexPath(path, index), depth + 1, ancestors, cleared);

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
 *
 * `toJSON` is checked before the keys are read, on the value itself and on its
 * prototype chain: it is the one thing `JSON.stringify` consults that is not a
 * property it writes, so a value carrying one is rewritten rather than copied.
 *
 * @param value one object node
 * @param path path to this node
 * @param depth nesting depth of this node
 * @param ancestors objects on the current path, for cycle detection
 * @param cleared subtrees already proven clean
 * @returns the first violation under this node, or `null`
 */
function findInObject(
  value: object,
  path: string,
  depth: number,
  ancestors: Set<object>,
  cleared: WeakSet<object>,
): FrameSerializationViolation | null {
  if (hasToJSON(value)) {
    return { path, kind: "to-json" };
  }

  const record = value as Record<string, unknown>;
  let keys: string[];

  try {
    keys = Object.keys(record);
  } catch {
    throw new HostileRead();
  }

  for (const key of keys) {
    let child: unknown;

    try {
      child = record[key];
    } catch {
      // Named at the field that could not be read, which is the only position a
      // human can act on; reporting the containing object instead would send
      // them looking at the wrong level.
      return { path: propertyPath(path, key), kind: "hostile" };
    }

    const violation = findViolation(child, propertyPath(path, key), depth + 1, ancestors, cleared);

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
  return findViolation(value, "", 0, new Set<object>(), new WeakSet<object>());
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
