/**
 * The queue and subagent folds.
 *
 * The first assertion is the one this whole module exists for: a queue frame
 * that still lists an entry its own `removed` list says has left must publish a
 * queue without it. Delete the departure handling and that test goes red with
 * the entry sitting back in the list - the "queued" mark a page draws would
 * never come off, because no later frame mentions the entry again.
 *
 * The rest pins the properties that make the fold safe on a lossy channel:
 * replay is idempotent, the last frame alone lands on the same entity as every
 * frame folded, the engine's order and its `paused` flag survive untouched, and
 * a malformed payload is a code rather than an exception.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { createQueueTable, createSubagentTable, projectQueue, projectSubagents } from "./queue.js";

/** One recorded s2c line. */
type Recorded = { readonly dir?: string; readonly msg?: Record<string, unknown> };

const RECORDINGS = new URL("../../../../fixtures/engine/recordings/", import.meta.url);

/** Every recorded s2c message of one type, in file order. */
function recordedOf(file: string, type: string): Recorded[] {
  const text = readFileSync(new URL(file, RECORDINGS), "utf8");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Recorded)
    .filter((frame) => frame.dir === "s2c" && frame.msg?.["type"] === type);
}

/** The change the merger would have produced for one payload. */
function changeOf(
  kind: "state.queue" | "state.subagents",
  value: unknown,
  conversationId = "conv-1",
): MergerChange {
  return {
    kind,
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId,
    at: 1,
    value,
  };
}

/** One queue entry, with the id and the flag a page reads off it. */
function item(id: string, paused = false): Record<string, unknown> {
  return { id: `row-${id}`, client_message_id: id, kind: "message", content: `body-${id}`, paused };
}

/** One departure record, as the engine sends it. */
function departed(id: string): Record<string, unknown> {
  return { client_message_id: id, disposition: "dequeued" };
}

/** Everything the queue entity exposes, so a diff names the field that moved. */
function entityFields(entity: unknown): Record<string, unknown> {
  const record = entity as Record<string, unknown>;

  return {
    conversationId: record["conversationId"],
    items: record["items"],
    count: record["count"],
  };
}

describe("a departure leaves the queue even when the payload still lists it", () => {
  it("drops the entry the frame names as removed", () => {
    const table = createQueueTable();

    table.apply(changeOf("state.queue", { queue: [item("a"), item("b")], removed: [] }));

    // The engine builds the list before the transition happens, so a frame can
    // name an entry in both fields. The departure is the newer fact.
    const signal = table.apply(
      changeOf("state.queue", { queue: [item("a"), item("b")], removed: [departed("a")] }),
    );

    expect(signal.removed).toEqual(["a"]);
    expect(signal.effect).toBe("applied");
    expect(table.get("conv-1")?.items).toEqual([item("b")]);
    expect(table.get("conv-1")?.count).toBe(1);
  });

  it("applies a departure to the list already held when the frame carries none", () => {
    const table = createQueueTable();

    table.apply(changeOf("state.queue", { queue: [item("a"), item("b")], removed: [] }));

    const signal = table.apply(changeOf("state.queue", { removed: [departed("a")] }));

    expect(signal.effect).toBe("applied");
    expect(table.get("conv-1")?.items).toEqual([item("b")]);
    expect(table.stats().withRemovals).toBe(1);
    expect(table.stats().snapshots).toBe(1);
  });

  it("keeps the engine order and the paused flag of what is left", () => {
    const table = createQueueTable();

    table.apply(
      changeOf("state.queue", {
        queue: [item("c", true), item("a"), item("b", true)],
        removed: [departed("a")],
      }),
    );

    expect(table.get("conv-1")?.items).toEqual([item("c", true), item("b", true)]);
    expect(table.get("conv-1")?.items.map((entry) => entry["client_message_id"])).toEqual([
      "c",
      "b",
    ]);
    expect(table.get("conv-1")?.count).toBe(table.get("conv-1")?.items.length ?? -1);
  });
});

