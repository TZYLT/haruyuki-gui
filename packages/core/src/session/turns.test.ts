/**
 * The in-flight turn table, proved by the six situations that shape it.
 *
 * Each case here fails for a different wrong key or a different wrong close
 * signal, which is why they are separate tests rather than one long scenario:
 *
 * - one record per turn, with the ref held constant and `turnId` filled in later;
 * - a turn still closes when its terminal frame is lost in a gap;
 * - a turn that continues under a second run after an approval stays one turn;
 * - a subagent's turn closes like any other but is marked as not the reader's;
 * - two conversations that each used the same run id do not touch each other;
 * - the table stays bounded and says how much it dropped.
 */

import type { TurnEntity } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { MergerChange, UsageSnapshot } from "../merge/types.js";
import { createTurnTable, isCountedTurn, TURN_TABLE_LIMIT } from "./turns.js";

/** The fields every change in this suite carries. */
type Base = {
  readonly conversationId: string;
  readonly at: number;
  readonly subagentId: string | null;
  readonly runId: string | null;
};

const base = (at: number, conversationId = "c-1", subagentId: string | null = null): Base => ({
  conversationId,
  at,
  subagentId,
  runId: null,
});

/** One assistant content change; the first change of a turn opens its record. */
function delta(at: number, runId: string | null, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "message.delta",
    messageId: "m-1",
    runId,
    runSeq: 1,
    text: "hello",
    parts: [],
    first: at === 1,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** A stop reason change, which is the only close signal in the recording. */
function stopped(
  at: number,
  stopReason: string,
  runId: string | null,
  overrides: Partial<Base> = {},
): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "turn.stopped",
    runId,
    turnId: null,
    stopReason,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** The terminal frame; it fills fields into a record that already exists. */
function finished(
  at: number,
  turnId: string,
  overrides: Partial<Base> = {},
  extra: {
    readonly usage?: UsageSnapshot | null;
    readonly incomplete?: boolean;
    readonly stopReason?: string;
  } = {},
): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "turn.finished",
    turnId,
    runId: "r-1",
    stopReason: extra.stopReason ?? "end_turn",
    usage: extra.usage ?? null,
    incomplete: extra.incomplete ?? false,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** The usage snapshot used where a report is expected. */
const USAGE: UsageSnapshot = Object.freeze({ totalTokens: 42, costUsd: 0.01 });

describe("a turn keeps one record for its whole life", () => {
  it("opens on the first delta, holds its ref through content, and gains its id at the end", () => {
    const table = createTurnTable();

    const opened = table.ingest(delta(1, "local-run-1"));

    expect(opened.effect).toBe("opened");
    expect(opened.turnRef).toBe("c-1#1");
    expect(table.turns()).toHaveLength(1);

    // Streaming: no id yet, and it says so with `null` rather than a string.
    expect(table.get("c-1#1")).toMatchObject<Partial<TurnEntity>>({
      turnId: null,
      open: true,
      blocks: [],
      finishedAt: null,
    });

    // Content lands on the same record and cannot change the ref.
    const content = table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ blockId: "b-1" }, { blockId: "b-2" }],
      removes: [],
    });

    expect(content.turnRef).toBe("c-1#1");
    expect(table.turns()).toHaveLength(1);
    expect(table.get("c-1#1")?.blocks).toEqual(["b-1", "b-2"]);

    table.ingest(delta(2, "local-run-1"));

    expect(table.turns()).toHaveLength(1);

    const backfilled = table.ingest(finished(3, "t-9", {}, { usage: USAGE, incomplete: true }));

    expect(backfilled.effect).toBe("backfilled");
    expect(backfilled.turnRef).toBe("c-1#1");
    // The whole point: one record, same ref, and the id appearing in place.
    expect(table.turns()).toHaveLength(1);
    expect(table.turns()[0]?.turnRef).toBe("c-1#1");
    expect(table.get("c-1#1")).toMatchObject<Partial<TurnEntity>>({
      turnId: "t-9",
      usage: USAGE,
      incomplete: true,
      open: true,
    });
  });

  it("replaces a block in place and drops the ones the update removes", () => {
    const table = createTurnTable();

    table.ingest(delta(1, null));
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ id: "b-1" }, { id: "b-2" }],
      removes: [],
    });
    table.ingestContent("c-1", { messageId: "m-1", upserts: [{ id: "b-1" }], removes: ["b-2"] });

    expect(table.turns()[0]?.blocks).toEqual(["b-1"]);
  });
});

