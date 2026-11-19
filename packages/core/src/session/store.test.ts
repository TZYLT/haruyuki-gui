/**
 * The assembly, pinned from the outside: what a change does to a snapshot, what
 * a repeated change does to it, and what a subscriber is told.
 *
 * The cases below are chosen so that each one fails when the wiring it covers is
 * removed, which is the only reason an assembly test is worth having - every
 * rule it applies already has a suite of its own below it.
 *
 * - **A replay must be free.** A reconnect re-sends the tail of the stream. The
 *   folds below hand out a fresh turn ref per pass, so without a suppression
 *   table keyed on the change itself the same turn would be counted twice. The
 *   second half of the same case is the mirror image: two genuinely different
 *   turns that share a run id and a stop reason must still be two turns.
 * - **A revision means something moved.** One change costs at most one revision,
 *   a change no fold reads costs none, and a duplicate costs none - otherwise a
 *   subscriber re-renders at frame rate.
 * - **The two seams are closed.** The loop state travels on its own change kind
 *   and only reaches the device row through the projector; the unread badge only
 *   counts a turn once it is closed, and it is emptied when a view instance
 *   reports itself active on that conversation.
 * - **Nothing is unbounded.** Both tables that grow with traffic are pinned by
 *   volume, not by inspection.
 * - **Nothing throws.** Malformed input is a skipped change, not an exception.
 */

import { describe, expect, it } from "vitest";

import type {
  ApprovalEntity,
  ContextView,
  SelectResult,
  SessionSelectCode,
  SessionSnapshot,
  SessionStats,
  SessionStore,
  ViewState,
} from "@haruyuki/protocol";

import type { MergerChange } from "../merge/types.js";
import { DEDUPE_TURN_LIMIT, createSessionStore, type SessionStoreDeps } from "./store.js";

/** The fields every change in this suite carries. */
type Base = {
  readonly conversationId: string;
  readonly at: number;
  readonly subagentId: string | null;
};

const base = (at: number, conversationId = "c-1", subagentId: string | null = null): Base => ({
  conversationId,
  at,
  subagentId,
});

