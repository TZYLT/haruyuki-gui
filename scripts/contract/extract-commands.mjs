/**
 * extract-commands.mjs - command extraction for the contract snapshot.
 *
 * Input: the pinned engine source below `_research/haruyuki` (read-only). The
 * only indexed declarations are `src/types/**\/*.ts`, via the frozen type-index
 * seam:
 *
 *   const index = createTypeIndex(engineRoot);
 *   const union = index.resolveUnion("WsProtocolCommand", "src/types/protocol_v2.ts");
 *
 * Output: one record per wire command, shaped for the `snapshot.json` v1
 * `commands[]` slice:
 *
 *   { wire, type, home, direction, fields, shapeFingerprint, health }
 *
 * `counts.wireCommands` counts the records with a non-null wire only: a coarse
 * record (`wire: null`) stays in `commands[]` for the validator to reject, but it
 * is not a wire command.
 *
 * `inbound` and `fieldLevel` are deliberately absent. `snapshot.mjs` owns the
 * capability join (`inbound` comes from `extract-messages.mjs`) and the
 * `detail` filter (`fieldLevel` comes from `capabilities.json`). Emitting either
 * here would be a second source of
 * truth for a fact this package cannot see.
 *
 * Union expansion
 *   `WsProtocolCommand` has 115 members, but one of them is the union alias
 *   `CronProtocolCommand`, which expands to 10 `cron_*` commands. Expansion is
 *   recursive because an alias may contain another alias, and every expanded
 *   record keeps the `home` of the interface that actually declares it (the
 *   `cron_*` homes are in `schedule-protocol.ts`, not `protocol_v2.ts`).
 *   `115 - 1 + 10 = 124`.
 *
 * Direction
 *   Commands flow client-to-server (`c2s`). `file_ops` is the locked exception
 *   (fact F-07): the same interface appears in both the command and the message
 *   union, so its record carries `["c2s", "s2c"]`. The second direction is
 *   derived by matching declaration homes against `WsProtocolMessage`, never by
 *   a hard-coded wire list, so a future bidirectional interface is handled and
 *   a removed one stops being bidirectional. Merging is by direction: no
 *   type-name overwrite ever collapses the two members into one record.
 *
 * Failure semantics
 *   A single unresolvable member never throws and never disappears:
 *     - `ambiguous-symbol` keeps a `coarse` record (wire null, candidate home)
 *       because the declaration exists more than once; only a human can pick.
 *     - Any other unresolved member goes to `health.unparsed` and marks the
 *       whole extraction `degraded`.
 *     - A resolved interface without a `type` literal keeps its record with
 *       `wire: null` and `health: "coarse"`.
 *   `snapshot.mjs` maps `health.coarse` / `health.unparsed` into the snapshot
 *   health section and the frozen schema validator rejects the null wire, so a
 *   degraded engine fails visibly instead of producing a plausible snapshot.
 *
 * Determinism
 *   Commands are sorted by wire then type, fields by name, direction and the
 *   health string arrays lexicographically. Two runs over the same source are
 *   byte-identical apart from nothing at all (this package emits no timestamp).
 */

import { shapeFingerprint } from "./lib/fingerprint.mjs";
import { FAILURE_CODES, createTypeIndex } from "./lib/scan.mjs";

/** Union alias that defines the client-to-server command set. */
export const COMMAND_UNION = "WsProtocolCommand";

/** File that declares `WsProtocolCommand`. */
export const COMMAND_UNION_FILE = "src/types/protocol_v2.ts";

/** Union alias that defines the server-to-client message set. */
export const MESSAGE_UNION = "WsProtocolMessage";

/** Client-to-server direction marker. */
export const C2S = "c2s";

/** Server-to-client direction marker. */
export const S2C = "s2c";

/** Recursion guard for pathological alias chains. Real chains are one deep. */
const MAX_UNION_DEPTH = 16;

/**
 * @typedef {{
 *   name: string,
 *   type: string,
 *   optional: boolean,
 *   nested?: boolean,
 *   readonly?: boolean,
 * }} SnapshotField
 */

/**
 * @typedef {{
 *   wire: string | null,
 *   type: string,
 *   home: string,
 *   direction: string[],
 *   fields: SnapshotField[],
 *   shapeFingerprint: string,
 *   health: "ok" | "coarse",
 * }} CommandRecord
 */

/**
 * Code-unit string comparison, so sorting never depends on the host locale.
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Sort fields by name (code-unit order, the snapshot validator's rule).
 *
 * @param {SnapshotField} left
 * @param {SnapshotField} right
 * @returns {number}
 */
function compareFieldNames(left, right) {
  return compareStrings(left.name, right.name);
}

