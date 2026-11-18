/**
 * The snapshot has to be one stable, unwritable object per revision, and a
 * change has to replace only what it touched.
 *
 * Two failure modes are easy to ship and hard to notice, so each gets an
 * assertion that says which one it is:
 *
 * - a new object per read. The subscriber cannot tell "nothing changed" from
 *   "everything changed", so it re-renders on every read.
 * - a rebuilt snapshot per change. Every map is replaced, every selector sees a
 *   new reference, and the cost of one agent's rename is the whole session.
 *
 * The reference comparisons below are `toBe`, never `toEqual`: deep equality
 * passes for both failures, which is exactly why they are not enough here.
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
import { describe, expect, it } from "vitest";

import {
  createEmptySnapshot,
  createSnapshotBuilder,
  freezeMap,
  SNAPSHOT_MAP_FIELDS,
} from "./snapshot.js";

/** One agent, as the fold would produce it. */
function agent(agentId: string): AgentEntity {
  return {
    agentId,
    name: agentId,
    description: null,
    capabilities: {},
    conversations: [],
  };
}

/** One conversation belonging to `agentId`. */
function conversation(conversationId: string, agentId: string): ConversationEntity {
  return {
    conversationId,
    agentId,
    row: {},
    lastActivityAt: null,
    turns: [],
    context: null,
    incompleteTurnRefs: [],
  };
}

/**
 * A snapshot with one row in every map.
 *
 * Nine maps with a row each makes "which reference moved?" answerable for every
 * field, not just the field the test touches.
 *
 * @returns a frozen snapshot with content, revision 1 and epoch 7
 */
function populated(): SessionSnapshot {
  const turn: TurnEntity = {
    turnRef: "turn-a",
    turnId: null,
    runId: null,
    conversationId: "conv-a",
    stopReason: null,
    open: true,
    blocks: [],
    usage: null,
    incomplete: false,
    startedAt: 1,
    finishedAt: null,
  };
  const block: BlockEntity = {
    blockId: "block-a",
    turnRef: "turn-a",
    messageId: null,
    runId: null,
    block: {},
  };
  const queue: QueueEntity = { conversationId: "conv-a", items: [], count: 0 };
  const subagent: SubagentEntity = {
    subagentId: "sub-a",
    parentAgentId: "agent-a",
    conversationId: "conv-a",
    status: "running",
    totalTokens: 0,
    durationMs: 0,
    error: null,
  };
  const usage: UsageEntity = { conversationId: "conv-a", latest: {}, history: [] };
  const approval: ApprovalEntity = {
    requestId: "req-a",
    agentId: "agent-a",
    conversationId: "conv-a",
    toolName: "bash",
    input: {},
    state: "pending",
    requestedAt: 1,
  };
  const device: DeviceEntity = {
    agentId: "agent-a",
    view: {
      isOnline: true,
      isProcessing: false,
      permissionMode: null,
      cwd: null,
      toolsetPreference: null,
      pendingApprovals: 0,
      backgroundProcesses: 0,
      loop: null,
    },
  };

  return Object.freeze({
    revision: 1,
    epoch: 7,
    agents: freezeMap(new Map([["agent-a", agent("agent-a")]])),
    conversations: freezeMap(new Map([["conv-a", conversation("conv-a", "agent-a")]])),
    turns: freezeMap(new Map([["turn-a", turn]])),
    blocks: freezeMap(new Map([["block-a", block]])),
    queues: freezeMap(new Map([["conv-a", queue]])),
    subagents: freezeMap(new Map([["conv-a", [subagent]]])),
    usage: freezeMap(new Map([["conv-a", usage]])),
    approvals: freezeMap(new Map([["agent-a", [approval]]])),
    devices: freezeMap(new Map([["agent-a", device]])),
  });
}

/** A snapshot object seen as writable, for the "can it be written?" probe. */
function writable(snapshot: SessionSnapshot): Record<string, unknown> {
  return snapshot as unknown as Record<string, unknown>;
}