/** A message that opens a turn. */
function message(at: number, messageId: string, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "message.delta",
    messageId,
    runId: "local-run-1",
    runSeq: 1,
    text: "hello",
    parts: [],
    first: true,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** The closing signal; every turn has exactly one. */
function stopped(at: number, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "turn.stopped",
    runId: "local-run-1",
    turnId: null,
    stopReason: "end_turn",
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** The terminal frame, which fills in the id and never closes anything. */
function finished(at: number, turnId: string, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "turn.finished",
    turnId,
    runId: "local-run-1",
    stopReason: "end_turn",
    usage: { totalTokens: 10, contextTokens: 5 },
    incomplete: false,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** One loop state change, spelled as the merger leaves the engine payload. */
function loop(at: number, status: string): MergerChange {
  return {
    ...base(at),
    kind: "state.loop",
    value: { type: "update_loop_status", loop_status: { status, active_run_ids: [] } },
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** One device snapshot, with every required field present. */
function device(at: number, overrides: Record<string, unknown> = {}): MergerChange {
  return {
    ...base(at),
    kind: "state.device",
    value: {
      type: "update_device_status",
      device_status: {
        is_online: true,
        is_processing: false,
        pending_control_requests: [],
        background_processes: [{ id: "p-1" }],
        current_permission_mode: "standard",
        current_working_directory: "/repo",
        current_toolset_preference: "default",
        ...overrides,
      },
    },
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** One queue snapshot, with the entries a page draws. */
function queue(at: number, ids: readonly string[]): MergerChange {
  return {
    ...base(at),
    kind: "state.queue",
    value: {
      type: "update_queue",
      queue: ids.map((id) => ({ id: `row-${id}`, client_message_id: id, kind: "message" })),
      removed: [],
    },
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** One approval request. */
function approval(at: number, requestId: string): MergerChange {
  return {
    ...base(at),
    kind: "approval.requested",
    requestId,
    body: { request: { tool_name: "bash", input: { command: "ls" } } },
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** A change that no fold reads, used to move volume without moving state. */
function passthrough(at: number): MergerChange {
  return {
    ...base(at),
    kind: "passthrough",
    type: "some_frame",
    raw: {},
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** A store with one agent and one conversation in it, as the shell would seed it. */
function seeded(deps: SessionStoreDeps = {}) {
  const store = createSessionStore(deps);

  store.ingestAgents([{ id: "agent-a", name: "Agent A" }]);
  store.ingestConversations(
    [{ id: "c-1", agent_id: "agent-a", last_message_at: "2026-11-19T00:00:00.000Z" }],
    { hasMore: false },
  );

  return store;
}

/**
 * One selector run, keeping the refusal code.
 *
 * The store's `select` is signed to return a plain result, and it carries the
 * code on the same object when there is one - which the type cannot say, because
 * the contract has no arm for a failure. The shell is the caller that reads it.
 */
function pick(store: SessionStore, selector: string, params: Record<string, unknown> = {}) {
  return store.select({ instanceId: "tab-1", selector, params }) as SelectResult & {
    readonly code?: SessionSelectCode;
  };
}

/** Every key the signed statistics record declares, and the type it must have. */
const STATS_SHAPE = {
  revision: "number",
  epoch: "number",
  ingestCount: "number",
  changesApplied: "number",
  changesIgnored: "number",
  pushesSent: "number",
  pushesCoalesced: "number",
  subscriptions: "number",
  dedupeTurns: "number",
  viewStates: "number",
  lastPushAt: "object",
} as const;

describe("one change, one revision", () => {
  it("closes a turn on the stop signal and publishes it", () => {
    const store = seeded();
    const opened = store.ingest(message(1, "m-1"));
    const before = store.stats().revision;
    const closed = store.ingest(stopped(2));

    expect(opened).toBe(true);
    expect(closed).toBe(true);
    // Exactly one revision per closing change: not zero (the turn moved) and not
    // two (one change is one publication).
    expect(store.stats().revision).toBe(before + 1);

    const snapshot = store.getSnapshot();
    const turn = [...snapshot.turns.values()][0];

    expect(turn).toBeDefined();
    expect(turn?.open).toBe(false);
    expect(turn?.stopReason).toBe("end_turn");
    // The conversation carries its own turn list, which the assembly writes from
    // the turn table rather than letting a page join the two.
    expect(snapshot.conversations.get("c-1")?.turns).toEqual([turn?.turnRef]);
  });

  it("backfills the id on the terminal frame without opening a second turn", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));

    const before = store.stats().revision;

    expect(store.ingest(finished(3, "turn-abc"))).toBe(true);

    const snapshot = store.getSnapshot();
    const turns = [...snapshot.turns.values()];

    expect(turns).toHaveLength(1);
    expect(turns[0]?.turnId).toBe("turn-abc");
    expect(turns[0]?.usage).toMatchObject({ totalTokens: 10 });
  });

  it("advances nothing for a change no fold reads", () => {
    const store = seeded();
    const before = store.stats().revision;

    expect(store.ingest(passthrough(1))).toBe(false);
    expect(store.stats().revision).toBe(before);
    expect(store.stats().changesIgnored).toBe(1);
  });

  it("counts every change into one of the two buckets", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(passthrough(2));
    store.ingest(stopped(3));

    const stats = store.stats();

    // Applied and ignored partition the ingested count: a change either moved
    // the published state or it did not.
    expect(stats.changesApplied + stats.changesIgnored).toBe(stats.ingestCount);
    expect(stats.changesApplied).toBe(2);
    expect(stats.changesIgnored).toBe(1);
  });

  it("reads a terminal frame that arrived after its turn was already gone", () => {
    // The record it would fill was never opened, so there is nothing to publish
    // from it. A lone `turn.finished` is a late completion, not a turn: the turn
    // table creates a record from a message and closes it on the stop signal.
    const store = seeded();
    const before = store.stats().revision;

    expect(store.ingest(finished(1, "turn-lost"))).toBe(false);
    expect(store.getSnapshot().turns.size).toBe(0);
    expect(store.stats().revision).toBe(before);
  });

  it("keeps the published snapshot stable between revisions", () => {
    const store = seeded();

    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });
});

describe("a published turn is the contract's turn", () => {
  it("carries exactly the signed fields, and nothing the record added", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));

    const turn = [...store.getSnapshot().turns.values()][0];

    // The turn table's record also says which agent line the turn belongs to.
    // That field is internal: the badge reads it off the record, and a page that
    // received it would be reading a member the contract never declared.
    expect(Object.keys(turn ?? {}).sort()).toEqual(
      [
        "blocks",
        "conversationId",
        "finishedAt",
        "incomplete",
        "open",
        "runId",
        "startedAt",
        "stopReason",
        "turnId",
        "turnRef",
        "usage",
      ].sort(),
    );
  });

  it("agrees with the record on every field the contract does declare", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));
    store.ingest(finished(3, "turn-1"));

    const turn = [...store.getSnapshot().turns.values()][0];

    expect(turn).toMatchObject({
      turnId: "turn-1",
      runId: "local-run-1",
      conversationId: "c-1",
      stopReason: "end_turn",
      open: false,
      incomplete: false,
      startedAt: 1,
      finishedAt: 2,
    });
  });
});

describe("a replayed change is folded once", () => {
  /** One recording's worth of changes: an opened turn, a closed one, and content. */
  const frames = (): readonly MergerChange[] => [
    message(1, "m-1"),
    stopped(2),
    finished(3, "turn-1"),
    approval(4, "req-1"),
    device(5),
    queue(6, ["q-1", "q-2"]),
  ];

  const feed = (store: ReturnType<typeof seeded>, changes: readonly MergerChange[]): void => {
    for (const change of changes) {
      store.ingest(change);
    }
  };

  it("holds every count still when the same sequence arrives twice", () => {
    const once = seeded();
    const twice = seeded();

    feed(once, frames());
    feed(twice, frames());
    feed(twice, frames());

    const before = once.getSnapshot();
    const after = twice.getSnapshot();

    // The badge is the count that would double. It is read through the selector
    // rather than off the snapshot because that is where the two halves are
    // added, and because the folds hand out a new turn ref on the second pass -
    // nothing below the assembly can tell the two replays apart.
    const reading = (store: ReturnType<typeof seeded>): unknown =>
      store.select({
        instanceId: "tab-1",
        selector: "view.tabActivity",
        params: { instanceId: "tab-1", conversationId: "c-1" },
      }).value;

    expect(reading(twice)).toEqual(reading(once));
    expect([...after.turns.values()].length).toBe([...before.turns.values()].length);
    expect([...after.blocks.values()].length).toBe([...before.blocks.values()].length);
    expect(after.queues.get("c-1")?.count).toBe(before.queues.get("c-1")?.count);
    expect(after.devices.get("agent-a")?.view).toEqual(before.devices.get("agent-a")?.view);
    expect(after.conversations.get("c-1")?.incompleteTurnRefs).toEqual(
      before.conversations.get("c-1")?.incompleteTurnRefs,
    );
    // The first pass really did count the turn, so a comparison of two zeroes
    // cannot pass for idempotence.
    expect(reading(once)).toMatchObject({ unread: 1 });
  });

  it("counts the badge of a replayed turn once", () => {
    const store = seeded();
    const report = () => store.stats();

    for (const change of [message(1, "m-1"), stopped(2), finished(3, "turn-1")]) {
      store.ingest(change);
    }

    const firstPass = report();
    const pushed = store.subscribe(
      {
        instanceId: "tab-1",
        selector: "view.tabActivity",
        params: { instanceId: "tab-1", conversationId: "c-1" },
      },
      () => {},
    );

    store.ingest(stopped(2));
    store.ingest(finished(3, "turn-1"));

    // The replayed frames were refused, so no frame was sent for them.
    expect(store.stats().revision).toBe(firstPass.revision);
    expect(store.stats().changesIgnored).toBeGreaterThan(firstPass.changesIgnored);
    expect(store.stats().pushesSent).toBe(1);

    pushed();
  });

  it("keeps two genuinely different turns apart when they share a run id", () => {
    // Both close with the same run id and the same reason, and neither terminal
    // frame arrived: the only thing telling them apart is when they happened.
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));
    store.ingest(message(10, "m-2"));
    store.ingest(stopped(11));

    // Two turns, each counted once: a suppression table that keyed on the run id
    // alone would fold the second close into the first and the badge would read
    // one.
    expect(store.getSnapshot().turns.size).toBe(2);

    const badge = store.select({
      instanceId: "tab-1",
      selector: "view.tabActivity",
      params: { instanceId: "tab-1", conversationId: "c-1" },
    });

    expect((badge.value as { unread: number }).unread).toBe(2);
  });
});

describe("the loop state reaches the device row", () => {
  it("carries the state into the row projected after it", () => {
    const store = seeded();

    // The loop state travels on its own change kind, so it cannot appear in the
    // device payload; without the seam the row's field would stay empty forever.
    store.ingest(loop(1, "EXECUTING_COMMAND"));
    store.ingest(device(2));

    expect(store.getSnapshot().devices.get("agent-a")?.view.loop).toBe("EXECUTING_COMMAND");
  });

  it("keeps every one of the eight states verbatim", () => {
    const store = seeded();
    const states = [
      "SENDING_API_REQUEST",
      "WAITING_FOR_API_RESPONSE",
      "RETRYING_API_REQUEST",
      "PROCESSING_API_RESPONSE",
      "EXECUTING_CLIENT_SIDE_TOOL",
      "EXECUTING_COMMAND",
      "WAITING_ON_APPROVAL",
      "WAITING_ON_INPUT",
    ];

    for (const [index, state] of states.entries()) {
      store.ingest(loop(index * 10 + 1, state));
      store.ingest(device(index * 10 + 2));

      // Not collapsed into three words: two of these eight mean "waiting on
      // you", and a page decides where to draw its pulse from them.
      expect(store.getSnapshot().devices.get("agent-a")?.view.loop).toBe(state);
    }
  });

  it("leaves the field empty when no loop frame has arrived", () => {
    const store = seeded();

    store.ingest(device(1));

    expect(store.getSnapshot().devices.get("agent-a")?.view.loop).toBeNull();
  });
});

describe("the unread badge is fed at the seams", () => {
  it("counts a closed turn and adds the pending approvals", () => {
    const store = seeded();

    store.ingest(approval(1, "req-1"));
    store.ingest(message(2, "m-1"));
    store.ingest(stopped(3));

    const row = store.select({
      instanceId: "tab-1",
      selector: "view.tabActivity",
      params: { instanceId: "tab-1", conversationId: "c-1" },
    });

    // One closed turn plus one waiting request: the row shows the sum and never
    // adds, so both halves are asserted here rather than the total alone.
    expect(row.value).toMatchObject({ unread: 1, approvals: 1 });
  });

  it("empties the badge when a view instance reports itself active there", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));

    const frames: SelectResult[] = [];
    const release = store.subscribe(
      {
        instanceId: "tab-1",
        selector: "view.tabActivity",
        params: { instanceId: "tab-1", conversationId: "c-1" },
        active: true,
      },
      (result) => frames.push(result),
    );

    // The first frame is the current value, sent during `subscribe`: entering a
    // conversation is the one moment the count goes back to zero.
    expect(frames).toHaveLength(1);
    expect(frames[0]?.value).toMatchObject({ unread: 0 });

    // And a turn closed while the conversation is watched is not news.
    store.ingest(message(10, "m-2"));
    store.ingest(stopped(11));

    expect(frames.at(-1)?.value).toMatchObject({ unread: 0 });

    release();
  });

  it("does not count a subagent's turn", () => {
    const store = seeded();

    store.ingest(message(1, "m-1", { subagentId: "sa-1" }));
    store.ingest(stopped(2, { subagentId: "sa-1" }));

    const row = store.select({
      instanceId: "tab-1",
      selector: "view.tabActivity",
      params: { instanceId: "tab-1", conversationId: "c-1" },
    });

    expect(row.value).toMatchObject({ unread: 0 });
    // The turn itself is real and was closed; only the badge skipped it.
    expect(store.getSnapshot().turns.size).toBe(1);
  });
});

