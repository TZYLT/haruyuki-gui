/**
 * snapshot.ts - the deterministic serialiser behind vitest snapshots.
 *
 * Scope: the `SnapshotRules` shape and the `normalizeForSnapshot` signature
 * below. A golden file is produced by vitest's native `toMatchSnapshot` over
 * this serialiser's output; no third snapshot tool is involved. Redaction is a
 * recording-time concern and is not done here: this is the gate-side normaliser.
 *
 * The output is plain JSON-shaped data, so a snapshot is a stable string and a
 * failure says "these bytes changed" rather than "these object identities
 * changed". Determinism rules:
 *
 * - object keys are sorted by their normalised name (arrays keep their order);
 * - `volatileKeys` values become `"<volatile>"` at any depth;
 * - every substring matching a `pathPatterns` entry becomes `"<path>"`, in both
 *   values and keys, so an absolute path, a home directory or a temp directory
 *   from the recording machine does not reach the golden file;
 * - a cycle becomes `"<cycle>"` instead of a thrown `TypeError`;
 * - values JSON cannot represent become named strings instead of disappearing.
 *
 * The last rule is why `undefined` becomes `"<undefined>"`: a serialiser that
 * must return JSON-able data cannot keep `undefined` as a value, and turning it
 * into `null` would erase the difference a snapshot exists to show. `null`
 * stays `null`, so the two remain distinguishable in the snapshot.
 *
 * Volatile and path rules are applied to the whole tree, including map-shaped
 * objects whose keys happened to be paths. If two keys normalise to the same
 * text, the later one (in sorted order) gets a `#2`, `#3`, ... suffix so no data
 * is lost.
 */

/** Replacement for a value under a volatile key. */
export const VOLATILE_PLACEHOLDER = "<volatile>";

/** Replacement for a path-shaped substring or key. */
export const PATH_PLACEHOLDER = "<path>";

/** Replacement for a value JSON cannot carry; distinct from `null`. */
export const UNDEFINED_PLACEHOLDER = "<undefined>";

/** Replacement for a back-reference in a cyclic structure. */
export const CYCLE_PLACEHOLDER = "<cycle>";

/**
 * The frozen rule shape: volatile keys plus path patterns.
 *
 * A caller who supplies `rules` replaces both defaults wholesale: pass empty
 * arrays to disable normalisation, or the exported defaults to extend nothing.
 */
export type SnapshotRules = {
  volatileKeys: string[];
  pathPatterns: RegExp[];
};

/** Keys whose values differ on every run. */
export const DEFAULT_VOLATILE_KEYS: string[] = [
  "emitted_at",
  "idempotency_key",
  "request_id",
  "pid",
  "at",
];

/**
 * Machine-specific path shapes.
 *
 * Order matters: the specific home and temp patterns run first, then the
 * generic absolute-path patterns. Every match becomes {@link PATH_PLACEHOLDER}.
 */