/**
 * Sort command records the way the snapshot canonicalizer does: empty wire
 * first, then type, so coarse records have a stable position.
 *
 * @param {CommandRecord} left
 * @param {CommandRecord} right
 * @returns {number}
 */
function compareCommandRecords(left, right) {
  const byWire = compareStrings(left.wire ?? "", right.wire ?? "");

  return byWire === 0 ? compareStrings(left.type, right.type) : byWire;
}

/**
 * Create the extraction health accumulator. Strings are already in the shape
 * `snapshot.health` expects (`string[]`), with the reason embedded so a coarse
 * record stays explainable without a second lookup table.
 *
 * @returns {{degraded: boolean, coarse: string[], unparsed: string[]}}
 */
function createHealth() {
  return { degraded: false, coarse: [], unparsed: [] };
}

/**
 * One single-line English health entry.
 *
 * @param {string} type
 * @param {string} home
 * @param {string} reason
 * @returns {string}
 */
function coarseLine(type, home, reason) {
  return `${type}@${home || "unknown"}: ${reason}`;
}

/**
 * @param {string} ref
 * @param {string} fromFile
 * @param {string} code
 * @param {string} message
 * @returns {string}
 */
function unparsedLine(ref, fromFile, code, message) {
  return `${ref}@${fromFile}: ${code}: ${message}`;
}

/**
 * Strip namespace and `import("./module").` decoration from a raw member ref.
 * Used only when no entry could be resolved, so the type name is still useful
 * in a coarse record.
 *
 * @param {string} ref raw member text, e.g. `Ns.Type` or `import("./m").Type`
 * @returns {string}
 */
export function refShortName(ref) {
  if (typeof ref !== "string") {
    return "";
  }

  const normalized = ref.replace(/\s+/g, " ").trim();
  const importMatch = /^import\(["'][^"']+["']\)\.(.+)$/.exec(normalized);
  const qualified = importMatch ? importMatch[1] : normalized;
  const segments = qualified.split(".");
  const last = segments[segments.length - 1];

  return last ?? "";
}

/**
 * Project scan-level fields onto the snapshot field shape.
 *
 * Scan fields carry `{name, type, optional, readonly, nested}` with booleans
 * always present. The snapshot treats `readonly` / `nested` as optional keys and
 * only records the true case, so the JSON stays small and a false flag cannot
 * masquerade as a deliberate `false`. Key order follows the frozen schema order
 * (`name, type, optional, nested, readonly`), which keeps the snapshot canonicalizer
 * a no-op on this part.
 *
 * @param {{name?: unknown, type?: unknown, optional?: unknown, readonly?: unknown, nested?: unknown}[]} fields
 * @returns {SnapshotField[]}
 */
export function normalizeFields(fields) {
  const source = Array.isArray(fields) ? fields : [];

  return source
    .filter((field) => field && typeof field.name === "string")
    .map((field) => {
      /** @type {SnapshotField} */
      const normalized = {
        name: /** @type {string} */ (field.name),
        type: typeof field.type === "string" ? field.type : "",
        optional: Boolean(field.optional),
      };

      if (field.nested) {
        normalized.nested = true;
      }

      if (field.readonly) {
        normalized.readonly = true;
      }

      return normalized;
    })
    .sort(compareFieldNames);
}

/**
 * Build one command record from a resolved interface entry.
 *
 * @param {object} entry type-index entry
 * @param {string[]} [directions] direction markers; defaults to `["c2s"]`
 * @returns {CommandRecord}
 */
export function buildCommandRecord(entry, directions = [C2S]) {
  const uniqueDirections = [...new Set(directions)].sort(compareStrings);
  const hasTypeLiteral = typeof entry.typeLiteral === "string" && entry.typeLiteral.length > 0;

  return {
    wire: hasTypeLiteral ? entry.typeLiteral : null,
    type: entry.name,
    home: `${entry.file}:${entry.line}`,
    direction: uniqueDirections,
    fields: normalizeFields(entry.fields),
    shapeFingerprint: shapeFingerprint(entry.bodyText),
    health: hasTypeLiteral ? "ok" : "coarse",
  };
}

/**
 * Build a `coarse` record for a member that resolved ambiguously. The entry is
 * not picked because two different declarations claim the same name; the first
 * candidate home is kept as evidence. `wire` is null on purpose (the frozen
 * validator rejects it), so the degradation cannot slip into a snapshot.
 *
 * @param {{ref?: string, code?: string, message?: string, candidates?: string[]}} member
 * @returns {CommandRecord}
 */
