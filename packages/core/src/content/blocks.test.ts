/**
 * Tests for text/code block assembly.
 *
 * These pin the contract the model facade will lean on: the order and ids of
 * the blocks a message produces, which blocks a single delta reports, when a
 * block is `streaming` and when it is `complete`, and that a code block which
 * never closed keeps `closed:false` instead of turning back into prose.
 */

import type { Block, CodeBlock, TextBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { appendText, completeMessage, createMessageState } from "./blocks.js";

const ASSISTANT = {
  id: "msg-1",
  messageType: "assistant_message",
  role: "assistant",
  runId: "run-1",
} as const;

function newState() {
  return createMessageState(ASSISTANT);
}

/** Only the text blocks, in order. */
function textBlocks(blocks: readonly Block[]): TextBlock[] {
  return blocks.filter((block): block is TextBlock => block.type === "text");
}

/** Only the code blocks, in order. */
function codeBlocks(blocks: readonly Block[]): CodeBlock[] {
  return blocks.filter((block): block is CodeBlock => block.type === "code");
}

/** The blocks that carry a lifecycle status, in order. */
function streamedBlocks(blocks: readonly Block[]): (TextBlock | CodeBlock)[] {
  return blocks.filter(
    (block): block is TextBlock | CodeBlock => block.type === "text" || block.type === "code",
  );
}

describe("layout", () => {
  it("lays out prose, code and prose with per-type ordinals", () => {
    const state = newState();
    const changed = appendText(state, "intro\n```ts\nconst a = 1;\n```\noutro\n");

    expect(changed.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:code:0",
      "msg-1:text:1",
    ]);
    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:code:0",
      "msg-1:text:1",
    ]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["intro\n", "outro\n"]);
    expect(textBlocks(state.blocks).map((block) => block.flavor)).toEqual(["markdown", "markdown"]);

    const [code] = codeBlocks(state.blocks);
    expect(code?.info).toBe("ts");
    expect(code?.text).toBe("const a = 1;\n");
    expect(code?.closed).toBe(true);
  });

  it("stamps every block with the message identity", () => {
    const state = newState();
    const [block] = appendText(state, "hello\n");

    expect(block?.messageId).toBe("msg-1");
    expect(block?.runId).toBe("run-1");
    expect(block?.role).toBe("assistant");
    expect(block?.id).toBe("msg-1:text:0");
  });

  it("carries a user message's role and a null run id", () => {
    const state = createMessageState({
      id: "user-1",
      messageType: "user_message",
      role: "user",
      runId: null,
    });
    appendText(state, "hello\n");
    const [block] = state.blocks;

    expect(block?.id).toBe("user-1:text:0");
    expect(block?.role).toBe("user");
    expect(block?.runId).toBeNull();
  });

  it("gives each code block its own ordinal", () => {
    const state = newState();
    appendText(state, "```\none\n```\n```\ntwo\n```\n");

    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:code:0", "msg-1:code:1"]);
    expect(codeBlocks(state.blocks).map((block) => block.text)).toEqual(["one\n", "two\n"]);
    expect(codeBlocks(state.blocks).every((block) => block.closed)).toBe(true);
  });

  it("keeps text ordinals increasing across several fences", () => {
    const state = newState();
    appendText(state, "one\n```\na\n```\ntwo\n```\nb\n```\nthree\n");

    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:code:0",
      "msg-1:text:1",
      "msg-1:code:1",
      "msg-1:text:2",
    ]);
  });

  it("records each block's position", () => {
    const state = newState();
    appendText(state, "a\n```\nb\n```\nc\n");

    expect([...state.blockIndex.entries()]).toEqual([
      ["msg-1:text:0", 0],
      ["msg-1:code:0", 1],
      ["msg-1:text:1", 2],
    ]);
  });

  it("starts ordinals from zero in every message", () => {
    const first = newState();
    const second = newState();
    appendText(first, "a\n");
    appendText(second, "b\n");

    expect(first.blocks[0]?.id).toBe("msg-1:text:0");
    expect(second.blocks[0]?.id).toBe("msg-1:text:0");
  });
});

describe("deltas", () => {
  it("reports only the blocks a delta changed", () => {
    const state = newState();

    expect(appendText(state, "alpha\n").map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(appendText(state, "beta\n").map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(appendText(state, "gamma")).toEqual([]);
    expect(appendText(state, "")).toEqual([]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["alpha\nbeta\n"]);
  });

  it("updates the open text block in place instead of appending one", () => {
    const state = newState();
    appendText(state, "alpha\n");
    const before = state.blocks[0];

    appendText(state, "beta\n");
    const after = state.blocks[0];

    expect(state.blocks).toHaveLength(1);
    expect(after).not.toBe(before);
    expect(after?.id).toBe(before?.id);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["alpha\nbeta\n"]);
  });

  it("does not emit a text block before the first line ends", () => {
    const state = newState();

    expect(appendText(state, "partial")).toEqual([]);
    expect(state.blocks).toEqual([]);
  });
});

describe("status", () => {
  it("keeps text and code streaming while the message is open", () => {
    const state = newState();
    appendText(state, "a\n```ts\nb\n```\n");

    expect(streamedBlocks(state.blocks).map((block) => block.status)).toEqual([
      "streaming",
      "streaming",
    ]);
  });

  it("marks a closed code block complete but leaves its closed flag alone", () => {
    const state = newState();
    appendText(state, "```ts\nx\n```\n");

    const changed = completeMessage(state);
    const [code] = codeBlocks(state.blocks);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:code:0"]);
    expect(changed.every((block) => block.type !== "text")).toBe(true);
    expect(code?.status).toBe("complete");
    expect(code?.closed).toBe(true);
    expect(code?.text).toBe("x\n");
  });

  it("completes an unterminated code block with closed false", () => {
    const state = newState();
    appendText(state, "```ts\nlet x = 1;\n");
    const [open] = codeBlocks(state.blocks);

    expect(open?.status).toBe("streaming");
    expect(open?.closed).toBe(false);

    const changed = completeMessage(state);
    const [done] = codeBlocks(state.blocks);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:code:0"]);
    expect(done?.status).toBe("complete");
    expect(done?.closed).toBe(false);
    expect(done?.text).toBe("let x = 1;\n");
    expect(state.fence.closed).toBe(false);
  });

  it("flushes the tail line at close and marks it complete", () => {
    const state = newState();

    expect(appendText(state, "tail without newline")).toEqual([]);
    const changed = completeMessage(state);
    const [text] = textBlocks(state.blocks);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(text?.text).toBe("tail without newline");
    expect(text?.status).toBe("complete");
  });

  it("flushes an unterminated code tail at close", () => {
    const state = newState();
    appendText(state, "```\nabc");

    completeMessage(state);
    const [code] = codeBlocks(state.blocks);

    expect(code?.text).toBe("abc");
    expect(code?.closed).toBe(false);
    expect(code?.status).toBe("complete");
  });

  it("reports every block it completes, in order", () => {
    const state = newState();
    appendText(state, "a\n```\nb\n```\nc\n");

    const changed = completeMessage(state);

    expect(changed.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:code:0",
      "msg-1:text:1",
    ]);
    expect(
      state.blocks.every((block) => block.type !== "text" || block.status === "complete"),
    ).toBe(true);
  });

  it("is idempotent", () => {
    const state = newState();
    appendText(state, "```\nx\n");
    completeMessage(state);

    expect(completeMessage(state)).toEqual([]);
  });

  it("returns nothing for an empty message", () => {
    const state = newState();

    expect(completeMessage(state)).toEqual([]);
    expect(state.blocks).toEqual([]);
  });
});
