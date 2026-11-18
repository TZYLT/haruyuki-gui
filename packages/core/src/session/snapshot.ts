/**
 * The session store's published state: one immutable snapshot per revision,
 * built by replacing only the maps a change touched.
 *
 * A renderer reads this value through `useSyncExternalStore`-style wiring, and
 * two properties follow from that binding:
 *
 * - The same revision has to hand back the same object. A fresh object per read
 *   tells the subscriber the state changed, and it re-renders on every read.
 * - A change has to replace only the maps it touched. Rebuilding all nine maps
 *   per change costs the whole session - every turn, every block - for a change
 *   that usually involves one map. Untouched maps keep their identity, which is
 *   also what lets a selector decide "did my value change?" by comparing
 *   references instead of deep-comparing.
 *
 * Immutability needs both halves, because the two fail differently:
 *
 * - The snapshot object is frozen, so `snapshot.revision = 5` throws from module
 *   code and does nothing in sloppy mode.
 * - Every map is a {@link FrozenMap} whose mutators throw. `Object.freeze` alone
 *   does not protect a `Map`: its entries live in internal slots rather than
 *   properties, so a frozen map still accepts `.set()`. `ReadonlyMap` is only a
 *   compile-time spelling and gives no runtime guarantee.
 *
 * The cost of the map guard is a prototype-level check, not a capability: a
 * caller that reaches for `Map.prototype.set.call(map, ...)` still gets through,
 * and the guard is there to stop accidents, not a hostile module. Handing in a
 * plain map copies it once (shallow - the entity values are not cloned), so the
 * caller cannot keep writing through its own reference; build maps with
 * {@link freezeMap} to skip that copy.
 */

import type {
  AgentEntity,
  ApprovalEntity,
  BlockEntity,
  ConversationEntity,
  DeviceEntity,
  QueueEntity,
  SessionSnapshot,
  SubagentEntity,
  TurnEntity,
  UsageEntity,
} from "@haruyuki/protocol";

/** Every map the snapshot carries, in contract order. */
export const SNAPSHOT_MAP_FIELDS = [
  "agents",
  "conversations",
  "turns",
  "blocks",
  "queues",
  "subagents",
  "usage",
  "approvals",
  "devices",
] as const;

/** One of the nine entity maps, as a key of {@link SessionSnapshot}. */
export type SnapshotMapField = (typeof SNAPSHOT_MAP_FIELDS)[number];

/**
 * A change to publish: any subset of the snapshot.
 *
 * `revision` is absent because the builder owns it. A caller that could choose
 * the revision could rewind it, and every subscriber would then drop an update
 * it has already seen.
 */
export type SnapshotPatch = Partial<Omit<SessionSnapshot, "revision">>;

/** Builds snapshots for one store; owns the revision counter. */
export interface SnapshotBuilder {
  /** Revision of the snapshot currently published. */
  readonly revision: number;
  /** The current snapshot. The same object until something changes. */
  get(): SessionSnapshot;
  /**
   * Publish a change: listed fields replace their old value, the rest keep
   * their reference. Advances the revision when something visible changed.
   *
   * @param patch the fields that changed
   * @returns the new snapshot, which is the current one from now on
   */
  next(patch: SnapshotPatch): SessionSnapshot;
}

/** Message every refused write reports, so the stack trace reads as intent. */
const MUTATION_MESSAGE = "a session snapshot is immutable; publish a change through next()";

/**
 * A `Map` that refuses to be written after construction.
 *
 * A subclass rather than a wrapper object: the snapshot's fields are typed
 * `ReadonlyMap`, and consumers that iterate or look up keep working unchanged,
 * including `instanceof Map`. Construction is the only write path, which is why
 * the mutators throw instead of returning the map for chaining.
 */
class FrozenMap<K, V> extends Map<K, V> {
  /**
   * @param source entries to copy; empty when omitted
   */
  constructor(source?: ReadonlyMap<K, V>) {
    super();

    // Filled through the base `set`, not through this class's: `Map`'s own
    // constructor and this override both dispatch to `set`, so filling from the
    // constructor with `new Map(entries)` would throw while constructing.
    if (source !== undefined) {
      for (const [key, value] of source) {
        Map.prototype.set.call(this, key, value);
      }
    }

    // Freezing the instance keeps a caller from parking an own property on it.
    // It does not guard the entries - the overridden mutators below do.
    Object.freeze(this);
  }

  override set(): this {
    throw new TypeError(MUTATION_MESSAGE);
  }

  override delete(): boolean {
    throw new TypeError(MUTATION_MESSAGE);
  }

  override clear(): void {
    throw new TypeError(MUTATION_MESSAGE);
  }
}

