/**
 * The entity selectors, checked against the contract's own table.
 *
 * There are eighteen rows in the selector contract and eleven of them belong to
 * this layer. The table below is a machine-readable copy of those eleven: the
 * name, the parameters the contract declares, the return shape it declares, and
 * how a value of that shape is recognised. That copy is the point of this suite,
 * because a selector table is easy to half-deliver - ten names work, the eleventh
 * quietly returns an empty list - and only a check written from the contract
 * rather than from the code can notice.
 *
 * The rest pins the three answers a caller has to be able to tell apart, since
 * collapsing any two of them loses information:
 *
 * - **an empty list or `null`** - the snapshot is complete and holds no such row.
 *   This is an ordinary answer; a page draws its empty state.
 * - **a code** - the name is not in the contract (a caller bug), the parameters
 *   are the wrong shape (also a caller bug), or nothing can be read yet. These
 *   are refused the same way a name is, without a throw, because the caller is a
 *   page handler on a socket callback.
 * - **a value** - the row, exactly as the snapshot holds it.
 *
 * The mutation that this suite has to catch was run by hand: dropping one row
 * from the implementation turns the contract-completeness case red, and adding
 * the row back turns it green again.
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

import { ENTITY_SELECTOR_NAMES, createEntitySelectors, type SelectorOutcome } from "./entity.js";
import { freezeMap } from "../snapshot.js";

/** A snapshot with one row of every kind, and enough rows to filter meaningfully. */
function populated(): SessionSnapshot {
  const agents: readonly AgentEntity[] = [
    {
      agentId: "agent-a",
      name: "Alpha",
      description: null,
      capabilities: {},
      conversations: ["conv-a"],
    },
    {
      agentId: "agent-b",
      name: "Beta",
      description: "second",
      capabilities: {},
      conversations: ["conv-b"],
    },
  ];

  const conversations: readonly ConversationEntity[] = [
    {
      conversationId: "conv-a",
      agentId: "agent-a",
      row: { hidden: false },
      lastActivityAt: "2026-11-18T10:00:00Z",
      turns: ["turn-a", "turn-open"],
      context: null,
      incompleteTurnRefs: [],
    },
    {
      conversationId: "conv-b",
      agentId: "agent-b",
      row: {},
      lastActivityAt: null,
      turns: [],
      context: null,
      incompleteTurnRefs: [],
    },
  ];

  const turns: readonly TurnEntity[] = [
    {
      turnRef: "turn-a",
      turnId: "turn-id-a",
      runId: "run-1",
      conversationId: "conv-a",
      stopReason: "end_turn",
      open: false,
      blocks: ["block-a"],
      usage: null,
      incomplete: false,
      startedAt: 1,
      finishedAt: 2,
    },
    {
      // The in-flight turn: no id yet, which is why the contract says the list
      // includes it rather than offering a separate "open" selector.
      turnRef: "turn-open",
      turnId: null,
      runId: "run-2",
      conversationId: "conv-a",
      stopReason: null,
      open: true,
      blocks: [],
      usage: null,
      incomplete: false,
      startedAt: 3,
      finishedAt: null,
    },
    {
      turnRef: "turn-b",
      turnId: "turn-id-b",
      runId: "run-3",
      conversationId: "conv-b",
      stopReason: null,
      open: false,
      blocks: [],
      usage: null,
      incomplete: false,
      startedAt: 4,
      finishedAt: 5,
    },
  ];

  const blocks: readonly BlockEntity[] = [
    { blockId: "block-a", turnRef: "turn-a", messageId: "msg-1", runId: "run-1", block: {} },
    { blockId: "block-b", turnRef: "turn-a", messageId: "msg-1", runId: "run-1", block: {} },
    { blockId: "block-c", turnRef: "turn-b", messageId: "msg-2", runId: "run-3", block: {} },
  ];

  const queues: readonly QueueEntity[] = [
    { conversationId: "conv-a", items: [{ client_message_id: "m-1" }], count: 1 },
  ];

  const subagents: readonly (readonly SubagentEntity[])[] = [
    [
      {
        subagentId: "sub-a",
        parentAgentId: "agent-a",
        conversationId: "conv-a",
        status: "running",
        totalTokens: 12,
        durationMs: 34,
        error: null,
      },
    ],
  ];

  const usage: readonly UsageEntity[] = [
    { conversationId: "conv-a", latest: { context_tokens: 77 }, history: [] },
  ];

  const approvals: readonly (readonly ApprovalEntity[])[] = [
    [
      {
        requestId: "req-a",
        agentId: "agent-a",
        conversationId: "conv-a",
        toolName: "bash",
        input: {},
        state: "pending",
        requestedAt: 10,
      },
    ],
  ];

  const devices: readonly DeviceEntity[] = [
    {
      agentId: "agent-a",
      view: {
        isOnline: true,
        isProcessing: false,
        permissionMode: "default",
        cwd: "/repo",
        toolsetPreference: null,
        pendingApprovals: 1,
        backgroundProcesses: 0,
        loop: "IDLE",
      },
    },
  ];

  return Object.freeze({
    revision: 9,
    epoch: 3,
    agents: freezeMap(new Map(agents.map((row) => [row.agentId, row]))),
    conversations: freezeMap(new Map(conversations.map((row) => [row.conversationId, row]))),
    turns: freezeMap(new Map(turns.map((row) => [row.turnRef, row]))),
    blocks: freezeMap(new Map(blocks.map((row) => [row.blockId, row]))),
    queues: freezeMap(new Map(queues.map((row) => [row.conversationId, row]))),
    subagents: freezeMap(new Map([["conv-a", subagents[0] as readonly SubagentEntity[]]])),
    usage: freezeMap(new Map(usage.map((row) => [row.conversationId, row]))),
    approvals: freezeMap(new Map([["agent-a", approvals[0] as readonly ApprovalEntity[]]])),
    devices: freezeMap(new Map(devices.map((row) => [row.agentId, row]))),
  });
}