describe("replay and the last frame alone", () => {
  it("lands on the same entity when one payload is fed twice", () => {
    const payload = { queue: [item("a"), item("b")], removed: [departed("a")] };
    const table = createQueueTable();

    const first = table.apply(changeOf("state.queue", payload));
    const second = table.apply(changeOf("state.queue", payload));

    expect(first.effect).toBe("applied");
    expect(second.effect).toBe("applied");
    // A second removal of an entry that is already gone is a no-op, not an error.
    expect(entityFields(table.get("conv-1"))).toEqual({
      conversationId: "conv-1",
      items: [item("b")],
      count: 1,
    });
  });

  it("lands on the same entity whether it folds five frames or only the fifth", () => {
    const frames = [
      { queue: [item("a")], removed: [] },
      { queue: [item("a"), item("b")], removed: [] },
      { queue: [item("a"), item("b"), item("c")], removed: [] },
      { queue: [item("a"), item("b"), item("c")], removed: [departed("b")] },
      { queue: [item("c"), item("a")], removed: [departed("b")] },
    ];
    const all = createQueueTable();
    const lastOnly = createQueueTable();

    for (const frame of frames) {
      all.apply(changeOf("state.queue", frame));
    }

    lastOnly.apply(changeOf("state.queue", frames[frames.length - 1]));

    expect(entityFields(all.get("conv-1"))).toEqual(entityFields(lastOnly.get("conv-1")));
    expect(all.get("conv-1")?.items).toEqual([item("c"), item("a")]);
    expect(all.stats().applied).toBe(5);
    expect(lastOnly.stats().applied).toBe(1);
  });
});

describe("a real recording folds to an empty queue", () => {
  const frames = recordedOf("subagent.jsonl", "update_queue");

  it("ends empty after the dequeued entry is announced", () => {
    const table = createQueueTable();

    for (const frame of frames) {
      table.apply(changeOf("state.queue", frame.msg, "default"));
    }

    expect(frames.length).toBeGreaterThan(0);
    expect(table.get("default")?.items).toEqual([]);
    expect(table.get("default")?.count).toBe(0);
  });

  it("holds the queued entry while it is queued, and only then", () => {
    const queued = frames.filter(
      (frame) =>
        Array.isArray(frame.msg?.["queue"]) && (frame.msg["queue"] as unknown[]).length > 0,
    );

    expect(queued.length).toBeGreaterThan(0);

    const table = createQueueTable();

    table.apply(changeOf("state.queue", queued[0]?.msg, "default"));

    expect(table.get("default")?.items).toHaveLength(1);
    expect(table.get("default")?.items[0]?.["paused"]).toBeUndefined();
  });
});

describe("a subagent list is a snapshot with a closed status set", () => {
  /** One row as the engine sends it. */
  function row(id: string, status: string, tokens = 0): Record<string, unknown> {
    return {
      subagent_id: id,
      subagent_type: "General-purpose",
      status,
      parent_agent_id: "agent-1",
      conversation_id: "conv-1",
      total_tokens: tokens,
      duration_ms: 12,
    };
  }

  it("keeps the four contract statuses and the engine order", () => {
    const table = createSubagentTable();

    table.apply(
      changeOf("state.subagents", {
        subagents: [
          row("s-1", "pending"),
          row("s-2", "running"),
          row("s-3", "completed"),
          row("s-4", "error"),
        ],
      }),
    );

    expect(table.subagents("conv-1")?.map((entity) => entity.status)).toEqual([
      "pending",
      "running",
      "completed",
      "error",
    ]);
    expect(table.stats().unknownStatus).toBe(0);
  });

  it("drops a status outside the set instead of publishing it", () => {
    const table = createSubagentTable();

    table.apply(
      changeOf("state.subagents", {
        subagents: [row("s-1", "running"), row("s-2", "zombie"), row("s-3", "completed")],
      }),
    );

    expect(table.subagents("conv-1")?.map((entity) => entity.subagentId)).toEqual(["s-1", "s-3"]);
    expect(table.stats().unknownStatus).toBe(1);
  });

  it("replaces the list rather than adding to it", () => {
    const table = createSubagentTable();

    table.apply(changeOf("state.subagents", { subagents: [row("s-1", "running", 0)] }));
    table.apply(changeOf("state.subagents", { subagents: [row("s-1", "completed", 9192)] }));

    expect(table.subagents("conv-1")).toEqual([
      {
        subagentId: "s-1",
        parentAgentId: "agent-1",
        conversationId: "conv-1",
        status: "completed",
        totalTokens: 9192,
        durationMs: 12,
        error: null,
      },
    ]);
  });

  it("lands on the same list whether it folds every recording or only the last", () => {
    const frames = recordedOf("subagent.jsonl", "update_subagent_state");
    const all = createSubagentTable();
    const lastOnly = createSubagentTable();

    for (const frame of frames) {
      all.apply(changeOf("state.subagents", frame.msg, "default"));
    }

    lastOnly.apply(changeOf("state.subagents", frames[frames.length - 1]?.msg, "default"));

    expect(all.subagents("default")).toEqual(lastOnly.subagents("default"));
    expect(all.subagents("default")).toEqual([
      {
        subagentId: "subagent-1794661146742-1",
        parentAgentId: "agent-local-6fdb12c0-b2c6-419d-98c6-36fbc983bd31",
        conversationId: "default",
        status: "completed",
        totalTokens: 9192,
        durationMs: 2471,
        error: null,
      },
    ]);
  });
});