describe("createEmptySnapshot", () => {
  it("carries every map, empty, so no reader has to guard for a missing field", () => {
    const snapshot = createEmptySnapshot();

    for (const field of SNAPSHOT_MAP_FIELDS) {
      const map = snapshot[field];

      expect(map).toBeInstanceOf(Map);
      expect(map.size).toBe(0);
    }

    expect(snapshot.revision).toBe(0);
    expect(snapshot.epoch).toBe(0);
  });

  it("starts empty rather than absent, and frozen", () => {
    const snapshot = createEmptySnapshot();

    // Every map is a distinct object: one shared empty map would leak a write
    // from one field into the other eight.
    expect(new Set(SNAPSHOT_MAP_FIELDS.map((field) => snapshot[field])).size).toBe(
      SNAPSHOT_MAP_FIELDS.length,
    );
    expect(Object.isFrozen(snapshot)).toBe(true);

    for (const field of SNAPSHOT_MAP_FIELDS) {
      expect(() => (snapshot[field] as Map<string, unknown>).set("x", null)).toThrow();
    }
  });
});

describe("a snapshot is immutable at runtime, not only in the type", () => {
  it("refuses a write to its own fields", () => {
    const snapshot = createEmptySnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    // The whole point of the freeze: ESM is strict, so the write throws instead
    // of quietly doing nothing that the next read would then not show.
    expect(() => {
      writable(snapshot).revision = 99;
    }).toThrow();
    expect(() => {
      writable(snapshot).agents = new Map();
    }).toThrow();
    expect(snapshot.revision).toBe(0);
    expect(snapshot.agents.size).toBe(0);
  });

  it("refuses a write to a map's entries", () => {
    // `Object.freeze` does not guard a Map's entries: the entries live in
    // internal slots, so a frozen map still accepts `set`. This is the check
    // that keeps the guard honest, and it fails if the guard is dropped in
    // favour of freezing alone.
    const snapshot = populated();
    const agents = snapshot.agents as Map<string, AgentEntity>;

    expect(() => agents.set("agent-b", agent("agent-b"))).toThrow(TypeError);
    expect(() => agents.delete("agent-a")).toThrow(TypeError);
    expect(() => agents.clear()).toThrow(TypeError);
    expect(agents.size).toBe(1);
    expect(snapshot.agents.get("agent-a")?.agentId).toBe("agent-a");
  });

  it("still reads as a Map, so consumers iterate it unchanged", () => {
    // A wrapper object would be immutable too, but every consumer would have to
    // be rewritten. Being a Map is part of the contract being preserved here.
    const snapshot = populated();

    expect(snapshot.agents).toBeInstanceOf(Map);
    expect([...snapshot.agents.keys()]).toEqual(["agent-a"]);
    expect(snapshot.agents.get("agent-a")?.name).toBe("agent-a");
  });
});

describe("one reference per revision", () => {
  it("hands back the same object twice", () => {
    const builder = createSnapshotBuilder(populated());
    const first = builder.get();
    const second = builder.get();

    // `toEqual` would pass for a fresh copy per read, which is the failure this
    // suite exists to catch.
    expect(first).toBe(second);
    expect(first.revision).toBe(second.revision);
  });

  it("keeps returning one object after a change, until the next one", () => {
    const builder = createSnapshotBuilder(populated());
    const before = builder.get();
    const after = builder.next({ agents: new Map([["agent-b", agent("agent-b")]]) });

    expect(after).not.toBe(before);
    expect(builder.get()).toBe(after);
    expect(builder.get()).toBe(builder.get());
  });

  it("does not move the revision when it is only read", () => {
    const builder = createSnapshotBuilder(populated());
    const revision = builder.revision;

    builder.get();
    builder.get();

    expect(builder.revision).toBe(revision);
    expect(builder.get().revision).toBe(revision);
  });

  it("reads unchanged after an outside attempt to write", () => {
    const builder = createSnapshotBuilder(populated());
    const snapshot = builder.get();

    expect(() => {
      writable(snapshot).epoch = 8;
    }).toThrow();
    expect(() =>
      (snapshot.agents as Map<string, AgentEntity>).set("agent-z", agent("agent-z")),
    ).toThrow();

    // Read through the builder, not only through the captured object: a failed
    // write must leave what the store publishes untouched as well.
    expect(builder.get().epoch).toBe(7);
    expect(builder.get().agents.size).toBe(1);
    expect(builder.get().agents.has("agent-z")).toBe(false);
  });
});