export const DEFAULT_PATH_PATTERNS: RegExp[] = [
  // POSIX home directory, e.g. /home/alice or /Users/alice. Spaces are allowed
  // in a user name, so the rest of the string is consumed rather than guessing
  // where a name ends. The lookbehind keeps "https://Users/..." out.
  /(?<![\w:/])\/(?:home|Users)\/[^"'\r\n]*/g,
  // POSIX temporary trees, e.g. /tmp/x, /var/folders/x, /private/var/folders/x.
  /(?<![\w:/])\/(?:tmp|var\/folders|private\/var\/folders)\/[^"'\r\n]*/g,
  // Windows absolute path, e.g. C:\Users\alice\AppData\Local\Temp\x, including
  // the forward-slash spelling and spaces inside a directory name. The
  // lookbehind stops a URL's "s:/" from being read as an "s:" drive.
  /(?<!\w)[A-Za-z]:[\\/][^"'\r\n]*/g,
  // Any other POSIX-looking absolute path. A leading "/" is required and must
  // not follow a word character, ":" or another "/", so URLs are left alone.
  /(?<![\w:/])\/(?:[^\s/"']+\/)*[^\s/"']+/g,
];

/** Per-call state; `ancestors` is the path to the current node, not global. */
type NormalizeContext = {
  volatile: ReadonlySet<string>;
  patterns: RegExp[];
  ancestors: Set<object>;
};

/**
 * Normalise a value for a stable snapshot.
 *
 * @param value Any value a test wants to snapshot.
 * @param rules Optional replacement for the frozen defaults.
 * @returns Plain JSON-shaped data.
 */
export function normalizeForSnapshot(value: unknown, rules?: SnapshotRules): unknown {
  const context: NormalizeContext = {
    volatile: new Set(rules?.volatileKeys ?? DEFAULT_VOLATILE_KEYS),
    patterns: (rules?.pathPatterns ?? DEFAULT_PATH_PATTERNS).map(asGlobal),
    ancestors: new Set<object>(),
  };

  return normalizeValue(value, context);
}

/** Copy a rule into a fresh global regex, so shared pattern state cannot leak. */
function asGlobal(pattern: RegExp): RegExp {
  if (pattern.global) {
    return new RegExp(pattern.source, pattern.flags);
  }

  return new RegExp(pattern.source, `${pattern.flags}g`);
}

/** Normalise one value, dispatching on its JSON-relevant type. */
function normalizeValue(value: unknown, context: NormalizeContext): unknown {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "undefined":
      return UNDEFINED_PLACEHOLDER;
    case "string":
      return normalizeText(value, context.patterns);
    case "number":
      if (Number.isNaN(value)) {
        return "<number:NaN>";
      }

      if (value === Number.POSITIVE_INFINITY) {
        return "<number:Infinity>";
      }

      if (value === Number.NEGATIVE_INFINITY) {
        return "<number:-Infinity>";
      }

      return value;
    case "boolean":
      return value;
    case "bigint":
      return `<bigint:${value.toString()}>`;
    case "function":
      return "<function>";
    case "symbol":
      return "<symbol>";
    default:
      return normalizeObject(value as object, context);
  }
}

/** Normalise one object: array, date, map, set or plain record. */
function normalizeObject(value: object, context: NormalizeContext): unknown {
  if (context.ancestors.has(value)) {
    return CYCLE_PLACEHOLDER;
  }

  if (Array.isArray(value)) {
    return normalizeArray(value as unknown[], context);
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "<date:invalid>" : value.toISOString();
  }

  if (value instanceof Map) {
    return "<map>";
  }

  if (value instanceof Set) {
    return "<set>";
  }

  return normalizeRecord(value as Record<string, unknown>, context);
}

/** Normalise an array, preserving order; a cycle becomes a placeholder. */
function normalizeArray(value: unknown[], context: NormalizeContext): unknown[] {
  context.ancestors.add(value);

  try {
    return value.map((item) => normalizeValue(item, context));
  } finally {
    context.ancestors.delete(value);
  }
}

/** Normalise a record: sorted normalised keys, volatile values replaced. */
function normalizeRecord(
  value: Record<string, unknown>,
  context: NormalizeContext,
): Record<string, unknown> {
  context.ancestors.add(value);

  try {
    const entries = Object.keys(value)
      .map((key) => ({
        source: key,
        key: normalizeText(key, context.patterns),
        value: value[key],
      }))
      .sort(
        (left, right) => compareText(left.key, right.key) || compareText(left.source, right.source),
      );

    const result: Record<string, unknown> = {};

    for (const entry of entries) {
      const key = uniqueKey(result, entry.key);
      const normalized = context.volatile.has(entry.source)
        ? VOLATILE_PLACEHOLDER
        : normalizeValue(entry.value, context);

      defineKey(result, key, normalized);
    }

    return result;
  } finally {
    context.ancestors.delete(value);
  }
}

/** Apply every path pattern to a string, then collapse duplicates. */
function normalizeText(text: string, patterns: readonly RegExp[]): string {
  let result = text;

  for (const pattern of patterns) {
    result = result.replace(pattern, PATH_PLACEHOLDER);
  }

  return result;
}

/** Find a key that is not taken yet, appending `#2`, `#3`, ... on collision. */
function uniqueKey(result: Record<string, unknown>, key: string): string {
  let candidate = key;
  let suffix = 1;

  while (Object.prototype.hasOwnProperty.call(result, candidate)) {
    suffix += 1;
    candidate = `${key}#${suffix}`;
  }

  return candidate;
}

/** Define one own enumerable property without tripping over `__proto__`. */
function defineKey(result: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    return;
  }

  result[key] = value;
}

/** Locale-independent string order, so keys sort the same on every machine. */
function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}