export function buildUnresolvedCommandRecord(member) {
  const candidates = Array.isArray(member.candidates) ? member.candidates : [];

  return {
    wire: null,
    type: refShortName(member.ref ?? ""),
    home: candidates[0] ?? "",
    direction: [C2S],
    fields: [],
    shapeFingerprint: shapeFingerprint(""),
    health: "coarse",
  };
}

/**
 * Walk one resolved union member list, recursively expanding union aliases.
 *
 * A member that is itself a `type X = A | B` alias is expanded in place: its
 * own members are resolved against the file that declares the alias, because
 * namespace aliases and `import("./x")` specifiers are relative to that file.
 * The alias itself never becomes a command record; only concrete interfaces do.
 *
 * @param {{resolveUnion: (name: string, fromFile: string) => object}} index type index
 * @param {object[]} members resolved member objects from `resolveUnion`
 * @param {{entries: object[], unresolved: object[], visited: Set<string>}} state
 * @param {{degraded: boolean, coarse: string[], unparsed: string[]}} health
 * @param {number} depth current alias nesting depth
 * @returns {void}
 */
function walkUnion(index, members, state, health, depth) {
  if (depth > MAX_UNION_DEPTH) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine("union", "src/types", "union-depth", `alias nesting exceeds ${MAX_UNION_DEPTH}`),
    );

    return;
  }

  for (const member of members) {
    if (!member || member.ok !== true || !member.entry) {
      if (member && member.code === FAILURE_CODES.AMBIGUOUS_SYMBOL) {
        state.unresolved.push(member);
      } else {
        health.degraded = true;
        health.unparsed.push(
          unparsedLine(
            String(member?.ref ?? "unknown"),
            "src/types",
            String(member?.code ?? "unresolved-symbol"),
            String(member?.message ?? "member could not be resolved"),
          ),
        );
      }

      continue;
    }

    const entry = member.entry;
    const isAlias = entry.kind === "type" && Array.isArray(entry.unionMembers);

    if (!isAlias) {
      state.entries.push(entry);
      continue;
    }

    const key = `${entry.file}:${entry.line}:${entry.qualifiedName ?? entry.name}`;

    if (state.visited.has(key)) {
      health.degraded = true;
      health.unparsed.push(
        unparsedLine(entry.name, entry.file, "union-cycle", `union alias ${entry.name} is cyclic`),
      );
      continue;
    }

    state.visited.add(key);

    const nested = index.resolveUnion(entry.name, entry.file);

    if (!nested.ok) {
      health.degraded = true;
      health.unparsed.push(unparsedLine(entry.name, entry.file, nested.code, nested.message));
      continue;
    }

    walkUnion(index, nested.members, state, health, depth + 1);
  }
}

/**
 * Resolve a union and recursively expand its aliases.
 *
 * Pure with respect to the injected index: the contract gate can pass a
 * string-backed stub to test expansion, cycles and ambiguity without creating an
 * engine tree.
 *
 * @param {{resolveUnion: (name: string, fromFile: string) => object}} index type index
 * @param {string} unionName
 * @param {string} fromFile engine-root relative posix path of the union declaration
 * @param {{degraded: boolean, coarse: string[], unparsed: string[]}} [health] shared accumulator
 * @returns {{
 *   ok: boolean,
 *   union: {name: string, file: string, line: number} | null,
 *   unionMembers: number,
 *   entries: object[],
 *   unresolved: object[],
 *   health: {degraded: boolean, coarse: string[], unparsed: string[]},
 * }}
 */
export function expandUnionEntries(index, unionName, fromFile, health = createHealth()) {
  const resolved = index.resolveUnion(unionName, fromFile);

  if (!resolved.ok) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        unionName,
        fromFile,
        String(resolved.code ?? FAILURE_CODES.UNION_NOT_FOUND),
        String(resolved.message ?? "union could not be resolved"),
      ),
    );

    return {
      ok: false,
      union: null,
      unionMembers: 0,
      entries: [],
      unresolved: [],
      health,
    };
  }

  const state = { entries: [], unresolved: [], visited: new Set() };
  walkUnion(index, resolved.members, state, health, 0);

  return {
    ok: true,
    union: {
      name: resolved.name ?? unionName,
      file: resolved.fromFile ?? fromFile,
      line: typeof resolved.line === "number" ? resolved.line : 0,
    },
    unionMembers: resolved.members.length,
    entries: state.entries,
    unresolved: state.unresolved,
    health,
  };
}

