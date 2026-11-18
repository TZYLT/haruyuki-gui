/**
 * The entity selectors: the read side of the session snapshot.
 *
 * A selector answers one question about the snapshot - "the agents", "this agent",
 * "this conversation's turns" - and answers it by reading only. Nothing here
 * caches, writes, sorts or composes: order is the snapshot's order (the engine's),
 * and the one ordering rule that exists belongs to the navigation view that owns
 * it. Running a selector twice is therefore free of side effects, and the second
 * answer is the same value as the first because the snapshot was not touched.
 *
 * Three answers come out of this module, and the difference between them is the
 * point of it:
 *
 * - **a value** - the shape the contract's return column names, carrying the
 *   entity or the list the caller asked for;
 * - **`null`, or an empty list** - the snapshot is complete and simply does not
 *   hold this row. "No such agent" is an ordinary answer, not a failure: the
 *   contract spells it `AgentEntity | null`, and a page draws its empty state.
 *   A caller that mistyped an id gets this, never a code;
 * - **a code** - the selector name is not in the contract, the parameters do not
 *   match the shape it declares, or there is nothing to read yet. That is a
 *   caller bug or a not-yet state, and it is never the way "this row is missing"
 *   is reported.
 *
 * ## When a code says "currently no value"
 *
 * A selector may only answer with the shapes its contract row allows. Where that
 * row has no way to spell absence, a missing value cannot be reported honestly,
 * and the selector says so instead of inventing one: `entity.queue` returns
 * `QueueEntity` with no `null` in it, so a conversation whose queue has not
 * arrived gets the "no value yet" code rather than an empty queue that would
 * claim the engine said "nothing is waiting". Two situations produce it:
 *
 * 1. there is no snapshot at all - the store has not been assembled, the engine
 *    is not connected yet, so no selector can read anything;
 * 2. a selector whose declared return type has no absence spelling is asked for
 *    a row the snapshot does not hold.
 *
 * Every other selector keeps the ordinary answer, because its row can say "none"
 * without ambiguity: a list row an empty list, a nullable row `null`.
 *
 * ## Nothing throws
 *
 * The caller is a page handler on a socket callback, so a selector result is the
 * only channel for a complaint. An unknown name, a parameter of the wrong type
 * and an unreadable snapshot all come back as codes from the same table.
 */

import {
  SESSION_BAD_PARAMS,
  SESSION_UNAVAILABLE,
  SESSION_UNKNOWN_SELECTOR,
  type SessionSelectCode,
  type SessionSnapshot,
} from "@haruyuki/protocol";

/**
 * What running one selector produced.
 *
 * A discriminated pair rather than a thrown error or a nullable value: the three
 * failure codes are a closed set the page already maps to its own wording, and a
 * page that has to guard a throw cannot tell a bug from a not-yet state.
 */
export type SelectorOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: SessionSelectCode };

/** Where a selector reads from. */
export type EntitySelectorDeps = {
  /**
   * The snapshot to read, or `null` while the store holds none.
   *
   * The store contract hands back a snapshot at all times once it exists, so
   * `null` here means "no store yet" - the engine is not connected - and it is
   * the one condition under which every selector reports "no value yet".
   */
  readonly snapshot: () => SessionSnapshot | null;
};

/** The selectors one session store exposes, keyed by the contract's names. */
export interface EntitySelectors {
  /** Every selector name this module implements, in contract order. */
  readonly names: readonly string[];
  /** Whether `selector` is one of them. Unknown names are a caller bug, not a throw. */
  has(selector: string): boolean;
  /**
   * Run one selector by name.
   *
   * @param selector the contract's name
   * @param params the keys the contract's parameter column names
   * @returns the value in the contract's return shape, or the code explaining why not
   */
  run(selector: string, params: Readonly<Record<string, unknown>>): SelectorOutcome;
}

