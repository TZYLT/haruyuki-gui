/**
 * Tests for the content model facade.
 *
 * These pin the contract the conversation store leans on: one assistant stream
 * grows one ordered block set, tool calls and reasoning pair across messages,
 * a reset removes the old ids and a resend rebuilds the same ones, `release`
 * gives memory back, the in-flight tables stay bounded with visible counters,
 * and malformed payloads damage only themselves. Every case feeds real merger
 * change objects, because the facade's job is to dispatch them, not to invent
 * a second input shape.
 */

import type {
  Block,
  CodeBlock,
  ContentUpdate,
  ReasoningBlock,
  UnknownBlock,
} from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { AssistantPart, MergerChange } from "../merge/types.js";
import { createContentModel } from "./model.js";
import type { SourceMessage } from "./types.js";

type Delta = Extract<MergerChange, { kind: "message.delta" }>;
type Final = Extract<MergerChange, { kind: "message.final" }>;
type Complete = Extract<MergerChange, { kind: "message.complete" }>;
type Reset = Extract<MergerChange, { kind: "message.reset" }>;
type Finished = Extract<MergerChange, { kind: "turn.finished" }>;

const AT = 1_700_000_000_000;

const IMAGE: AssistantPart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

function base() {
  return {
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId: "conv-1",
    at: AT,
  };
}

function delta(
  messageId: string,
  text: string,
  options: {
    parts?: readonly AssistantPart[];
    runId?: string | null;
    runSeq?: number;
    first?: boolean;
  } = {},
): Delta {
  return {
    ...base(),
    kind: "message.delta",
    messageId,
    runId: options.runId === undefined ? "run-1" : options.runId,
    runSeq: options.runSeq ?? 1,
    text,
    parts: options.parts ?? [],
    first: options.first ?? false,
  };
}

function final(
  messageId: string,
  messageType: string,
  body: unknown,
  runId: string | null = "run-1",
): Final {
  return {
    ...base(),
    kind: "message.final",
    messageId,
    runId,
    messageType,
    body,
  };
}

function complete(messageId: string): Complete {
  return {
    ...base(),
    kind: "message.complete",
    messageId,
    runId: "run-1",
    textLength: 0,
    incomplete: false,
  };
}

function resetChange(messageId: string): Reset {
  return {
    ...base(),
    kind: "message.reset",
    messageId,
    runId: "run-1",
    reason: "resend-from-start",
  };
}

function turnFinished(runId: string | null): Finished {
  return {
    ...base(),
    kind: "turn.finished",
    turnId: "turn-1",
    runId,
    stopReason: "end_turn",
    usage: null,
    incomplete: false,
  };
}

function blocksOf(updates: readonly ContentUpdate[]): readonly Block[] {
  return updates.flatMap((update) => update.upserts);
}

function typed<T extends Block["type"]>(
  block: Block | undefined,
  type: T,
): Extract<Block, { type: T }> {
  if (block === undefined) {
    throw new Error(`expected a ${type} block, got nothing`);
  }
  if (block.type !== type) {
    throw new Error(`expected a ${type} block, got ${block.type}`);
  }
  return block as Extract<Block, { type: T }>;
}

function onlyBlock(updates: readonly ContentUpdate[]): Block {
  const blocks = blocksOf(updates);
  expect(blocks).toHaveLength(1);
  return blocks[0] as Block;
}