/**
 * Collect the declaration homes that appear in the message union. A command
 * interface with the same home is bidirectional.
 *
 * Failures are recorded on the shared health accumulator: a missing message
 * union means the `s2c` half of `file_ops` cannot be derived, which is a real
 * degradation even though `extract-messages.mjs` owns the message records.
 *
 * @param {{resolveUnion: (name: string, fromFile: string) => object}} index
 * @param {{degraded: boolean, coarse: string[], unparsed: string[]}} health
 * @param {string} fromFile file the command union was resolved from
 * @returns {Set<string>} homes (`<file>:<line>`) present in `WsProtocolMessage`
 */
function resolveBidirectionalHomes(index, health, fromFile) {
  const homes = new Set();
  const resolved = index.resolveUnion(MESSAGE_UNION, fromFile);

  if (!resolved.ok) {
    health.degraded = true;
    health.unparsed.push(
      unparsedLine(
        MESSAGE_UNION,
        fromFile,
        String(resolved.code ?? FAILURE_CODES.UNION_NOT_FOUND),
        String(resolved.message ?? "message union could not be resolved"),
      ),
    );

    return homes;
  }

  const state = { entries: [], unresolved: [], visited: new Set() };
  // Reporting individual message members belongs to `extract-messages.mjs`; only the
  // union itself matters here, so the scratch accumulator is intentionally dropped.
  walkUnion(index, resolved.members, state, createHealth(), 0);

  for (const entry of state.entries) {
    homes.add(`${entry.file}:${entry.line}`);
  }

  return homes;
}

/**
 * Extract every wire command from the pinned engine source.
 *
 * `index` is optional so `snapshot.mjs` can reuse one index for commands,
 * messages and parity instead of parsing `src/types` three times. `unionName` /
 * `fromFile` are overridable so the contract gate can drive the whole pipeline
 * from a string-backed
 * stub (its fixture tree has no real protocol file).
 *
 * @param {{
 *   engineRoot?: string,
 *   index?: {resolveUnion: (name: string, fromFile: string) => object} | null,
 *   unionName?: string,
 *   fromFile?: string,
 * }} [options]
 * @returns {{
 *   commands: CommandRecord[],
 *   counts: {unionMembers: number, wireCommands: number},
 *   union: {name: string, file: string, line: number} | null,
 *   health: {degraded: boolean, coarse: string[], unparsed: string[]},
 * }}
 */
export function extractCommands({
  engineRoot,
  index = null,
  unionName = COMMAND_UNION,
  fromFile = COMMAND_UNION_FILE,
} = {}) {
  if (!index && typeof engineRoot !== "string") {
    throw new TypeError("extractCommands: engineRoot is required when no index is provided");
  }

  const typeIndex = index ?? createTypeIndex(/** @type {string} */ (engineRoot));
  const health = createHealth();
  const expansion = expandUnionEntries(typeIndex, unionName, fromFile, health);

  if (!expansion.ok) {
    return {
      commands: [],
      counts: { unionMembers: 0, wireCommands: 0 },
      union: null,
      health,
    };
  }

  const bidirectionalHomes = resolveBidirectionalHomes(typeIndex, health, fromFile);
  /** @type {CommandRecord[]} */
  const commands = [];

  for (const entry of expansion.entries) {
    const home = `${entry.file}:${entry.line}`;
    const directions = bidirectionalHomes.has(home) ? [C2S, S2C] : [C2S];
    const record = buildCommandRecord(entry, directions);

    if (record.health === "coarse") {
      health.coarse.push(coarseLine(record.type, home, "type literal is missing"));
    }

    // A base class that could not be merged hides fields. The scan index already
    // recorded the reason; repeating it here puts the line on the record that is
    // actually in the snapshot, and stays silent for declarations the contract
    // never emits.
    for (const problem of Array.isArray(entry.heritageProblems) ? entry.heritageProblems : []) {
      health.coarse.push(problem);
    }

    commands.push(record);
  }

  for (const member of expansion.unresolved) {
    const record = buildUnresolvedCommandRecord(member);

    health.coarse.push(
      coarseLine(
        record.type,
        record.home,
        `${String(member.code ?? FAILURE_CODES.AMBIGUOUS_SYMBOL)}: ${String(
          member.message ?? "member resolved ambiguously",
        )}`,
      ),
    );
    commands.push(record);
  }

  commands.sort(compareCommandRecords);
  health.coarse.sort(compareStrings);
  health.unparsed.sort(compareStrings);

  return {
    commands,
    // A coarse record keeps `wire: null` and stays in `commands[]` so the
    // validator rejects it; it is not a wire command and must not be counted as
    // one (07 section 6.6).
    counts: {
      unionMembers: expansion.unionMembers,
      wireCommands: commands.filter((record) => record.wire !== null).length,
    },
    union: expansion.union,
    health,
  };
}