/**
 * The eleven contract rows, copied from the selector table.
 *
 * `returns` is the table's return column verbatim, so a reader can compare this
 * copy against the document without opening the implementation, and `ids` is the
 * answer the fixture above should produce - for the rows whose answer is a set of
 * ids, that is the smallest claim that fails if the filter is wrong.
 */
type ContractRow = {
  readonly selector: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly returns: string;
};

const CONTRACT: readonly ContractRow[] = [
  { selector: "entity.agents", params: {}, returns: "readonly AgentEntity[]" },
  { selector: "entity.agent", params: { agentId: "agent-b" }, returns: "AgentEntity | null" },
  {
    selector: "entity.conversations",
    params: { agentId: "agent-a" },
    returns: "readonly ConversationEntity[]",
  },
  {
    selector: "entity.conversation",
    params: { conversationId: "conv-b" },
    returns: "ConversationEntity | null",
  },
  {
    selector: "entity.turns",
    params: { conversationId: "conv-a" },
    returns: "readonly TurnEntity[]",
  },
  { selector: "entity.blocks", params: { turnRef: "turn-a" }, returns: "readonly BlockEntity[]" },
  { selector: "entity.queue", params: { conversationId: "conv-a" }, returns: "QueueEntity" },
  {
    selector: "entity.subagents",
    params: { conversationId: "conv-a" },
    returns: "readonly SubagentEntity[]",
  },
  { selector: "entity.usage", params: { conversationId: "conv-a" }, returns: "UsageEntity | null" },
  {
    selector: "entity.approvals",
    params: { agentId: "agent-a" },
    returns: "readonly ApprovalEntity[]",
  },
  { selector: "entity.device", params: { agentId: "agent-a" }, returns: "DeviceEntity | null" },
];