describe("content lands on a turn", () => {
  it("attaches a block to the open turn of its message", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ id: "b-1", text: "first" }],
      removes: [],
    });

    const snapshot = store.getSnapshot();
    const turn = [...snapshot.turns.values()][0];

    expect(snapshot.blocks.get("b-1")?.turnRef).toBe(turn?.turnRef);
    expect(turn?.blocks).toEqual(["b-1"]);
  });

  it("keeps a block whose message and run nobody knows, instead of dropping it", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingestContent("c-1", {
      messageId: "m-unknown",
      upserts: [{ id: "b-orphan", text: "kept" }],
      removes: [],
    });

    // Losing text is the worse failure: it is drawn at the end of the
    // conversation rather than thrown away.
    expect(store.getSnapshot().blocks.get("b-orphan")?.turnRef).toBe("orphan");
  });

  it("replaces a block in place and honours the removal list", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { id: "b-1", text: "first" },
        { id: "b-2", text: "second" },
      ],
      removes: [],
    });
    store.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ id: "b-1", text: "replaced" }],
      removes: ["b-2"],
    });

    expect(store.getSnapshot().blocks.get("b-1")?.block).toMatchObject({ text: "replaced" });
    expect(store.getSnapshot().blocks.has("b-2")).toBe(false);
  });
});