/** One row of the selector contract: its name, its parameters, how it reads. */
type EntityRow = {
  /** The name a renderer asks for. */
  readonly selector: string;
  /**
   * The parameter keys the contract names, in order.
   *
   * Also the validator: a request missing one of these, or carrying one as
   * something other than a non-empty string, is the wrong shape and is refused
   * before any state is touched. Extra keys are ignored, because a caller
   * carrying a wider parameter set through one dispatch is not a bug.
   */
  readonly params: readonly string[];
  readonly read: (
    snapshot: SessionSnapshot,
    ids: Readonly<Record<string, string>>,
  ) => SelectorOutcome;
};

/** An empty list shared by every "the snapshot holds none" answer. */
const NOTHING: readonly never[] = Object.freeze([]);

/** @returns a successful outcome carrying `entity`. */
function value<T>(entity: T): SelectorOutcome {
  return { ok: true, value: entity };
}

/** @returns a failed outcome carrying `code`. */
function failure(code: SessionSelectCode): SelectorOutcome {
  return { ok: false, code };
}

/** A plain record; `null` and arrays are not one. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the ids one row declares out of a request's parameters.
 *
 * @param params the request's parameters, already known to be a record
 * @param keys the row's declared parameter names
 * @returns the ids by key, or `null` when one is absent or not a usable id
 */