describe("streamed text", () => {
  it("grows one text block across deltas and completes it", () => {
    const model = createContentModel();

    // A partial line is buffered by the fence scanner, so nothing is shown yet.
    expect(model.ingest(delta("m1", "Hel"))).toEqual([]);

    const first = model.ingest(delta("m1", "lo\n"));
    expect(first).toHaveLength(1);
    expect(first[0]?.messageId).toBe("m1");
    expect(first[0]?.removes).toEqual([]);

    const streaming = typed(blocksOf(first)[0], "text");
    expect(streaming.id).toBe("m1:text:0");
    expect(streaming.text).toBe("Hello\n");
    expect(streaming.status).toBe("streaming");

    const second = model.ingest(delta("m1", " world\n", { runSeq: 2 }));
    const grown = typed(onlyBlock(second), "text");
    expect(grown.id).toBe("m1:text:0");
    expect(grown.text).toBe("Hello\n world\n");

    const done = model.ingest(complete("m1"));
    expect(done).toHaveLength(1);
    expect(done[0]?.messageId).toBe("m1");
    const finished = typed(onlyBlock(done), "text");
    expect(finished.id).toBe("m1:text:0");
    expect(finished.status).toBe("complete");
    expect(finished.text).toBe("Hello\n world\n");
    expect(model.stats().inFlightMessages).toBe(1);
  });

  it("keeps text, code and text in source order with stable ids", () => {
    const model = createContentModel();

    const before = model.ingest(delta("m2", "before\n"));
    expect(blocksOf(before).map((block) => block.id)).toEqual(["m2:text:0"]);

    const opened = model.ingest(delta("m2", "```ts\n"));
    expect(blocksOf(opened).map((block) => block.type)).toEqual(["code"]);
    expect(blocksOf(opened).map((block) => block.id)).toEqual(["m2:code:0"]);

    model.ingest(delta("m2", "const x = 1;\n"));
    model.ingest(delta("m2", "```\n"));
    const after = model.ingest(delta("m2", "after\n"));
    expect(blocksOf(after).map((block) => block.id)).toEqual(["m2:text:1"]);

    const done = blocksOf(model.ingest(complete("m2")));
    expect(done.map((block) => block.id)).toEqual(["m2:text:0", "m2:code:0", "m2:text:1"]);
    expect(done.map((block) => block.type)).toEqual(["text", "code", "text"]);

    expect(typed(done[0], "text").text).toBe("before\n");
    const code = typed(done[1], "code") as CodeBlock;
    expect(code.text).toBe("const x = 1;\n");
    expect(code.closed).toBe(true);
    expect(code.status).toBe("complete");
    expect(typed(done[2], "text").text).toBe("after\n");
  });

  it("keeps an image part in source order after the prose", () => {
    const model = createContentModel();

    model.ingest(delta("m3", "look:\n"));
    const updates = model.ingest(
      delta("m3", "", {
        parts: [{ type: "text", text: "look:\n" }, IMAGE],
      }),
    );

    const image = typed(onlyBlock(updates), "image");
    expect(image.id).toBe("m3:image:0");
    expect(image.messageId).toBe("m3");
    expect(image.alt).toBeNull();
    expect(image.source).toEqual({
      kind: "base64",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });

    const done = blocksOf(model.ingest(complete("m3")));
    expect(done.map((block) => block.type)).toEqual(["text"]);
    expect(typed(done[0], "text").status).toBe("complete");
  });
});

