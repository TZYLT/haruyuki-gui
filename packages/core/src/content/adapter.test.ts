/**
 * Tests for live adaptation and block orchestration.
 *
 * These pin the contract the model facade leans on: the delta/final shapes are
 * translated without rewriting their fields, one message state accumulates text
 * and parts in source order, a reset reports the ids to remove, and the same
 * content always produces the same block ids -- whether it arrives one
 * character at a time or in one piece, once or twice.
 */

import type { Block, TextBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { AssistantPart } from "../merge/types.js";
import {
  completeMessage,
  createDeltaState,
  createMessageStateFor,
  ingestDelta,
  removedBlockIds,
  resetMessage,
  roleForMessageType,
  toSourceDelta,
  toSourceMessage,
  type MessageDeltaChange,
  type MessageFinalChange,
} from "./adapter.js";
import { contentKey, type MessageState } from "./types.js";

const AT = 1_700_000_000_000;

const IMAGE: AssistantPart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

function textPart(text: string): AssistantPart {
  return { type: "text", text };
}

function deltaChange(options: {
  text: string;
  parts: readonly AssistantPart[];
  messageId?: string;
  runId?: string | null;
  first?: boolean;
  runSeq?: number;
}): MessageDeltaChange {
  return {
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId: "conv-1",
    at: AT,
    kind: "message.delta",
    messageId: options.messageId ?? "msg-1",
    runId: options.runId === undefined ? "run-1" : options.runId,
    runSeq: options.runSeq ?? 1,
    text: options.text,
    parts: options.parts,
    first: options.first ?? false,
  };
}

function finalChange(options: {
  body: unknown;
  messageType?: string;
  messageId?: string | null;
  runId?: string | null;
}): MessageFinalChange {
  return {
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId: "conv-1",
    at: AT,
    kind: "message.final",
    messageId: options.messageId === undefined ? null : options.messageId,
    runId: options.runId === undefined ? "run-1" : options.runId,
    messageType: options.messageType ?? "assistant_message",
    body: options.body,
  };
}

function newState(): MessageState {
  return createMessageStateFor({
    id: "msg-1",
    messageType: "assistant_message",
    role: "assistant",
    body: null,
    runId: "run-1",
    at: null,
  });
}

function expectText(block: Block | undefined): TextBlock {
  if (block === undefined || block.type !== "text") {
    throw new Error(`expected a text block, got ${block?.type ?? "nothing"}`);
  }
  return block;
}

function textOf(state: MessageState): string {
  return state.blocks
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe("translation", () => {
  it("maps a delta change field for field", () => {
    const parts = [textPart("hi")];
    const change = deltaChange({ text: "hi", parts, first: true });

    const delta = toSourceDelta(change);

    expect(delta).toEqual({
      messageId: "msg-1",
      runId: "run-1",
      text: "hi",
      parts,
      first: true,
    });
    expect(delta.parts).toBe(parts);
  });

  it("maps a final message and keeps its body untouched", () => {
    const body = { id: "msg-9", content: "hello" };

    const message = toSourceMessage(
      finalChange({ messageType: "user_message", body, messageId: "msg-9" }),
    );

    expect(message).toEqual({
      id: "msg-9",
      messageType: "user_message",
      role: "user",
      body,
      runId: "run-1",
      at: AT,
    });
    expect(message.body).toBe(body);
  });

  it("gives a final message without an id a stable content key", () => {
    const body = { content: "hello", extra: [1, 2, 3] };

    const first = toSourceMessage(finalChange({ messageType: "user_message", body }));
    const reordered = toSourceMessage(
      finalChange({ messageType: "user_message", body: { extra: [1, 2, 3], content: "hello" } }),
    );
    const other = toSourceMessage(
      finalChange({ messageType: "user_message", body: { content: "bye" } }),
    );

    expect(first.id).toBe(contentKey(body));
    expect(reordered.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
  });

  it("infers the speaker from the message type", () => {
    expect(roleForMessageType("user_message")).toBe("user");
    expect(roleForMessageType("assistant_message")).toBe("assistant");
    expect(roleForMessageType("reasoning_message")).toBe("assistant");
    expect(roleForMessageType("tool_call_message")).toBe("tool");
    expect(roleForMessageType("client_tool_end")).toBe("tool");
    expect(roleForMessageType("error_message")).toBe("system");
    expect(roleForMessageType("something_new")).toBe("system");
  });
});

describe("text and parts", () => {
  it("starts a delta state with the assistant identity and the frame's run", () => {
    const change = deltaChange({ text: "hi\n", parts: [textPart("hi\n")], first: true });

    const state = createDeltaState(change);
    ingestDelta(state, change);

    const block = expectText(state.blocks[0]);
    expect(block.id).toBe("msg-1:text:0");
    expect(block.role).toBe("assistant");
    expect(block.runId).toBe("run-1");
  });

  it("accumulates text across deltas into one block", () => {
    const state = newState();

    const first = ingestDelta(
      state,
      deltaChange({ text: "hello\n", parts: [textPart("hello\n")], first: true }),
    );
    const second = ingestDelta(
      state,
      deltaChange({
        text: "world\n",
        parts: [textPart("hello\n"), textPart("world\n")],
        runSeq: 2,
      }),
    );

    expect(first.map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(second.map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(state.blocks).toHaveLength(1);

    const block = expectText(state.blocks[0]);
    expect(block.id).toBe("msg-1:text:0");
    expect(block.text).toBe("hello\nworld\n");
    expect(block.role).toBe("assistant");
    expect(block.runId).toBe("run-1");
    expect(block.status).toBe("streaming");
  });

  it("opens a new text block for prose that follows an image", () => {
    const state = newState();
    const prose = textPart("before\n");

    ingestDelta(state, deltaChange({ text: "before\n", parts: [prose] }));
    ingestDelta(state, deltaChange({ text: "", parts: [prose, IMAGE] }));
    ingestDelta(
      state,
      deltaChange({ text: "after\n", parts: [prose, IMAGE, textPart("after\n")] }),
    );

    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:image:0",
      "msg-1:text:1",
    ]);
    expect(textOf(state)).toBe("before\nafter\n");
  });

  it("closes the message and reports the completed blocks once", () => {
    const state = newState();
    ingestDelta(state, deltaChange({ text: "hello\n", parts: [textPart("hello\n")] }));

    const closed = completeMessage(state);

    expect(closed.map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(expectText(closed[0]).status).toBe("complete");
    expect(completeMessage(state)).toEqual([]);
  });
});

describe("reset", () => {
  it("reports the removed ids, clears the state and rebuilds on the next delta", () => {
    const state = newState();
    const prose = textPart("one\n");

    ingestDelta(state, deltaChange({ text: "one\n", parts: [prose] }));
    ingestDelta(state, deltaChange({ text: "", parts: [prose, IMAGE] }));

    expect(removedBlockIds(state)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(resetMessage(state)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(state.blocks).toEqual([]);
    expect(state.blockIndex.size).toBe(0);

    const rebuilt = ingestDelta(
      state,
      deltaChange({ text: "again\n", parts: [textPart("again\n")], first: true }),
    );

    expect(rebuilt.map((block) => block.id)).toEqual(["msg-1:text:0"]);
    expect(expectText(state.blocks[0]).text).toBe("again\n");
  });
});

describe("stability", () => {
  const DOCUMENT = "intro\n```ts\nconst a = 1;\n```\noutro\n";

  function feed(state: MessageState, document: string, pattern: readonly number[]): void {
    const parts: AssistantPart[] = [];
    let offset = 0;
    let step = 0;

    while (offset < document.length) {
      const size = pattern[step % pattern.length] ?? 1;
      const chunk = document.slice(offset, offset + size);
      parts.push(textPart(chunk));
      ingestDelta(
        state,
        deltaChange({ text: chunk, parts: [...parts], runSeq: step + 1, first: step === 0 }),
      );
      offset += size;
      step += 1;
    }
  }

  it("produces the same blocks for character-by-character and one-shot input", () => {
    const oneShot = newState();
    ingestDelta(oneShot, deltaChange({ text: DOCUMENT, parts: [textPart(DOCUMENT)], first: true }));

    const perCharacter = newState();
    feed(perCharacter, DOCUMENT, [1]);

    const chunked = newState();
    feed(chunked, DOCUMENT, [1, 2, 3, 5, 7]);

    expect(perCharacter.blocks).toEqual(oneShot.blocks);
    expect(chunked.blocks).toEqual(oneShot.blocks);
    expect(oneShot.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:code:0",
      "msg-1:text:1",
    ]);
  });

  it("produces the same ids when the same frames are replayed", () => {
    const frames = [
      deltaChange({ text: "hello\n", parts: [textPart("hello\n")], first: true }),
      deltaChange({ text: "", parts: [textPart("hello\n"), IMAGE], runSeq: 2 }),
      deltaChange({
        text: "world\n",
        parts: [textPart("hello\n"), IMAGE, textPart("world\n")],
        runSeq: 3,
      }),
    ];

    const run = (): string[] => {
      const state = newState();
      for (const frame of frames) {
        ingestDelta(state, frame);
      }
      return state.blocks.map((block) => block.id);
    };

    expect(run()).toEqual(run());
    expect(run()).toEqual(["msg-1:text:0", "msg-1:image:0", "msg-1:text:1"]);
  });

  it("does not append the same frame object twice", () => {
    const state = newState();
    const frame = deltaChange({
      text: "hello\n",
      parts: [textPart("hello\n")],
      first: true,
    });

    ingestDelta(state, frame);
    const repeated = ingestDelta(state, frame);

    expect(repeated).toEqual([]);
    expect(state.blocks).toHaveLength(1);
    expect(textOf(state)).toBe("hello\n");
  });

  it("appends identical text from two distinct frames", () => {
    const state = newState();
    const parts = [textPart("a")];

    ingestDelta(state, deltaChange({ text: "a", parts, first: true }));
    ingestDelta(state, deltaChange({ text: "a", parts, runSeq: 2 }));
    completeMessage(state);

    expect(textOf(state)).toBe("aa");
    expect(state.blocks).toHaveLength(1);
    expect(expectText(state.blocks[0]).text).toBe("aa");
  });

  it("treats a revised part with unchanged text as an update, not a repeat", () => {
    const state = newState();
    const prose = textPart("hello\n");

    ingestDelta(state, deltaChange({ text: "hello\n", parts: [prose], first: true }));
    ingestDelta(state, deltaChange({ text: "", parts: [prose, IMAGE], runSeq: 2 }));

    const revised: AssistantPart = {
      ...IMAGE,
      source: { type: "base64", media_type: "image/png", data: "REVISED" },
    };
    const changed = ingestDelta(
      state,
      deltaChange({ text: "", parts: [prose, revised], runSeq: 3 }),
    );

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);
    expect(state.blocks).toHaveLength(2);
    expect(textOf(state)).toBe("hello\n");
  });
});