function idsOf(
  params: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, string>> | null {
  const ids: Record<string, string> = {};

  for (const key of keys) {
    const id = params[key];

    if (typeof id !== "string" || id === "") {
      return null;
    }

    ids[key] = id;
  }

  return Object.freeze(ids);
}

/**
 * One declared id, as a lookup key.
 *
 * Validation already refused an absent one, so the empty fallback only keeps a
 * hand-built row from throwing: a miss is an ordinary "no such row".
 */
function idOf(ids: Readonly<Record<string, string>>, key: string): string {
  return ids[key] ?? "";
}

/** Every entity of one map, in the map's order. */
function allOf<V>(map: ReadonlyMap<string, V>): SelectorOutcome {
  return value(Object.freeze([...map.values()]));
}

/** One entity by key, or `null` - the answer the contract spells this way. */
function oneOf<V>(map: ReadonlyMap<string, V>, key: string): SelectorOutcome {
  return value(map.get(key) ?? null);
}

/**
 * One entity the contract declares non-nullable, or the "no value" code.
 *
 * This is the only reader here that refuses instead of answering, and it looks
 * like a bug until the contract row is read again: the queue's return column has
 * no `| null` in it, so the one shape the contract allows is a queue. An empty
 * queue - `{ items: [], count: 0 }` - would therefore be a claim, and the wrong
 * one: it says the engine reported that nothing is waiting, while the truth is
 * that no queue frame has arrived for this conversation yet. Those two readings
 * drive different screens ("nothing is queued" and "not known yet"), and only
 * the second one is honest before a frame. So the absence leaves as a code the
 * page already knows how to draw an empty state from.
 *
 * Every other row can say "none" without inventing anything - a list row an
 * empty list, a nullable row `null` - which is why this stays the one exception.
 */
function requiredOf<V>(map: ReadonlyMap<string, V>, key: string): SelectorOutcome {
  const entity = map.get(key) ?? null;

  return entity === null ? failure(SESSION_UNAVAILABLE) : value(entity);
}

/**
 * The rows of one map whose field names `key`.
 *
 * Used for the four relations that are not map keys of their own: a turn knows
 * its conversation, a block knows its turn, and the snapshot keys those tables by
 * their own ids. The order stays the map's order.
 */
function matchingOf<V>(map: ReadonlyMap<string, V>, matches: (row: V) => boolean): SelectorOutcome {
  const rows: V[] = [];

  for (const row of map.values()) {
    if (matches(row)) {
      rows.push(row);
    }
  }

  return value(Object.freeze(rows));
}

/** One conversation's list from a map of lists, or an empty list. */
function listOf<V>(map: ReadonlyMap<string, readonly V[]>, key: string): SelectorOutcome {
  // The stored list is already frozen, so the same reference comes back: a
  // subscriber comparing references sees "unchanged" rather than a new array.
  return value(map.get(key) ?? NOTHING);
}

/**
 * The contract's eleven entity rows, in the order the table lists them.
 *
 * Each row is the whole implementation of one selector: the parameters it
 * declares are the parameters it validates, and its reader is one lookup or one
 * filter over the snapshot.
 */
const ROWS: readonly EntityRow[] = [
  {
    selector: "entity.agents",
    params: [],
    read: (snapshot) => allOf(snapshot.agents),
  },
  {
    selector: "entity.agent",
    params: ["agentId"],
    read: (snapshot, ids) => oneOf(snapshot.agents, idOf(ids, "agentId")),
  },
  {
    selector: "entity.conversations",
    params: ["agentId"],
    read: (snapshot, ids) =>
      matchingOf(snapshot.conversations, (row) => row.agentId === idOf(ids, "agentId")),
  },
  {
    selector: "entity.conversation",
    params: ["conversationId"],
    read: (snapshot, ids) => oneOf(snapshot.conversations, idOf(ids, "conversationId")),
  },
  {
    selector: "entity.turns",
    params: ["conversationId"],
    read: (snapshot, ids) =>
      matchingOf(snapshot.turns, (row) => row.conversationId === idOf(ids, "conversationId")),
  },
  {
    selector: "entity.blocks",
    params: ["turnRef"],
    read: (snapshot, ids) =>
      matchingOf(snapshot.blocks, (row) => row.turnRef === idOf(ids, "turnRef")),
  },
  {
    selector: "entity.queue",
    params: ["conversationId"],
    read: (snapshot, ids) => requiredOf(snapshot.queues, idOf(ids, "conversationId")),
  },
  {
    selector: "entity.subagents",
    params: ["conversationId"],
    read: (snapshot, ids) => listOf(snapshot.subagents, idOf(ids, "conversationId")),
  },
  {
    selector: "entity.usage",
    params: ["conversationId"],
    read: (snapshot, ids) => oneOf(snapshot.usage, idOf(ids, "conversationId")),
  },
  {
    selector: "entity.approvals",
    params: ["agentId"],
    read: (snapshot, ids) => listOf(snapshot.approvals, idOf(ids, "agentId")),
  },
  {
    selector: "entity.device",
    params: ["agentId"],
    read: (snapshot, ids) => oneOf(snapshot.devices, idOf(ids, "agentId")),
  },
];

/** The eleven selector names, in contract order, for the assembly layer. */
export const ENTITY_SELECTOR_NAMES: readonly string[] = Object.freeze(
  ROWS.map((row) => row.selector),
);

/**
 * Build the entity selectors over one snapshot source.
 *
 * The source is a function rather than a snapshot so a subscriber always reads
 * the current revision instead of the one that existed when it subscribed; no
 * snapshot is retained here, which is also why this module never has to be told
 * about a new revision.
 *
 * @param deps where to read from
 * @returns the eleven selectors behind one name dispatch
 */
export function createEntitySelectors(deps: EntitySelectorDeps): EntitySelectors {
  return {
    names: ENTITY_SELECTOR_NAMES,

    has(selector) {
      return ROWS.some((row) => row.selector === selector);
    },

    run(selector, params) {
      // Name first, then the request's shape, then the state: a page bug is
      // reported as one even while the engine is still offline, and an offline
      // engine is not reported for a name nobody implements.
      const row = ROWS.find((candidate) => candidate.selector === selector);

      if (row === undefined) {
        return failure(SESSION_UNKNOWN_SELECTOR);
      }

      if (!isRecord(params)) {
        return failure(SESSION_BAD_PARAMS);
      }

      const ids = idsOf(params, row.params);

      if (ids === null) {
        return failure(SESSION_BAD_PARAMS);
      }

      const snapshot = deps.snapshot();

      if (snapshot === null) {
        return failure(SESSION_UNAVAILABLE);
      }

      return row.read(snapshot, ids);
    },
  };
}