describe("tools", () => {
  it("folds a call and its returns into one block under the first message", () => {
    const model = createContentModel();

    const started = model.ingest(
      final("m-start", "client_tool_start", {
        tool_call: { tool_call_id: "call-1", name: "read", tool_args: '{"path":"a.txt"}' },
      }),
    );
    const start = typed(onlyBlock(started), "tool_call");
    expect(start.id).toBe("tool:call-1");
    expect(start.status).toBe("running");
    expect(start.argumentsText).toBe('{"path":"a.txt"}');

    // A result before the client end marker is only an interim snapshot.
    const interim = model.ingest(
      final("m-ret-1", "tool_return_message", {
        tool_call_id: "call-1",
        status: "success",
        tool_return: { stage: 1 },
      }),
    );
    const snapshot = typed(onlyBlock(interim), "tool_call");
    expect(snapshot.id).toBe("tool:call-1");
    expect(snapshot.status).toBe("running");
    expect(snapshot.result).toEqual({ stage: 1 });

    // The end marker records state but changes nothing a surface can see.
    expect(
      model.ingest(
        final("m-end", "client_tool_end", { tool_call_id: "call-1", status: "success" }),
      ),
    ).toEqual([]);

    const closed = model.ingest(
      final("m-ret-2", "tool_return_message", {
        tool_call_id: "call-1",
        status: "success",
        tool_return: { stage: 2 },
      }),
    );
    const finished = typed(onlyBlock(closed), "tool_call");
    expect(finished.id).toBe("tool:call-1");
    expect(finished.messageId).toBe("m-start");
    expect(finished.status).toBe("success");
    expect(finished.result).toEqual({ stage: 2 });

    const seen = [...started, ...interim, ...closed].flatMap((update) => update.upserts);
    expect(new Set(seen.map((block) => block.id))).toEqual(new Set(["tool:call-1"]));
    expect(seen.every((block) => block.messageId === "m-start")).toBe(true);
  });

  it("appends argument fragments into the same running call", () => {
    const model = createContentModel();

    const first = model.ingest(
      final("m-frag-1", "tool_call_message", {
        tool_call: { tool_call_id: "frag-1", name: "write", arguments: '{"a"' },
      }),
    );
    expect(typed(onlyBlock(first), "tool_call").argumentsText).toBe('{"a"');

    const second = model.ingest(
      final("m-frag-2", "tool_call_message", {
        tool_call: { tool_call_id: "frag-1", arguments: ":1}" },
      }),
    );
    const block = typed(onlyBlock(second), "tool_call");
    expect(block.id).toBe("tool:frag-1");
    expect(block.messageId).toBe("m-frag-1");
    expect(block.name).toBe("write");
    expect(block.argumentsText).toBe('{"a":1}');
    expect(block.status).toBe("running");
  });

  it("keeps an orphan result instead of dropping it", () => {
    const model = createContentModel();

    const updates = model.ingest(
      final("m-orphan", "tool_return_message", {
        tool_call_id: "lost-1",
        status: "error",
        tool_return: { bad: true, fn: () => 1 },
      }),
    );
    const block = typed(onlyBlock(updates), "tool_call");
    expect(block.id).toBe("tool:lost-1");
    expect(block.orphan).toBe(true);
    expect(block.name).toBeNull();
    expect(block.argumentsText).toBe("");
    expect(block.status).toBe("error");
    expect(block.result).toEqual({ bad: true });
    expect(model.stats().orphanTools).toBe(1);
  });

  it("marks a run's open calls incomplete and forgets its messages", () => {
    const model = createContentModel();

    model.ingest(delta("m-run", "working\n", { runId: "run-9" }));
    model.ingest(
      final(
        "m-tool",
        "tool_call_message",
        { tool_call: { tool_call_id: "call-9", name: "read", arguments: "{}" } },
        "run-9",
      ),
    );
    expect(model.stats().inFlightMessages).toBe(1);
    expect(model.stats().inFlightToolCalls).toBe(1);

    const updates = model.ingest(turnFinished("run-9"));
    const block = typed(onlyBlock(updates), "tool_call");
    expect(block.id).toBe("tool:call-9");
    expect(block.status).toBe("incomplete");
    expect("turnId" in block).toBe(false);
    expect(model.stats().inFlightMessages).toBe(0);
    expect(model.stats().inFlightToolCalls).toBe(0);

    // The state was kept, so a later return still replaces the corner mark.
    const late = model.ingest(
      final(
        "m-late",
        "tool_return_message",
        { tool_call_id: "call-9", status: "success", tool_return: "done" },
        "run-9",
      ),
    );
    const recovered = typed(onlyBlock(late), "tool_call");
    expect(recovered.status).toBe("success");
    expect(recovered.result).toBe("done");
  });

  it("stops building new calls at the per-message cap and counts them", () => {
    const model = createContentModel();
    let created = 0;

    for (let index = 0; index < 300; index += 1) {
      const updates = model.ingest(
        final("m-tools", "tool_call_message", {
          tool_call: { tool_call_id: `call-${index}`, name: "t", arguments: "{}" },
        }),
      );
      created += blocksOf(updates).length;
    }

    expect(created).toBe(256);
    expect(model.stats().truncatedTools).toBe(44);
    expect(model.stats().inFlightToolCalls).toBe(256);
  });
});

describe("reasoning", () => {
  it("aggregates fragments by sequence and names the parent message", () => {
    const model = createContentModel();

    const one = model.ingest(
      final("asst-1:reasoning:2", "reasoning_message", { reasoning: "b", seq_id: 1 }),
    );
    const first = typed(onlyBlock(one), "reasoning") as ReasoningBlock;
    expect(first.id).toBe("asst-1:reasoning:2");
    expect(first.messageId).toBe("asst-1");
    expect(first.text).toBe("b");

    const two = model.ingest(
      final("asst-1:reasoning:2", "reasoning_message", { reasoning: "a", seq_id: 0 }),
    );
    expect(typed(onlyBlock(two), "reasoning").text).toBe("ab");

    const duplicate = model.ingest(
      final("asst-1:reasoning:2", "reasoning_message", { reasoning: "a", seq_id: 0 }),
    );
    expect(duplicate).toEqual([]);
  });

  it("produces no block for agent-only or malformed reasoning", () => {
    const model = createContentModel();

    expect(
      model.ingest(final("r-hidden", "hidden_reasoning_message", { reasoning: "secret" })),
    ).toEqual([]);
    expect(model.ingest(final("r-1", "reasoning_message", { reasoning: 42 }))).toEqual([]);
    expect(model.ingest(final("r-2", "reasoning_message", { reasoning: "" }))).toEqual([]);
    expect(model.ingest(final("r-3", "assistant_message", { reasoning: "x" }))).toEqual([]);
  });
});

