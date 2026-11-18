/**
 * The block table, proved by the six situations that shape it.
 *
 * Each case fails for a different wrong rule, which is why they are separate
 * tests rather than one long scenario:
 *
 * - an upsert for a known id replaces the object and keeps its first position;
 * - a block nothing places is kept under the orphan ref and counted, not dropped;
 * - every block an update carries reaches the table, none silently skipped;
 * - a remove list takes a block out of the table;
 * - input that cannot be read costs a counted skip and never an exception;
 * - two conversations that each used the same run id do not touch each other.
 *
 * The placement questions are answered by a stub here, so these cases prove this
 * module's own rules. The last suite asks the real turn table the same two
 * questions, which is what proves the seam actually fits.
 */

import { describe, expect, it } from "vitest";

import type { SessionStore } from "@haruyuki/protocol";

import type { TurnRecord } from "./turns.js";
import { createTurnTable } from "./turns.js";
import type { TurnLookup } from "./blocks.js";
import { BLOCK_TABLE_LIMIT, createBlockTable, ORPHAN_TURN_REF } from "./blocks.js";

/** One turn record, with only the fields a placement question reads. */
function turn(turnRef: string, runId: string | null): TurnRecord {
  return {
    turnRef,
    turnId: null,
    runId,
    conversationId: "c-1",
    stopReason: null,
    open: true,
    blocks: [],
    usage: null,
    incomplete: false,
    startedAt: 1,
    finishedAt: null,
    agentKind: "main",
  };
}

/**
 * A lookup that answers from two flat tables instead of a real turn table.
 *
 * The block layer asks two questions, so the stub answers exactly those; a case
 * that needs a different answer overrides the one method it cares about.
 */
function lookupOf(
  byRun: Readonly<Record<string, TurnRecord>> = {},
  byMessage: Readonly<Record<string, TurnRecord>> = {},
): TurnLookup {
  return {
    turnOfRun: (_conversationId, runId) => byRun[runId] ?? null,
    turnOfMessage: (_conversationId, messageId) => byMessage[messageId] ?? null,
  };
}

describe("an upsert replaces the object and keeps the first position", () => {
  it("keeps the block where it first appeared when the same id arrives again", () => {
    const table = createBlockTable({
      turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }),
    });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { blockId: "b-1", runId: "run-1", text: "first" },
        { blockId: "b-2", runId: "run-1", text: "second" },
        { blockId: "b-3", runId: "run-1", text: "third" },
      ],
      removes: [],
    });

    // Same content again: the table is unchanged in both length and order, and
    // no content is reported as lost just because it arrived twice.
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { blockId: "b-1", runId: "run-1", text: "first" },
        { blockId: "b-2", runId: "run-1", text: "second" },
        { blockId: "b-3", runId: "run-1", text: "third" },
      ],
      removes: [],
    });

    expect(table.blockIds()).toEqual(["b-1", "b-2", "b-3"]);
    expect(table.stats().blocks).toBe(3);
    expect(table.stats().orphanBlocks).toBe(0);
    expect(table.get("b-2")?.block).toEqual({ blockId: "b-2", runId: "run-1", text: "second" });

    const firstObject = table.get("b-2");

    // Different content for the middle block: same length, new content, and -
    // the part a set does not prove - the same position.
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ blockId: "b-2", runId: "run-1", text: "rewritten" }],
      removes: [],
    });

    expect(table.blockIds()).toEqual(["b-1", "b-2", "b-3"]);
    expect(table.blocks()).toHaveLength(3);
    expect(table.get("b-2")?.block).toEqual({ blockId: "b-2", runId: "run-1", text: "rewritten" });
    // A replacement hands back a new object, so a page re-renders the block.
    expect(table.get("b-2")).not.toBe(firstObject);
    // Three blocks re-fed once, then one of them rewritten: four replacements.
    // Only the first appearance of an id is not a replacement.
    expect(table.stats().replaced).toBe(4);
  });

  it("replaces a block that arrived under the other id spelling", () => {
    const table = createBlockTable({ turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }) });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ id: "b-1", runId: "run-1", text: "one" }],
      removes: [],
    });
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ blockId: "b-1", runId: "run-1", text: "two" }],
      removes: [],
    });

    expect(table.blockIds()).toEqual(["b-1"]);
    expect(table.get("b-1")?.block).toEqual({ blockId: "b-1", runId: "run-1", text: "two" });
  });
});