/**
 * Take ownership of a map for a snapshot.
 *
 * The returned map cannot be written to afterwards, so the caller cannot change
 * state that has already been published. A map that is already frozen is
 * returned as is - the reuse path costs nothing, which is what keeps publishing
 * a change linear in the map that changed rather than in the whole session.
 *
 * @param source the entries; read, never retained
 * @returns a frozen map with the same entries
 */
export function freezeMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return ownMap(source);
}

/**
 * @param source the entries to take ownership of
 * @returns the frozen map, without a copy when it already is one
 */
function ownMap<K, V>(source: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return source instanceof FrozenMap ? source : new FrozenMap(source);
}

/**
 * The snapshot a store starts from: nothing known yet.
 *
 * Every map is present and empty, so a selector can ask "is it there?" without
 * distinguishing "no snapshot" from "no rows", and a reader never has to guard
 * against a missing field.
 *
 * @returns a frozen snapshot with nine empty maps, revision 0, epoch 0
 */
export function createEmptySnapshot(): SessionSnapshot {
  return Object.freeze({
    revision: 0,
    epoch: 0,
    agents: new FrozenMap<string, AgentEntity>(),
    conversations: new FrozenMap<string, ConversationEntity>(),
    turns: new FrozenMap<string, TurnEntity>(),
    blocks: new FrozenMap<string, BlockEntity>(),
    queues: new FrozenMap<string, QueueEntity>(),
    subagents: new FrozenMap<string, readonly SubagentEntity[]>(),
    usage: new FrozenMap<string, UsageEntity>(),
    approvals: new FrozenMap<string, readonly ApprovalEntity[]>(),
    devices: new FrozenMap<string, DeviceEntity>(),
  });
}

/**
 * Combine the current snapshot with a patch.
 *
 * @param current the snapshot being replaced
 * @param patch the fields that changed
 * @param revision the revision the result is published under
 * @returns a frozen snapshot; untouched fields are the current references
 */
function merge(current: SessionSnapshot, patch: SnapshotPatch, revision: number): SessionSnapshot {
  return Object.freeze({
    revision,
    epoch: patch.epoch ?? current.epoch,
    agents: patch.agents === undefined ? current.agents : ownMap(patch.agents),
    conversations:
      patch.conversations === undefined ? current.conversations : ownMap(patch.conversations),
    turns: patch.turns === undefined ? current.turns : ownMap(patch.turns),
    blocks: patch.blocks === undefined ? current.blocks : ownMap(patch.blocks),
    queues: patch.queues === undefined ? current.queues : ownMap(patch.queues),
    subagents: patch.subagents === undefined ? current.subagents : ownMap(patch.subagents),
    usage: patch.usage === undefined ? current.usage : ownMap(patch.usage),
    approvals: patch.approvals === undefined ? current.approvals : ownMap(patch.approvals),
    devices: patch.devices === undefined ? current.devices : ownMap(patch.devices),
  });
}

/**
 * Whether two snapshots publish the same fields.
 *
 * The revision is ignored on purpose: this answers "is there anything new to
 * show?", which is the question that decides whether the revision moves at all.
 *
 * @param left one snapshot
 * @param right another
 * @returns true when every field is the same reference or the same primitive
 */
function showsSameState(left: SessionSnapshot, right: SessionSnapshot): boolean {
  if (left.epoch !== right.epoch) {
    return false;
  }

  for (const field of SNAPSHOT_MAP_FIELDS) {
    if (left[field] !== right[field]) {
      return false;
    }
  }

  return true;
}

/**
 * Start building snapshots from a given one.
 *
 * The value handed in is taken over: its maps become frozen if they were not
 * already, so the store cannot publish state that a holder of the initial
 * object can still change.
 *
 * @param initial the snapshot to start from; an empty one when omitted
 * @returns a builder whose `get()` returns one object until a change lands
 */
export function createSnapshotBuilder(
  initial: SessionSnapshot = createEmptySnapshot(),
): SnapshotBuilder {
  // Frozen once here, so `next` only ever sees frozen maps and can reuse them
  // without a copy. The revision comes from the value handed in, not from zero:
  // a store rebuilt on a subscription keeps the revision its readers last saw.
  let current = merge(createEmptySnapshot(), initial, initial.revision);

  return {
    get revision(): number {
      return current.revision;
    },

    get(): SessionSnapshot {
      return current;
    },

    next(patch: SnapshotPatch): SessionSnapshot {
      const candidate = merge(current, patch, current.revision + 1);

      // Publishing an identical state would move the revision and wake every
      // subscriber for nothing. A patch that names only the references already
      // in place is therefore not a change - the store can hand in whatever it
      // rebuilt without checking first.
      if (showsSameState(current, candidate)) {
        return current;
      }

      current = candidate;

      return current;
    },
  };
}