describe("reset and release", () => {
  it("reports the ids a message reset removes and rebuilds them on resend", () => {
    const model = createContentModel();

    const first = blocksOf(model.ingest(delta("m1", "first\n")));
    expect(first.map((block) => block.id)).toEqual(["m1:text:0"]);

    const removes = model.ingest(resetChange("m1"));
    expect(removes).toEqual([{ messageId: "m1", upserts: [], removes: ["m1:text:0"] }]);
    expect(model.stats().inFlightMessages).toBe(0);

    const rebuilt = typed(onlyBlock(model.ingest(delta("m1", "again\n"))), "text");
    expect(rebuilt.id).toBe("m1:text:0");
    expect(rebuilt.text).toBe("again\n");
    expect(model.stats().inFlightMessages).toBe(1);
  });

  it("drops the assembly state on release and rebuilds identical ids", () => {
    const model = createContentModel();

    model.ingest(delta("m-rel", "hello\n"));
    expect(model.stats().inFlightMessages).toBe(1);

    model.release("m-rel");
    expect(model.stats().inFlightMessages).toBe(0);
    model.release("m-rel");

    const rebuilt = typed(onlyBlock(model.ingest(delta("m-rel", "again\n"))), "text");
    expect(rebuilt.id).toBe("m-rel:text:0");
    expect(rebuilt.text).toBe("again\n");
  });

  it("releases finished calls but keeps a call whose result has not arrived", () => {
    const model = createContentModel();

    model.ingest(
      final("m-call", "tool_call_message", {
        tool_call: { tool_call_id: "call-rel", name: "read", arguments: "{}" },
      }),
    );
    model.ingest(
      final("m-ret", "tool_return_message", {
        tool_call_id: "call-rel",
        status: "success",
        tool_return: "ok",
      }),
    );
    model.release("m-call");

    // The finished call is gone, so a late result becomes an orphan block.
    const late = model.ingest(
      final("m-ret-2", "tool_return_message", {
        tool_call_id: "call-rel",
        status: "success",
        tool_return: "late",
      }),
    );
    const orphan = typed(onlyBlock(late), "tool_call");
    expect(orphan.orphan).toBe(true);
    expect(orphan.result).toBe("late");

    // An open call survives release, so its eventual result still pairs.
    model.ingest(
      final("m-open", "tool_call_message", {
        tool_call: { tool_call_id: "call-open", name: "wait" },
      }),
    );
    model.release("m-open");
    const kept = model.ingest(
      final("m-open-ret", "tool_return_message", {
        tool_call_id: "call-open",
        status: "success",
        tool_return: "kept",
      }),
    );
    const paired = typed(onlyBlock(kept), "tool_call");
    expect(paired.orphan).toBe(false);
    expect(paired.result).toBe("kept");
  });

  it("clears every table and counter on reset", () => {
    const model = createContentModel();

    model.ingest(delta("m1", "hi\n"));
    model.ingest(
      final("m2", "tool_call_message", {
        tool_call: { tool_call_id: "call-1", name: "t", arguments: "{}" },
      }),
    );
    model.ingest(final("p:reasoning:0", "reasoning_message", { reasoning: "think", seq_id: 0 }));
    expect(model.stats().inFlightMessages).toBe(1);
    expect(model.stats().inFlightToolCalls).toBe(1);

    model.reset();

    expect(model.stats()).toEqual({
      inFlightMessages: 0,
      inFlightToolCalls: 0,
      parsedMessages: 0,
      blocksEmitted: 0,
      unknownBlocks: 0,
      orphanTools: 0,
      overflows: 0,
      truncatedTools: 0,
      lastErrorAt: null,
    });
  });

  it("re-arms reasoning aggregation after reset", () => {
    const model = createContentModel();

    const first = model.ingest(
      final("seg:reasoning:0", "reasoning_message", { reasoning: "first", seq_id: 0 }),
    );
    expect(typed(onlyBlock(first), "reasoning").text).toBe("first");

    model.reset();

    const second = model.ingest(
      final("seg:reasoning:0", "reasoning_message", { reasoning: "second", seq_id: 0 }),
    );
    expect(typed(onlyBlock(second), "reasoning").text).toBe("second");
  });

  it("returns nothing for a complete or reset of an unknown message", () => {
    const model = createContentModel();

    expect(model.ingest(complete("missing"))).toEqual([]);
    expect(model.ingest(resetChange("missing"))).toEqual([]);

    // A buffered message has no blocks yet, so reset removes nothing but still
    // drops the partial line; the next delta starts a fresh block.
    expect(model.ingest(delta("m-buffer", "partial"))).toEqual([]);
    expect(model.ingest(resetChange("m-buffer"))).toEqual([]);
    const rebuilt = typed(onlyBlock(model.ingest(delta("m-buffer", "whole\n"))), "text");
    expect(rebuilt.text).toBe("whole\n");
  });
});