describe("context pressure is derived, not forwarded", () => {
  it("folds a usage report into the conversation row", () => {
    const store = seeded();

    store.ingestUsage("c-1", { contextTokens: 50_000 }, null);

    expect(store.getSnapshot().usage.get("c-1")?.latest).toMatchObject({ contextTokens: 50_000 });
  });

  it("takes the denominator from whichever layer spoke, in order", () => {
    const store = seeded();

    // Nothing yet: no ceiling, so no ratio either.
    store.ingestUsage("c-1", { contextTokens: 1000 }, null);
    expect(store.getSnapshot().conversations.get("c-1")?.context).toMatchObject({
      limit: null,
      percentage: null,
    });

    // The model catalog is the lowest layer; it answers while the others are empty.
    store.setContextLimit("c-1", 4000, "model-catalog");
    expect(store.getSnapshot().conversations.get("c-1")?.context).toMatchObject({
      limit: 4000,
      source: "model-catalog",
      percentage: 25,
    });

    // A higher layer overrules it, and the source says which one answered.
    store.setContextLimit("c-1", 2000, "agent-config");
    expect(store.getSnapshot().conversations.get("c-1")?.context).toMatchObject({
      limit: 2000,
      source: "agent-config",
      percentage: 50,
    });
  });

  it("treats the legacy clamp value as no ceiling at all", () => {
    const store = seeded();

    store.ingestUsage("c-1", { contextTokens: 128_000 }, null);
    store.setContextLimit("c-1", 128_000, "agent-config");

    // A value that matches no preset is the server's clamp, not a window.
    expect(store.getSnapshot().conversations.get("c-1")?.context).toMatchObject({
      limit: null,
      source: "none",
    });
  });
});