describe("a block nothing places is kept, not dropped", () => {
  it("files it under the orphan ref and counts it", () => {
    const table = createBlockTable({ turns: lookupOf() });

    table.ingestContent("c-1", {
      messageId: "m-unknown",
      upserts: [{ blockId: "b-1", text: "nobody knows whose this is" }],
      removes: [],
    });

    expect(table.get("b-1")?.turnRef).toBe(ORPHAN_TURN_REF);
    expect(table.blocks()).toHaveLength(1);
    expect(table.stats().orphanBlocks).toBe(1);

    // The same block again: still one block, and still one counted loss. A
    // counter that grew on a retry would read like more content went astray.
    table.ingestContent("c-1", {
      messageId: "m-unknown",
      upserts: [{ blockId: "b-1", text: "nobody knows whose this is" }],
      removes: [],
    });

    expect(table.blocks()).toHaveLength(1);
    expect(table.stats().orphanBlocks).toBe(1);
  });

  it("prefers the run, then the message, and only then the orphan", () => {
    const table = createBlockTable({
      turns: lookupOf({ "run-1": turn("c-1#2", "run-1") }, { "m-1": turn("c-1#1", null) }),
    });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        // The run wins over the message.
        { blockId: "by-run", runId: "run-1", messageId: "m-1" },
        // No run, but a known message.
        { blockId: "by-message", messageId: "m-1" },
        // The update's own message is the last resort before the orphan.
        { blockId: "by-update-message" },
      ],
      removes: [],
    });

    expect(table.get("by-run")?.turnRef).toBe("c-1#2");
    expect(table.get("by-message")?.turnRef).toBe("c-1#1");
    expect(table.get("by-update-message")?.turnRef).toBe("c-1#1");
    expect(table.stats().orphanBlocks).toBe(0);
  });
});

describe("every block an update carries reaches the table", () => {
  it("keeps all of them when the ids are distinct", () => {
    const table = createBlockTable({ turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }) });

    const upserts = Array.from({ length: 12 }, (_unused, index) => ({
      blockId: `b-${index}`,
      runId: "run-1",
    }));

    table.ingestContent("c-1", { messageId: "m-1", upserts, removes: [] });

    expect(table.blocks()).toHaveLength(upserts.length);
    expect(table.blockIds()).toEqual(upserts.map((upsert) => upsert.blockId));
    expect(table.stats().dropped).toBe(0);
  });
});

describe("a remove list takes a block out of the table", () => {
  it("drops the named ids and leaves the rest in place", () => {
    const table = createBlockTable({ turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }) });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { blockId: "b-1", runId: "run-1" },
        { blockId: "b-2", runId: "run-1" },
      ],
      removes: [],
    });

    table.ingestContent("c-1", { messageId: "m-1", upserts: [], removes: ["b-1"] });

    expect(table.get("b-1")).toBeNull();
    expect(table.blockIds()).toEqual(["b-2"]);
    expect(table.stats().removed).toBe(1);

    // Removing what is not there is an ordinary no-op, not a failure.
    table.ingestContent("c-1", { messageId: "m-1", upserts: [], removes: ["b-9"] });

    expect(table.blockIds()).toEqual(["b-2"]);
    expect(table.stats().removed).toBe(1);
  });
});