describe("bounds", () => {
  it("keeps the message table bounded and counts overflows", () => {
    const model = createContentModel();

    for (let index = 0; index < 300; index += 1) {
      model.ingest(delta(`m-${index}`, "line\n"));
    }

    const stats = model.stats();
    expect(stats.inFlightMessages).toBe(256);
    expect(stats.overflows).toBe(44);
    expect(stats.blocksEmitted).toBe(300);
  });

  it("evicts the oldest state and lets a later delta rebuild its ids", () => {
    const model = createContentModel({ maxInFlightMessages: 2 });

    model.ingest(delta("a", "x\n"));
    model.ingest(delta("b", "y\n"));
    model.ingest(delta("c", "z\n"));
    expect(model.stats().inFlightMessages).toBe(2);
    expect(model.stats().overflows).toBe(1);

    const rebuilt = typed(onlyBlock(model.ingest(delta("a", "again\n"))), "text");
    expect(rebuilt.id).toBe("a:text:0");
    expect(rebuilt.text).toBe("again\n");
    expect(model.stats().inFlightMessages).toBe(2);
    expect(model.stats().overflows).toBe(2);
  });

  it("falls back to the default bound for an invalid option", () => {
    const model = createContentModel({ maxInFlightMessages: 0 });
    for (let index = 0; index < 257; index += 1) {
      model.ingest(delta(`m-${index}`, "line\n"));
    }
    expect(model.stats().inFlightMessages).toBe(256);
    expect(model.stats().overflows).toBe(1);
  });
});

describe("unknown and malformed input", () => {
  it("degrades an unknown message to one unknown block and keeps its payload", () => {
    const model = createContentModel();

    const updates = model.ingest(
      final("m-unk", "mystery_message", { tag: "x", keep: "y", list: [1, 2] }),
    );
    const block = typed(onlyBlock(updates), "unknown") as UnknownBlock;
    expect(block.id).toBe("m-unk:unknown:0");
    expect(block.rawType).toBe("mystery_message");
    expect(block.raw).toEqual({ tag: "x", keep: "y", list: [1, 2] });
    expect(model.stats().unknownBlocks).toBe(1);
  });

  it("keeps an unknown part in place beside known content", () => {
    const model = createContentModel();
    const part = { type: "other_part", payload: { n: 1 } };

    const updates = model.ingest(
      final("m-user", "user_message", {
        content: [{ type: "text", text: "hello" }, part],
      }),
    );
    const blocks = blocksOf(updates);
    expect(blocks.map((block) => block.type)).toEqual(["text", "unknown"]);
    expect(typed(blocks[0], "text").text).toBe("hello");

    const unknown = typed(blocks[1], "unknown") as UnknownBlock;
    expect(unknown.id).toBe("m-user:unknown:0");
    expect(unknown.rawType).toBe("other_part");
    expect(unknown.raw).toEqual(part);
  });

  it("never throws on a malformed body and damages only its own message", () => {
    const model = createContentModel();

    expect(model.ingest(final("bad-1", "reasoning_message", "not-an-object"))).toEqual([]);
    expect(model.ingest(final("bad-2", "tool_call_message", "not json"))).toEqual([]);

    const errorUpdate = model.ingest(final("bad-3", "error_message", null));
    const error = typed(onlyBlock(errorUpdate), "error");
    expect(error.message).toBe("");
    expect(error.errorType).toBeNull();
    expect(error.detail).toBeNull();

    expect(model.ingest(final("bad-4", "assistant_message", { content: 42 }))).toEqual([]);
    expect(model.ingest(turnFinished("run-missing"))).toEqual([]);

    const stillWorks = typed(onlyBlock(model.ingest(delta("bad-5", "fine\n"))), "text");
    expect(stillWorks.text).toBe("fine\n");
    expect(model.stats().lastErrorAt).toBeNull();
  });

  it("keeps markup verbatim and cleans functions out of raw payloads", () => {
    const model = createContentModel();

    const scripted = typed(
      onlyBlock(model.ingest(delta("m-script", "<script>alert(1)</script>\n"))),
      "text",
    );
    expect(scripted.text).toBe("<script>alert(1)</script>\n");
    expect(JSON.parse(JSON.stringify(scripted))).toEqual(scripted);

    const updates = model.ingest(
      final("m-raw", "mystery_message", {
        tag: "x",
        fn() {
          return 1;
        },
        nested: {
          n: 2,
          bad() {
            return 3;
          },
        },
        list: [1, () => 2, 3],
      }),
    );
    const raw = typed(onlyBlock(updates), "unknown").raw;
    expect(raw).toEqual({ tag: "x", nested: { n: 2 }, list: [1, null, 3] });
    expect(JSON.parse(JSON.stringify(raw))).toEqual(raw);
  });

  it("ignores a repeated delta object instead of appending its text twice", () => {
    const model = createContentModel();
    const change = delta("m-rep", "once\n");

    const first = typed(onlyBlock(model.ingest(change)), "text");
    expect(first.text).toBe("once\n");
    expect(model.ingest(change)).toEqual([]);
  });
});