describe("structural sharing", () => {
  it("keeps the untouched maps, and replaces the touched one", () => {
    const builder = createSnapshotBuilder(populated());
    const before = builder.get();
    const replacement = freezeMap(new Map([["agent-b", agent("agent-b")]]));

    const after = builder.next({ agents: replacement });

    // The map that changed is the new one...
    expect(after.agents).toBe(replacement);
    expect(after.agents).not.toBe(before.agents);
    // ...and the other eight are still the objects the previous snapshot had.
    // Rebuilding them per change is the failure this assertion is here for.
    for (const field of SNAPSHOT_MAP_FIELDS) {
      if (field === "agents") {
        continue;
      }

      expect(after[field]).toBe(before[field]);
    }
  });

  it("keeps the other fields through a second, different change", () => {
    const builder = createSnapshotBuilder(populated());
    const before = builder.next({ agents: new Map([["agent-b", agent("agent-b")]]) });
    const conversations = new Map([["conv-b", conversation("conv-b", "agent-b")]]);

    const after = builder.next({ conversations });

    expect(after.conversations).not.toBe(before.conversations);
    expect(after.agents).toBe(before.agents);

    for (const field of SNAPSHOT_MAP_FIELDS) {
      if (field === "conversations") {
        continue;
      }

      expect(after[field]).toBe(before[field]);
    }
  });

  it("leaves a map alone when the patch does not name it", () => {
    const builder = createSnapshotBuilder(populated());
    const before = builder.get();
    const after = builder.next({ epoch: 8 });

    expect(after.epoch).toBe(8);
    expect(after.epoch).not.toBe(before.epoch);

    for (const field of SNAPSHOT_MAP_FIELDS) {
      expect(after[field]).toBe(before[field]);
    }
  });

  it("takes ownership of a map handed in, so the caller cannot edit it later", () => {
    // The caller keeps a reference to the map it passed in. If the snapshot held
    // that reference, the caller's next `set` would edit published state without
    // a revision change - the copy is the price of not being able to.
    const builder = createSnapshotBuilder(createEmptySnapshot());
    const handedIn = new Map([["agent-a", agent("agent-a")]]);

    builder.next({ agents: handedIn });
    handedIn.set("agent-b", agent("agent-b"));

    expect(builder.get().agents.size).toBe(1);
    expect(builder.get().agents.has("agent-b")).toBe(false);
    expect(builder.get().agents).not.toBe(handedIn);
  });

  it("publishes the same object when the patch changes nothing", () => {
    const builder = createSnapshotBuilder(populated());
    const before = builder.get();

    // A store that rebuilds a map identically should not wake every subscriber
    // for it: an identical reference is not a change.
    const unchanged = builder.next({ agents: before.agents });

    expect(unchanged).toBe(before);
    expect(builder.get()).toBe(before);
    expect(builder.revision).toBe(before.revision);
  });
});

describe("revision moves forward by one per published change", () => {
  it("advances from the initial revision, never from zero", () => {
    const builder = createSnapshotBuilder(populated());

    // The store is rebuilt around a snapshot its readers already saw; starting
    // the counter over would look like a rewind to them.
    expect(builder.revision).toBe(1);

    const first = builder.next({ epoch: 8 });
    const second = builder.next({ epoch: 9 });

    expect(first.revision).toBe(2);
    expect(second.revision).toBe(3);
    expect(builder.revision).toBe(3);
  });

  it("keeps the revision of the snapshot it was rebuilt around", () => {
    const builder = createSnapshotBuilder({ ...createEmptySnapshot(), revision: 7 });

    // Zero would be a rewind to a reader that has already seen seven revisions,
    // and every subscriber caching by revision would drop the first update as
    // stale. Pinned here because the reuse path is easy to lose without any
    // other assertion noticing.
    expect(builder.revision).toBe(7);
    expect(builder.get().revision).toBe(7);
  });

  it("never goes backwards, and every published revision is a new object", () => {
    const builder = createSnapshotBuilder(createEmptySnapshot());
    const seen: SessionSnapshot[] = [builder.get()];
    const revisions: number[] = [builder.get().revision];

    for (let index = 1; index <= 5; index += 1) {
      seen.push(builder.next({ epoch: index }));
      revisions.push(builder.revision);
    }

    const sorted = [...revisions].sort((left, right) => left - right);

    expect(revisions).toEqual(sorted);
    // One revision per published object: a repeat would mean two different
    // states answering to the same revision, and a subscriber caching by
    // revision would then drop one of them.
    expect(revisions).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("starts an empty builder at revision zero", () => {
    const builder = createSnapshotBuilder();

    expect(builder.revision).toBe(0);
    expect(builder.get().revision).toBe(0);
    expect(builder.get().agents.size).toBe(0);
  });
});