describe("input that cannot be read costs a counted skip", () => {
  it("does not throw on a missing id, a non-list, or a block that is not an object", () => {
    const table = createBlockTable({ turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }) });

    // Cast in one place: the point of the case is input the type does not
    // describe, and the producer's shape is still in flight upstream.
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { runId: "run-1" }, // no id at all
        "not a block",
        null,
        ["not", "a", "record"],
        { blockId: "b-ok", runId: "run-1" },
      ],
      removes: [],
    } as unknown as Parameters<SessionStore["ingestContent"]>[1]);

    expect(table.blockIds()).toEqual(["b-ok"]);
    expect(table.stats().dropped).toBe(4);

    // Upserts that is not a list, and a remove list of nonsense: both are
    // ordinary states to survive, because the caller is a socket callback.
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: "not a list",
      removes: [1, null, "b-ok"],
    } as unknown as Parameters<SessionStore["ingestContent"]>[1]);

    expect(table.blocks()).toHaveLength(0);
    expect(table.stats().removed).toBe(1);
  });

  it("never throws when the conversation is unusable", () => {
    const table = createBlockTable({ turns: lookupOf() });

    expect(() =>
      table.ingestContent("", { messageId: "m-1", upserts: [{ blockId: "b-1" }], removes: [] }),
    ).not.toThrow();

    expect(table.blocks()).toHaveLength(0);
    expect(table.stats().dropped).toBe(1);
  });
});

describe("two conversations do not touch each other", () => {
  it("asks the lookup with the conversation the update belongs to", () => {
    const asked: string[] = [];
    const table = createBlockTable({
      turns: {
        turnOfRun: (conversationId, runId) => {
          asked.push(`${conversationId}/${runId}`);

          return null;
        },
        turnOfMessage: () => null,
      },
    });

    table.ingestContent("c-7", {
      messageId: "m-1",
      upserts: [{ blockId: "b-1", runId: "local-run-1" }],
      removes: [],
    });

    expect(asked).toEqual(["c-7/local-run-1"]);
    expect(table.get("b-1")?.turnRef).toBe(ORPHAN_TURN_REF);
  });
});

describe("the table stays bounded", () => {
  it("evicts the oldest block and says how many it dropped", () => {
    const table = createBlockTable({
      turns: lookupOf({ "run-1": turn("c-1#1", "run-1") }),
      limit: 2,
    });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [
        { blockId: "b-1", runId: "run-1" },
        { blockId: "b-2", runId: "run-1" },
      ],
      removes: [],
    });
    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ blockId: "b-3", runId: "run-1" }],
      removes: [],
    });

    expect(table.blockIds()).toEqual(["b-2", "b-3"]);
    expect(table.stats().evicted).toBe(1);
    expect(BLOCK_TABLE_LIMIT).toBeGreaterThan(0);
  });
});

/**
 * The seam, against the real turn table.
 *
 * The stub above proves this module's rules; this suite proves the two questions
 * fit the table the store will actually hand over. It is the case that stays red
 * until the turn table answers them, and green the day it does.
 */
describe("the placement questions fit the real turn table", () => {
  it("finds the turn a message opened", () => {
    const turns = createTurnTable();

    turns.ingest({
      conversationId: "c-1",
      at: 1,
      subagentId: null,
      kind: "message.delta",
      messageId: "m-1",
      runId: "local-run-1",
      runSeq: 1,
      text: "hello",
      parts: [],
      first: true,
      authorAgentId: "agent-a",
      runtimeAgentId: "agent-a",
    } as never);

    const opened = turns.openTurn("c-1");

    expect(opened).not.toBeNull();
    expect(turns.turnOfMessage("c-1", "m-1")?.turnRef).toBe(opened?.turnRef);
    expect(turns.turnOfRun("c-1", "local-run-1")?.turnRef).toBe(opened?.turnRef);

    const table = createBlockTable({ turns });

    table.ingestContent("c-1", {
      messageId: "m-1",
      upserts: [{ blockId: "b-1", runId: "local-run-1", messageId: "m-1" }],
      removes: [],
    });

    expect(table.get("b-1")?.turnRef).toBe(opened?.turnRef);
    expect(table.stats().orphanBlocks).toBe(0);
  });
});