describe("selectors run in the store, not in a page", () => {
  it("answers an entity selector from the snapshot", () => {
    const store = seeded();
    const result = store.select({
      instanceId: "tab-1",
      selector: "entity.conversation",
      params: { conversationId: "c-1" },
    });

    expect(result.value).toMatchObject({ conversationId: "c-1", agentId: "agent-a" });
    expect(result.revision).toBe(store.stats().revision);
    expect(result.epoch).toBe(store.stats().epoch);
  });

  it("falls through to the view table only for a name nobody implements", () => {
    const store = seeded();
    const view = pick(store, "view.agentBadges");

    expect(view.code).toBeUndefined();
    expect(view.value).toEqual(expect.any(Array));

    const unknown = pick(store, "view.nope");

    expect(unknown.code).toBe("SESSION_UNKNOWN_SELECTOR");
  });

  it("refuses a bad request with the code the page maps, not with null alone", () => {
    const store = seeded();

    expect(pick(store, "entity.agent").code).toBe("SESSION_BAD_PARAMS");
  });

  it("sends the current value at once and then only what moved", () => {
    const store = seeded();
    const frames: SelectResult[] = [];

    const release = store.subscribe(
      {
        instanceId: "tab-1",
        selector: "view.conversationRow",
        params: { conversationId: "c-1" },
      },
      (result) => frames.push(result),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0]?.value).toMatchObject({ conversationId: "c-1" });

    // A change that moves nothing this selector reads sends nothing.
    store.ingest(passthrough(1));
    expect(frames).toHaveLength(1);

    store.ingest(message(2, "m-1"));
    expect(frames.length).toBeGreaterThan(1);

    const seen = frames.length;

    release();
    store.ingest(message(3, "m-2"));

    expect(frames).toHaveLength(seen);
  });

  it("tells the shell's own sink as well", () => {
    const bodies: { instanceId: string }[] = [];
    const store = seeded({ onView: (body) => bodies.push(body) });

    const release = store.subscribe(
      {
        instanceId: "tab-9",
        selector: "view.agentBadges",
        params: {},
      },
      () => {},
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.instanceId).toBe("tab-9");

    release();
  });
});