/** The shape a row's return column declares, read by the one thing that matters. */
const SHAPES: Readonly<Record<string, (outcome: SelectorOutcome) => void>> = {
  "readonly AgentEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly AgentEntity[];

    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((row) => row.agentId)).toEqual(["agent-a", "agent-b"]);
    expect(rows[0]?.conversations).toEqual(["conv-a"]);
  },
  "AgentEntity | null": (outcome) => {
    expect(valueOf(outcome)).toMatchObject({ agentId: "agent-b", name: "Beta" });
  },
  "readonly ConversationEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly ConversationEntity[];

    expect(rows.map((row) => row.conversationId)).toEqual(["conv-a"]);
    expect(rows[0]?.agentId).toBe("agent-a");
  },
  "ConversationEntity | null": (outcome) => {
    expect(valueOf(outcome)).toMatchObject({ conversationId: "conv-b", agentId: "agent-b" });
  },
  "readonly TurnEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly TurnEntity[];

    // Both turns of the conversation, the closed one and the in-flight one.
    expect(rows.map((row) => row.turnRef)).toEqual(["turn-a", "turn-open"]);
    expect(rows.some((row) => row.open && row.turnId === null)).toBe(true);
  },
  "readonly BlockEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly BlockEntity[];

    expect(rows.map((row) => row.blockId)).toEqual(["block-a", "block-b"]);
  },
  QueueEntity: (outcome) => {
    // No null in this row's contract, so a queue must be a queue.
    expect(valueOf(outcome)).toMatchObject({ conversationId: "conv-a", count: 1 });
  },
  "readonly SubagentEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly SubagentEntity[];

    expect(rows.map((row) => row.subagentId)).toEqual(["sub-a"]);
  },
  "UsageEntity | null": (outcome) => {
    expect(valueOf(outcome)).toMatchObject({ conversationId: "conv-a" });
  },
  "readonly ApprovalEntity[]": (outcome) => {
    const rows = valueOf(outcome) as readonly ApprovalEntity[];

    expect(rows.map((row) => row.requestId)).toEqual(["req-a"]);
  },
  "DeviceEntity | null": (outcome) => {
    expect(valueOf(outcome)).toMatchObject({ agentId: "agent-a" });
    expect((valueOf(outcome) as DeviceEntity).view.isOnline).toBe(true);
  },
};

/** The value of a successful outcome; fails loudly on a refused one. */
function valueOf(outcome: SelectorOutcome): unknown {
  if (!outcome.ok) {
    throw new Error(`expected a value, got the code ${outcome.code}`);
  }

  return outcome.value;
}

/** Selectors over one fixed snapshot. */
function selectorsOver(snapshot: SessionSnapshot | null): ReturnType<typeof createEntitySelectors> {
  return createEntitySelectors({ snapshot: () => snapshot });
}

/** The outcome of one request; kept short because most cases are one line. */
function run(selector: string, params: Readonly<Record<string, unknown>> = {}): SelectorOutcome {
  return selectorsOver(populated()).run(selector, params);
}

describe("each contract row answers in the shape its return column declares", () => {
  it.each(CONTRACT.map((row) => [row.selector, row] as const))(
    "%s",
    (_selector, row: ContractRow) => {
      const outcome = run(row.selector, row.params);

      expect(outcome.ok).toBe(true);
      // The declared shape has to have a check of its own; a row added to the
      // contract without one has not been verified even if the selector runs.
      expect(SHAPES[row.returns], `no shape check for ${row.returns}`).toBeDefined();
      (SHAPES[row.returns] as (o: SelectorOutcome) => void)(outcome);
    },
  );
});

describe("the eleven contract names are all implemented", () => {
  it("implements exactly the contract's rows", () => {
    // This is the assertion a delivered-but-incomplete selector table fails:
    // ten rows work, the eleventh is absent from the dispatch, and only the
    // name set says so.
    expect([...ENTITY_SELECTOR_NAMES]).toEqual(CONTRACT.map((row) => row.selector));
    expect(new Set(ENTITY_SELECTOR_NAMES).size).toBe(CONTRACT.length);
  });

  it.each(CONTRACT.map((row) => row.selector))("dispatches %s", (selector) => {
    const selectors = selectorsOver(populated());

    expect(selectors.has(selector)).toBe(true);
    expect(selectors.names).toContain(selector);
    // A name without a reader would come back as a code; that is the failure
    // this line catches, one row at a time.
    expect(
      selectors.run(selector, CONTRACT.find((row) => row.selector === selector)?.params ?? {}).ok,
    ).toBe(true);
  });

  it("refuses a name that is not in the table", () => {
    const selectors = selectorsOver(populated());

    expect(selectors.has("entity.nope")).toBe(false);
    expect(() => selectors.run("entity.nope", {})).not.toThrow();
    expect(selectors.run("entity.nope", {})).toEqual({
      ok: false,
      code: "SESSION_UNKNOWN_SELECTOR",
    });
  });
});