describe("the close signal is end_turn, not the terminal frame", () => {
  it("closes the turn when the terminal frame was lost, and the next delta starts a new one", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));

    // No `turn.finished` at all: the frame fell into a gap.
    const closed = table.ingest(stopped(2, "end_turn", "local-run-1"));

    expect(closed.effect).toBe("closed");
    expect(table.openTurn("c-1")).toBeNull();
    expect(table.get("c-1#1")).toMatchObject<Partial<TurnEntity>>({
      open: false,
      turnId: null,
      stopReason: "end_turn",
      finishedAt: 2,
    });

    // A new turn, not the old record reopened.
    const next = table.ingest(delta(3, "local-run-1"));

    expect(next.effect).toBe("opened");
    expect(next.turnRef).toBe("c-1#2");
    expect(table.turns()).toHaveLength(2);
    expect(table.openTurn("c-1")?.turnRef).toBe("c-1#2");
    expect(table.stats().closedWithoutTerminal).toBe(1);
  });

  it("keeps the turn open across an approval, because the message may still grow", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));

    const paused = table.ingest(stopped(2, "requires_approval", "local-run-1"));

    expect(paused.effect).toBe("attributed");
    expect(table.openTurn("c-1")?.turnRef).toBe("c-1#1");
    expect(table.stats().paused).toBe(1);
  });

  it("keeps the id it filled in when the close signal arrives after the terminal frame", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));
    table.ingest(finished(2, "t-5", {}, { usage: USAGE }));
    table.ingest(stopped(3, "end_turn", "local-run-1"));

    // Still one record, and the close did not erase what the terminal frame knew.
    expect(table.turns()).toHaveLength(1);
    expect(table.get("c-1#1")).toMatchObject<Partial<TurnEntity>>({
      turnId: "t-5",
      usage: USAGE,
      open: false,
      stopReason: "end_turn",
      finishedAt: 3,
    });
    // The id was known before the close, so this is not a lost terminal frame.
    expect(table.stats().closedWithoutTerminal).toBe(0);
    expect(table.stats().endTurns.main).toBe(1);
  });

  it("closes on a stop reason other than end_turn", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));

    // The engine declares twelve reasons that end a turn; the recording only ever
    // showed end_turn, so reading the list off the recording would miss these.
    const closed = table.ingest(stopped(2, "cancelled", "local-run-1"));

    expect(closed.effect).toBe("closed");
    expect(table.openTurn("c-1")).toBeNull();
    expect(table.get("c-1#1")).toMatchObject<Partial<TurnEntity>>({
      open: false,
      stopReason: "cancelled",
      finishedAt: 2,
    });
    expect(table.stats().endTurns.main).toBe(1);
    expect(table.stats().unknownStopReason).toBe(0);
  });

  it("closes on a stop reason it has never seen, and counts that it did not know it", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));

    const closed = table.ingest(stopped(2, "some_future_reason", "local-run-1"));

    // Closing is the lesser error: leaving the turn open would leak the record
    // and swallow the next turn into it.
    expect(closed.effect).toBe("closed");
    expect(table.openTurn("c-1")).toBeNull();
    expect(table.get("c-1#1")?.open).toBe(false);
    expect(table.get("c-1#1")?.stopReason).toBe("some_future_reason");
    expect(table.stats().unknownStopReason).toBe(1);

    // The next turn is a new record, not the closed one reopened.
    expect(table.ingest(delta(3, "local-run-1")).turnRef).toBe("c-1#2");
  });

  it('refuses to write the string "null" into the turn id', () => {
    const table = createTurnTable();

    table.ingest(delta(1, null));
    table.ingest(stopped(2, "end_turn", null));

    expect(table.get("c-1#1")?.turnId).toBeNull();
    expect(table.get("c-1#1")?.turnId).not.toBe("null");
  });

  it("does not create a record for a terminal frame with nothing to fill", () => {
    const table = createTurnTable();

    const late = table.ingest(finished(1, "t-1"));

    expect(late.effect).toBe("ignored");
    expect(table.turns()).toHaveLength(0);
    expect(table.stats().lateCompletions).toBe(1);
  });
});

describe("one turn may span several runs", () => {
  it("joins the continuation under a new run id into the same turn", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));
    table.ingest(stopped(2, "requires_approval", "local-run-1"));

    // The user approved, and the engine continued the same turn in a new run.
    table.ingest(delta(3, "local-run-2"));
    table.ingest(stopped(4, "end_turn", "local-run-2"));

    expect(table.turns()).toHaveLength(1);
    expect(table.turns()[0]?.turnRef).toBe("c-1#1");
    // The run a turn started in, not the one it happened to end in.
    expect(table.turns()[0]?.runId).toBe("local-run-1");
    expect(table.turns()[0]?.open).toBe(false);
  });

  it("files the usage report of either run against that one turn", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1"));
    table.ingest(stopped(2, "requires_approval", "local-run-1"));
    table.ingest(delta(3, "local-run-2"));

    // A usage report arrives only after the pause; the turn it belongs to is the
    // one in flight, whichever run reported it.
    table.ingest({
      ...base(4),
      kind: "usage.reported",
      runId: "local-run-2",
      usage: USAGE,
      authorAgentId: "agent-a",
      runtimeAgentId: "agent-a",
    });

    expect(table.turns()).toHaveLength(1);
    expect(table.get("c-1#1")?.usage).toEqual(USAGE);
  });
});

