/**
 * Tests for reasoning-segment aggregation.
 *
 * These pin the contract the facade leans on: numbered fragments are rebuilt in
 * `seq_id` order even when they arrive shuffled, a repeated `seq_id` is used
 * once, unnumbered fragments keep arrival order, segments keep the order in
 * which they were first seen, and the block id is derived from the parent
 * assistant message rather than invented.
 */

import type { ReasoningBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import {
  clearReasoning,
  createReasoningAggregator,
  ingestReasoning,
  type ReasoningBlockUpdate,
} from "./reasoning.js";
import type { SourceMessage } from "./types.js";

/** A reasoning source message with the engine's documented body fields. */
function reasoning(
  id: string,
  text: unknown,
  options: {
    readonly seq?: number;
    readonly runId?: string | null;
    readonly messageType?: string;
  } = {},
): SourceMessage {
  const body: Record<string, unknown> = {
    type: "message",
    id,
    message_type: "reasoning_message",
    reasoning: text,
  };

  if (options.seq !== undefined) {
    body.seq_id = options.seq;
  }

  return {
    id,
    messageType: options.messageType ?? "reasoning_message",
    role: "assistant",
    body,
    runId: options.runId === undefined ? "run-1" : options.runId,
    at: null,
  };
}

/** Unwrap an update or fail with a useful message. */
function blockOf(update: ReasoningBlockUpdate | null): ReasoningBlock {
  if (update === null) {
    throw new Error("expected a reasoning update, got null");
  }
  return update.block;
}

describe("fragment order", () => {
  it("sorts numbered fragments by seq_id even when they arrive shuffled", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "third", { seq: 3 }))).text).toBe(
      "third",
    );
    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "first", { seq: 1 }))).text).toBe(
      "firstthird",
    );

    const block = blockOf(ingestReasoning(aggregator, reasoning(id, "second", { seq: 2 })));

    expect(block.text).toBe("firstsecondthird");
    expect(block.id).toBe(id);
    expect(block.messageId).toBe("ui-msg-1");
    expect(block.type).toBe("reasoning");
    expect(block.role).toBe("assistant");
    expect(block.runId).toBe("run-1");
    expect("status" in block).toBe(false);
  });

  it("keeps only the first copy of a repeated seq_id", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    blockOf(ingestReasoning(aggregator, reasoning(id, "one", { seq: 1 })));

    expect(ingestReasoning(aggregator, reasoning(id, "one", { seq: 1 }))).toBeNull();
    // A conflicting retransmission is not allowed to rewrite the paragraph.
    expect(ingestReasoning(aggregator, reasoning(id, "ONE", { seq: 1 }))).toBeNull();

    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "two", { seq: 2 }))).text).toBe(
      "onetwo",
    );
  });

  it("keeps arrival order when fragments have no seq_id", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "second"))).text).toBe("second");
    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "first"))).text).toBe("secondfirst");
  });

  it("joins fragments without inserting a separator", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    blockOf(ingestReasoning(aggregator, reasoning(id, "hel")));
    const block = blockOf(ingestReasoning(aggregator, reasoning(id, "lo")));

    expect(block.text).toBe("hello");
    expect(block.text).toHaveLength("hello".length);
  });

  it("assembles a shuffled stream exactly once per seq_id", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-9:reasoning:0";
    const frames = [
      { seq: 3, text: "c" },
      { seq: 1, text: "a" },
      { seq: 2, text: "b" },
      { seq: 1, text: "a" },
      { seq: 3, text: "c" },
    ];

    let last: ReasoningBlock | null = null;
    for (const frame of frames) {
      const update = ingestReasoning(aggregator, reasoning(id, frame.text, { seq: frame.seq }));
      if (update !== null) {
        last = update.block;
      }
    }

    expect(last?.text).toBe("abc");
    expect(last?.text.length).toBe(3);
  });
});