describe("a row the snapshot does not hold is an ordinary answer", () => {
  it("returns null for an agent nobody has described", () => {
    // Not a code: the contract spells this answer `AgentEntity | null`, and a
    // page that mistyped an id still has a complete snapshot to read.
    expect(run("entity.agent", { agentId: "no-such-agent" })).toEqual({ ok: true, value: null });
  });

  it.each([
    ["entity.conversation", { conversationId: "no-such-conversation" }],
    ["entity.usage", { conversationId: "no-such-conversation" }],
    ["entity.device", { agentId: "no-such-agent" }],
  ] as const)("returns null for a missing %s row", (selector, params) => {
    expect(run(selector, params)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["entity.conversations", { agentId: "no-such-agent" }],
    ["entity.turns", { conversationId: "no-such-conversation" }],
    ["entity.blocks", { turnRef: "no-such-turn" }],
    ["entity.subagents", { conversationId: "no-such-conversation" }],
    ["entity.approvals", { agentId: "no-such-agent" }],
  ] as const)("returns an empty list for %s", (selector, params) => {
    expect(run(selector, params)).toEqual({ ok: true, value: [] });
  });
});

describe("a request of the wrong shape is a code, not a throw", () => {
  it.each([
    ["entity.agent", {}],
    ["entity.agent", { agentId: "" }],
    ["entity.agent", { agentId: 7 }],
    ["entity.conversation", {}],
    ["entity.turns", { conversationId: null }],
    ["entity.blocks", {}],
    ["entity.queue", {}],
    ["entity.subagents", {}],
    ["entity.usage", {}],
    ["entity.approvals", {}],
    ["entity.device", {}],
  ] as const)("refuses %s with %j", (selector, params) => {
    const selectors = selectorsOver(populated());

    expect(() => selectors.run(selector, params)).not.toThrow();
    expect(selectors.run(selector, params)).toEqual({ ok: false, code: "SESSION_BAD_PARAMS" });
  });

  it("refuses parameters that are not a record at all", () => {
    const selectors = selectorsOver(populated());
    const notARecord = [] as unknown as Readonly<Record<string, unknown>>;

    expect(selectors.run("entity.agent", notARecord)).toEqual({
      ok: false,
      code: "SESSION_BAD_PARAMS",
    });
  });

  it("reports a caller bug even while no snapshot exists", () => {
    // Name and shape are decided before state, so a page bug does not read as
    // "the engine is offline". Checked for every row that takes a parameter, so
    // the precedence is a property of the dispatch rather than of one name.
    const offline = selectorsOver(null);

    expect(offline.run("entity.nope", {})).toEqual({ ok: false, code: "SESSION_UNKNOWN_SELECTOR" });

    for (const selector of ENTITY_SELECTOR_NAMES.filter((name) => name !== "entity.agents")) {
      expect(offline.run(selector, {})).toEqual({ ok: false, code: "SESSION_BAD_PARAMS" });
    }

    expect(offline.run("entity.agents", {})).toEqual({
      ok: false,
      code: "SESSION_UNAVAILABLE",
    });
  });
});

describe("no snapshot yet is its own answer", () => {
  it.each(CONTRACT.map((row) => [row.selector, row.params] as const))(
    "%s reports the no-value code",
    (selector, params) => {
      const selectors = selectorsOver(null);

      expect(() => selectors.run(selector, params)).not.toThrow();
      expect(selectors.run(selector, params)).toEqual({ ok: false, code: "SESSION_UNAVAILABLE" });
    },
  );

  it("reports the no-value code for a queue the contract cannot spell as absent", () => {
    // `entity.queue` returns `QueueEntity`, with no null slot: an empty queue
    // would claim the engine said "nothing is waiting", so absence is a code.
    expect(run("entity.queue", { conversationId: "no-such-conversation" })).toEqual({
      ok: false,
      code: "SESSION_UNAVAILABLE",
    });
  });
});

describe("a read changes nothing and returns the same answer twice", () => {
  it("keeps the snapshot it read, and reads the same row again", () => {
    const snapshot = populated();
    const selectors = selectorsOver(snapshot);

    const first = selectors.run("entity.turns", { conversationId: "conv-a" });
    const second = selectors.run("entity.turns", { conversationId: "conv-a" });

    // Deep equality, not reference equality: a filter over a table builds its
    // own frozen list, and a selector allocates nothing it keeps alive.
    expect(second).toEqual(first);
    expect(snapshot.revision).toBe(9);
    expect(snapshot.agents.get("agent-a")?.name).toBe("Alpha");
  });

  it("returns an order nobody sorted", () => {
    // The engine's order is the order; pinned here because "helpfully" sorting
    // on the way out is the easiest way to break the navigation view downstream.
    const agents = valueOf(run("entity.agents")) as readonly AgentEntity[];

    expect(agents.map((row) => row.agentId)).toEqual(["agent-a", "agent-b"]);
  });
});