describe("view state is per tab instance", () => {
  it("keeps two tabs apart and releases one without touching the other", () => {
    const store = createSessionStore();
    const first: ViewState = { anchor: { id: "m-1", offset: 120 }, collapsed: ["g-1"] };
    const second: ViewState = { anchor: null, collapsed: [] };

    store.setViewState("tab-1", first);
    store.setViewState("tab-2", second);

    expect(store.viewState("tab-1")).toEqual(first);
    expect(store.viewState("tab-2")).toEqual(second);

    store.releaseViewState("tab-1");

    expect(store.viewState("tab-1")).toBeNull();
    expect(store.viewState("tab-2")).toEqual(second);
    expect(store.stats().viewStates).toBe(1);
  });
});

describe("a reconnect crosses a generation boundary", () => {
  it("re-answers every live subscription carrying the new generation", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.ingest(stopped(2));

    const frames: SelectResult[] = [];

    const release = store.subscribe(
      {
        instanceId: "tab-1",
        selector: "view.agentBadges",
        params: {},
      },
      (result) => frames.push(result),
    );

    const before = frames.at(-1)?.epoch;

    store.rebase();

    expect(store.stats().epoch).toBe((before ?? 0) + 1);
    expect(frames.at(-1)?.epoch).toBe(store.stats().epoch);
    // The suppression table survives the boundary on purpose: the tail of the
    // stream is about to be re-sent through it.
    expect(store.stats().dedupeTurns).toBeGreaterThan(0);

    release();
  });
});