describe("segments", () => {
  it("orders segments by first appearance, not by segment number", () => {
    const aggregator = createReasoningAggregator();

    const later = blockOf(ingestReasoning(aggregator, reasoning("ui-msg-1:reasoning:5", "five")));
    const earlier = blockOf(ingestReasoning(aggregator, reasoning("ui-msg-1:reasoning:2", "two")));

    expect([later.id, earlier.id]).toEqual(["ui-msg-1:reasoning:5", "ui-msg-1:reasoning:2"]);
    expect([...aggregator.segments.keys()]).toEqual([
      "ui-msg-1:reasoning:5",
      "ui-msg-1:reasoning:2",
    ]);
    expect(later.messageId).toBe("ui-msg-1");
    expect(earlier.messageId).toBe("ui-msg-1");

    const touched = blockOf(
      ingestReasoning(aggregator, reasoning("ui-msg-1:reasoning:5", " more")),
    );

    expect(touched.text).toBe("five more");
    // Touching an older segment does not move it behind the newer one.
    expect([...aggregator.segments.keys()]).toEqual([
      "ui-msg-1:reasoning:5",
      "ui-msg-1:reasoning:2",
    ]);
  });

  it("derives the block id and parent from the reasoning id", () => {
    const aggregator = createReasoningAggregator();

    const normal = blockOf(ingestReasoning(aggregator, reasoning("ui-msg-1:reasoning:4", "plain")));
    expect(normal.id).toBe("ui-msg-1:reasoning:4");
    expect(normal.messageId).toBe("ui-msg-1");

    const colonParent = blockOf(
      ingestReasoning(aggregator, reasoning("a:b:reasoning:7", "nested")),
    );
    expect(colonParent.id).toBe("a:b:reasoning:7");
    expect(colonParent.messageId).toBe("a:b");

    const opaque = blockOf(ingestReasoning(aggregator, reasoning("reasoning-abc", "opaque")));
    expect(opaque.id).toBe("reasoning-abc:reasoning:0");
    expect(opaque.messageId).toBe("reasoning-abc");

    const malformed = blockOf(
      ingestReasoning(aggregator, reasoning("ui-msg-2:reasoning:x", "bad segment")),
    );
    expect(malformed.id).toBe("ui-msg-2:reasoning:x:reasoning:0");
    expect(malformed.messageId).toBe("ui-msg-2:reasoning:x");
  });

  it("starts over after clearReasoning", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    blockOf(ingestReasoning(aggregator, reasoning(id, "one", { seq: 1 })));
    clearReasoning(aggregator);

    expect(aggregator.segments.size).toBe(0);

    const block = blockOf(ingestReasoning(aggregator, reasoning(id, "two", { seq: 1 })));

    expect(block.text).toBe("two");
    expect(aggregator.segments.size).toBe(1);
  });
});

describe("malformed input", () => {
  it("does not create a segment for empty or non-string reasoning", () => {
    const aggregator = createReasoningAggregator();

    expect(ingestReasoning(aggregator, reasoning("r-empty", ""))).toBeNull();
    expect(ingestReasoning(aggregator, reasoning("r-number", 42))).toBeNull();
    expect(
      ingestReasoning(
        aggregator,
        reasoning("r-hidden", "hidden", { messageType: "hidden_reasoning_message" }),
      ),
    ).toBeNull();
    expect(aggregator.segments.size).toBe(0);

    // A later valid frame still works after the rejected ones.
    expect(blockOf(ingestReasoning(aggregator, reasoning("r-empty", "real"))).text).toBe("real");
  });

  it("ignores a non-object body without throwing", () => {
    const aggregator = createReasoningAggregator();
    const message: SourceMessage = {
      id: "ui-msg-1:reasoning:0",
      messageType: "reasoning_message",
      role: "assistant",
      body: null,
      runId: "run-1",
      at: null,
    };

    expect(ingestReasoning(aggregator, message)).toBeNull();
  });

  it("keeps the first known run id and never erases it", () => {
    const aggregator = createReasoningAggregator();
    const id = "ui-msg-1:reasoning:0";

    expect(
      blockOf(ingestReasoning(aggregator, reasoning(id, "a", { runId: null }))).runId,
    ).toBeNull();
    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "b", { runId: "run-2" }))).runId).toBe(
      "run-2",
    );
    expect(blockOf(ingestReasoning(aggregator, reasoning(id, "c", { runId: null }))).runId).toBe(
      "run-2",
    );
  });
});