describe("a subagent's turn closes but is not the reader's", () => {
  it("closes on its own end_turn and says which line it came from", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-7"));
    table.ingest(delta(2, "local-run-7", { conversationId: "c-1", subagentId: "sub-1" }));

    expect(table.turns()).toHaveLength(2);

    const closed = table.ingest(
      stopped(3, "end_turn", "local-run-7", { conversationId: "c-1", subagentId: "sub-1" }),
    );

    expect(closed.effect).toBe("closed");
    expect(table.turns()).toHaveLength(2);

    const subagentTurn = table.turns().find((record) => record.agentKind === "subagent");

    expect(subagentTurn?.turnRef).toBe("c-1#2");
    expect(subagentTurn?.open).toBe(false);
    expect(subagentTurn === undefined ? null : isCountedTurn(subagentTurn)).toBe(false);

    // The main line's turn is untouched and still open.
    const mainTurn = table.openTurn("c-1");

    expect(mainTurn?.turnRef).toBe("c-1#1");
    expect(mainTurn === null ? true : isCountedTurn(mainTurn)).toBe(true);

    expect(table.stats().endTurns.main).toBe(0);
    expect(table.stats().endTurns.subagent).toBe(1);
  });
});

describe("a repeated run id does not merge two conversations", () => {
  it("closes only the conversation whose turn ended", () => {
    const table = createTurnTable();

    // The run counter is per instance, so both conversations have used local-run-1.
    table.ingest(delta(1, "local-run-1", { conversationId: "c-1" }));
    table.ingest(delta(2, "local-run-1", { conversationId: "c-2" }));

    expect(table.turns()).toHaveLength(2);
    expect(table.turns().map((record) => record.turnRef)).toEqual(["c-1#1", "c-2#1"]);

    table.ingest(stopped(3, "end_turn", "local-run-1", { conversationId: "c-1" }));

    expect(table.openTurn("c-1")).toBeNull();
    expect(table.openTurn("c-2")?.turnRef).toBe("c-2#1");
    expect(table.turns()).toHaveLength(2);

    table.ingest(stopped(4, "end_turn", "local-run-1", { conversationId: "c-2" }));

    expect(table.openTurn("c-2")).toBeNull();
    // Each conversation numbers its own turns, so both are `#1`.
    expect(table.turns().map((record) => record.turnRef)).toEqual(["c-1#1", "c-2#1"]);
  });

  it("numbers the next turn of one conversation without disturbing its neighbour", () => {
    const table = createTurnTable();

    table.ingest(delta(1, "local-run-1", { conversationId: "c-1" }));
    table.ingest(stopped(2, "end_turn", "local-run-1", { conversationId: "c-1" }));
    table.ingest(delta(3, "local-run-1"));

    expect(table.turns().map((record) => record.turnRef)).toEqual(["c-1#1", "c-1#2"]);
    expect(table.openTurn("c-2")).toBeNull();
  });
});

describe("the table is bounded and counts what it cannot place", () => {
  it("evicts the oldest closed record and reports it", () => {
    const table = createTurnTable({ limit: 2 });

    for (let index = 0; index < 4; index += 1) {
      table.ingest(delta(index * 2 + 1, "local-run-1"));
      table.ingest(stopped(index * 2 + 2, "end_turn", "local-run-1"));
    }

    expect(table.turns()).toHaveLength(2);
    expect(table.turns().map((record) => record.turnRef)).toEqual(["c-1#3", "c-1#4"]);
    expect(table.stats().evicted).toBe(2);
    expect(table.stats().opened).toBe(4);
  });

  it("drops a change it cannot read and one that names no turn, without throwing", () => {
    const table = createTurnTable();

    const usageFirst = table.ingest({
      ...base(1),
      kind: "usage.reported",
      runId: null,
      usage: USAGE,
      authorAgentId: "agent-a",
      runtimeAgentId: "agent-a",
    });

    expect(usageFirst.effect).toBe("ignored");
    expect(table.turns()).toHaveLength(0);
    expect(table.stats().unmatched).toBe(1);

    const unreadable = table.ingest({ ...base(2), kind: "turn.finished" } as MergerChange);

    expect(unreadable.effect).toBe("ignored");
    expect(table.stats().dropped).toBe(1);

    // Content with no turn to belong to: counted, and it does not invent a turn.
    const orphan = table.ingestContent("c-9", {
      messageId: "m-9",
      upserts: [{ id: "b-9" }],
      removes: [],
    });

    expect(orphan.effect).toBe("ignored");
    expect(table.turns()).toHaveLength(0);
    expect(table.stats().unmatched).toBe(2);
  });

  it("names its default bound so a caller can reason about it", () => {
    expect(TURN_TABLE_LIMIT).toBeGreaterThan(0);
    expect(createTurnTable().stats()).toMatchObject({ turns: 0, open: 0, evicted: 0 });
  });
});