describe("history path", () => {
  const page: readonly SourceMessage[] = [
    {
      id: "h1",
      messageType: "assistant_message",
      role: "assistant",
      body: { content: "hello\n" },
      runId: null,
      at: null,
    },
    {
      id: "h2",
      messageType: "tool_call_message",
      role: "tool",
      body: {
        tool_call: { tool_call_id: "call-9", name: "read", arguments: '{"p":1}' },
      },
      runId: null,
      at: null,
    },
    {
      id: "h3",
      messageType: "tool_return_message",
      role: "tool",
      body: { tool_call_id: "call-9", status: "success", tool_return: "ok" },
      runId: null,
      at: null,
    },
  ];

  it("parses a page into the same blocks as ingesting its messages", () => {
    const history = createContentModel();
    const blocks = history.parseMessages(page);
    expect(blocks.map((block) => block.type)).toEqual(["text", "tool_call"]);

    const streamed = createContentModel();
    const collected: Block[] = [];
    const positions = new Map<string, number>();

    for (const message of page) {
      const updates = streamed.ingest(
        final(message.id, message.messageType, message.body, message.runId),
      );
      for (const block of blocksOf(updates)) {
        const position = positions.get(block.id);
        if (position === undefined) {
          positions.set(block.id, collected.length);
          collected.push(block);
        } else {
          collected[position] = block;
        }
      }
    }

    expect(collected).toEqual(blocks);
    expect(history.stats().parsedMessages).toBe(3);
    expect(history.stats().blocksEmitted).toBe(2);
  });

  it("keeps no state across pages", () => {
    const model = createContentModel();

    expect(model.parseMessages(page)).toEqual(model.parseMessages(page));
    expect(model.stats().parsedMessages).toBe(6);
    expect(model.stats().blocksEmitted).toBe(4);
    // History parsing does not populate any in-flight table.
    expect(model.stats().inFlightMessages).toBe(0);
    expect(model.stats().inFlightToolCalls).toBe(0);
  });

  it("counts emitted and unknown blocks at the streaming exit too", () => {
    const model = createContentModel();

    model.ingest(delta("m1", "one\ntwo\n"));
    model.ingest(delta("m1", "three\n"));
    model.ingest(complete("m1"));
    expect(model.stats().blocksEmitted).toBe(3);
    expect(model.stats().unknownBlocks).toBe(0);

    model.parseMessages([
      {
        id: "u-x",
        messageType: "mystery_message",
        role: "system",
        body: { content: ["?"] },
        runId: null,
        at: null,
      },
    ]);
    const stats = model.stats();
    expect(stats.parsedMessages).toBe(1);
    expect(stats.blocksEmitted).toBe(4);
    expect(stats.unknownBlocks).toBe(1);
    expect(stats.inFlightMessages).toBe(1);
  });
});