describe("both growing tables are bounded", () => {
  it("stops remembering processed changes and view states", () => {
    const store = seeded();
    const volume = 100_000;

    for (let index = 0; index < volume; index += 1) {
      // A change no fold reads: this measures the suppression table, not the
      // folds, and keeps the volume affordable.
      store.ingest(passthrough(index + 1));
      store.setViewState(`tab-${String(index)}`, { anchor: null, collapsed: [] });
    }

    const stats = store.stats();

    expect(stats.ingestCount).toBe(volume);
    expect(stats.dedupeTurns).toBeLessThanOrEqual(DEDUPE_TURN_LIMIT);
    // The view-state table keeps the newest tabs, not every tab ever opened.
    expect(stats.viewStates).toBeLessThanOrEqual(64);
    expect(stats.viewStates).toBeGreaterThan(0);
  });
});

describe("nothing thrown reaches the caller", () => {
  it("skips a change that is not a change at all", () => {
    const store = seeded();
    const before = store.getSnapshot();

    for (const malformed of [null, {}, 42, "nope", []]) {
      expect(store.ingest(malformed as never)).toBe(false);
    }

    expect(store.getSnapshot()).toBe(before);
    expect(store.stats().changesIgnored).toBe(5);
  });

  it("survives a change with the right kind and unusable fields", () => {
    const store = seeded();
    const broken = [
      { ...base(1), kind: "message.delta", messageId: 42, runId: null, runSeq: "x", text: null },
      { ...base(2), kind: "turn.stopped", stopReason: 7 },
      { ...base(3), kind: "state.device", value: "not a payload" },
      { ...base(4), kind: "state.queue", value: [1, 2, 3] },
      { ...base(5), kind: "usage.reported", usage: 12 },
      { ...base(6), kind: "approval.requested", requestId: {} },
    ];

    for (const change of broken) {
      expect(() => store.ingest(change as never)).not.toThrow();
    }

    // The store is still usable afterwards, which is the whole point.
    expect(store.ingest(message(7, "m-1"))).toBe(true);
    expect(store.getSnapshot().turns.size).toBe(1);
  });

  it("survives an unusable page and an unusable content update", () => {
    const store = seeded();

    expect(() => store.ingestAgents([null, 3, {}, { id: "" }] as never)).not.toThrow();
    expect(() => store.ingestConversations([null, {}] as never, { hasMore: true })).not.toThrow();
    expect(() => store.ingestContent("c-1", null as never)).not.toThrow();
    expect(() => store.ingestUsage("c-1", null as never, null)).not.toThrow();
    expect(() => store.setContextLimit("c-1", Number.NaN, "agent-config")).not.toThrow();
    expect(() => store.select(null as never)).not.toThrow();
  });
});

describe("the statistics record is complete", () => {
  it("answers every field the contract names, with its own type", () => {
    const store = seeded();

    store.ingest(message(1, "m-1"));
    store.setViewState("tab-1", { anchor: null, collapsed: [] });

    const stats: SessionStats = store.stats();

    // A field missing here is a contract member not implemented; a field with the
    // wrong type is a value invented to fill the shape.
    expect(Object.keys(stats).sort()).toEqual(Object.keys(STATS_SHAPE).sort());

    for (const [key, type] of Object.entries(STATS_SHAPE)) {
      if (key === "lastPushAt") {
        // The one nullable member: it is `null` until a frame has been sent.
        expect(stats.lastPushAt === null || typeof stats.lastPushAt === "number").toBe(true);

        continue;
      }

      const value = (stats as unknown as Record<string, unknown>)[key];

      expect(typeof value).toBe(type);
    }
  });

  it("reports the pushes it sent and the ones it did not need to", () => {
    const store = seeded();

    const release = store.subscribe(
      {
        instanceId: "tab-1",
        selector: "view.agentBadges",
        params: {},
      },
      () => {},
    );

    // The first frame is sent during `subscribe`.
    expect(store.stats().pushesSent).toBe(1);
    expect(store.stats().lastPushAt).toEqual(expect.any(Number));

    // A change this selector reads but whose value did not move: re-run, no frame.
    const coalesced = store.stats().pushesCoalesced;

    store.ingest(device(1));
    expect(store.stats().pushesCoalesced).toBeGreaterThan(coalesced);

    release();
    expect(store.stats().subscriptions).toBe(0);
  });
});