describe("a malformed payload is a code, not a throw", () => {
  it.each([
    ["a string where a state belongs", "not an object", "no-payload"],
    ["a list where a state belongs", [1, 2, 3], "no-payload"],
    ["null", null, "no-payload"],
    ["a state with no queue field", { other: true }, "no-payload"],
    ["a queue that is not a list", { queue: "abc", removed: [] }, "wrong-type"],
  ])("refuses %s", (_label, value, problem) => {
    expect(projectQueue(changeOf("state.queue", value))).toEqual({ entity: null, problem });
  });

  it("refuses a payload whose property access throws", () => {
    const hostile = {
      get queue(): unknown {
        throw new Error("a socket payload is not trusted");
      },
    };

    expect(projectQueue(changeOf("state.queue", hostile))).toEqual({
      entity: null,
      problem: "unreadable",
    });
  });

  it("refuses another kind rather than filing it under a queue", () => {
    expect(projectQueue(changeOf("state.subagents", { queue: [], removed: [] })).problem).toBe(
      "not-a-queue-change",
    );
    expect(projectSubagents(changeOf("state.queue", { subagents: [] })).problem).toBe(
      "not-a-subagent-change",
    );
  });

  it("refuses a change with no conversation to file the row under", () => {
    expect(projectQueue(changeOf("state.queue", { queue: [], removed: [] }, "")).problem).toBe(
      "no-conversation",
    );
  });

  it.each([
    ["a missing list", { subagents: undefined }, "no-payload"],
    ["a list that is not a list", { subagents: "abc" }, "wrong-type"],
    ["rows that are not objects", { subagents: [1, "two", null] }, null],
    ["rows with no id", { subagents: [{ status: "running" }] }, null],
  ])("survives %s", (_label, value, problem) => {
    const reading = projectSubagents(changeOf("state.subagents", value));

    expect(reading.problem).toBe(problem);
    expect(reading.entities === null || Array.isArray(reading.entities)).toBe(true);
  });

  it("keeps the last good entity when a later payload is bad", () => {
    const table = createQueueTable();

    table.apply(changeOf("state.queue", { queue: [item("a")], removed: [] }));
    const good = table.get("conv-1");

    const signal = table.apply(changeOf("state.queue", { queue: "abc" }));

    expect(signal.effect).toBe("ignored");
    expect(table.get("conv-1")).toBe(good);
    expect(table.stats().refused).toBe(1);
    expect(table.stats().applied).toBe(1);
  });

  it("counts rows it had to leave out rather than throwing", () => {
    const table = createSubagentTable();

    table.apply(
      changeOf("state.subagents", {
        subagents: [1, null, { status: "running" }, { subagent_id: "s-1" }],
      }),
    );

    expect(table.subagents("conv-1")).toEqual([]);
    expect(table.stats()).toMatchObject({
      applied: 1,
      malformedRows: 2,
      missingId: 1,
      unknownStatus: 1,
    });
  });
});
