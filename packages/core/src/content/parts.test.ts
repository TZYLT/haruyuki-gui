/**
 * Tests for non-text part assembly.
 *
 * These pin the contract the model facade leans on: an image keeps its own
 * payload and gets a stable id, anything unrecognised stays visible as an
 * `unknown` block, a revised part replaces its block in place, and the ordinal
 * counters are per type so the block order matches the source order.
 */

import type { Block, ImageBlock, TextBlock, UnknownBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { AssistantPart } from "../merge/types.js";
import { appendText, createMessageState } from "./blocks.js";
import { appendParts, createPartsCursor } from "./parts.js";

const ASSISTANT = {
  id: "msg-1",
  messageType: "assistant_message",
  role: "assistant",
  runId: "run-1",
} as const;

const BASE64_IMAGE: AssistantPart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

const URL_IMAGE: AssistantPart = {
  type: "image",
  source: { type: "url", url: "https://example.test/cat.png" },
};

function newState() {
  return createMessageState(ASSISTANT);
}

function expectImage(block: Block | undefined): ImageBlock {
  if (block === undefined || block.type !== "image") {
    throw new Error(`expected an image block, got ${block?.type ?? "nothing"}`);
  }
  return block;
}

function expectUnknown(block: Block | undefined): UnknownBlock {
  if (block === undefined || block.type !== "unknown") {
    throw new Error(`expected an unknown block, got ${block?.type ?? "nothing"}`);
  }
  return block;
}

function textBlocks(blocks: readonly Block[]): TextBlock[] {
  return blocks.filter((block): block is TextBlock => block.type === "text");
}

describe("images", () => {
  it("turns a base64 part into an image block without touching the bytes", () => {
    const state = newState();
    const changed = appendParts(state, [BASE64_IMAGE], createPartsCursor());

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);

    const image = expectImage(state.blocks[0]);
    expect(image.id).toBe("msg-1:image:0");
    expect(image.messageId).toBe("msg-1");
    expect(image.runId).toBe("run-1");
    expect(image.role).toBe("assistant");
    expect(image.source).toEqual({
      kind: "base64",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(image.alt).toBeNull();
  });

  it("turns a url part into an image block that keeps the url", () => {
    const state = newState();
    appendParts(state, [URL_IMAGE], createPartsCursor());

    const image = expectImage(state.blocks[0]);
    expect(image.source).toEqual({ kind: "url", url: "https://example.test/cat.png" });
    expect(image.alt).toBeNull();
  });

  it("takes alt from alt first, then text, and null when neither exists", () => {
    const state = newState();
    appendParts(
      state,
      [{ ...URL_IMAGE, alt: "a cat" }, { ...URL_IMAGE, text: "from text" }, { ...URL_IMAGE }],
      createPartsCursor(),
    );

    expect(state.blocks.map((block) => expectImage(block).alt)).toEqual([
      "a cat",
      "from text",
      null,
    ]);
  });
});

describe("unknown parts", () => {
  it("keeps an unrecognised part verbatim as an unknown block", () => {
    const state = newState();
    const part: AssistantPart = { type: "audio", data: "AAAA", duration: 3 };

    const changed = appendParts(state, [part], createPartsCursor());

    expect(changed.map((block) => block.id)).toEqual(["msg-1:unknown:0"]);

    const unknown = expectUnknown(state.blocks[0]);
    expect(unknown.rawType).toBe("audio");
    expect(unknown.raw).toBe(part);
    expect(unknown.messageId).toBe("msg-1");
  });

  it("degrades an image without a payload to unknown and keeps the image ordinal free", () => {
    const state = newState();
    const broken: AssistantPart = { type: "image", alt: "broken" };
    appendParts(state, [broken], createPartsCursor());

    const unknown = expectUnknown(state.blocks[0]);
    expect(unknown.rawType).toBe("image");
    expect(unknown.raw).toBe(broken);

    appendParts(state, [BASE64_IMAGE], createPartsCursor());
    expect(expectImage(state.blocks[1]).id).toBe("msg-1:image:0");
  });
});

describe("layout", () => {
  it("counts image and unknown ordinals separately and keeps source order", () => {
    const state = newState();
    appendParts(state, [BASE64_IMAGE, { type: "audio" }, URL_IMAGE], createPartsCursor());

    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:image:0",
      "msg-1:unknown:0",
      "msg-1:image:1",
    ]);
    expect([...state.blockIndex.entries()]).toEqual([
      ["msg-1:image:0", 0],
      ["msg-1:unknown:0", 1],
      ["msg-1:image:1", 2],
    ]);
  });

  it("skips text parts and lets prose after an image open a new text block", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "intro\n");
    appendParts(state, [{ type: "text", text: "intro\n" }, BASE64_IMAGE], cursor);
    appendText(state, "outro\n");

    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:image:0",
      "msg-1:text:1",
    ]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["intro\n", "outro\n"]);
  });

  it("appends a new text part in part order when the caller opts in", () => {
    const state = newState();
    const cursor = createPartsCursor();

    const changed = appendParts(
      state,
      [{ type: "text", text: "intro\n" }, BASE64_IMAGE],
      cursor,
      true,
    );
    appendText(state, "outro\n");

    expect(changed.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:image:0",
      "msg-1:text:1",
    ]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["intro\n", "outro\n"]);
  });

  it("skips reasoning parts without a block or an unknown ordinal", () => {
    const state = newState();
    const cursor = createPartsCursor();
    const reasoning: AssistantPart = { type: "reasoning", reasoning: "thinking" };

    const changed = appendParts(
      state,
      [{ type: "text", text: "hi" }, reasoning, BASE64_IMAGE],
      cursor,
    );

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);
    expect(state.blocks.map((block) => block.type)).toEqual(["image"]);
    expect(cursor.slots[1]).toBeNull();
    expect(state.ordinals.get("unknown")).toBeUndefined();

    appendParts(
      state,
      [{ type: "text", text: "hi" }, reasoning, BASE64_IMAGE, { type: "audio" }],
      cursor,
    );

    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:image:0", "msg-1:unknown:0"]);
  });

  it("records one cursor slot per part position", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendParts(state, [{ type: "text", text: "hi" }, BASE64_IMAGE], cursor);

    expect(cursor.seen).toBe(2);
    expect(cursor.slots[0]).toBeNull();
    expect(cursor.slots[1]?.blockId).toBe("msg-1:image:0");
  });
});

describe("order with buffered prose", () => {
  it("flushes an un-newlined line before a new part", () => {
    const state = newState();
    const cursor = createPartsCursor();

    expect(appendText(state, "hello")).toEqual([]);
    const changed = appendParts(state, [BASE64_IMAGE], cursor);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["hello"]);
    expect(textBlocks(state.blocks)[0]?.status).toBe("streaming");
  });

  it("flushes buffered prose when a prose position becomes a part", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "hello");
    appendParts(state, [{ type: "text", text: "hello" }], cursor);
    const changed = appendParts(state, [BASE64_IMAGE], cursor);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
  });

  it("puts prose appended after a part in a new text block behind it", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "hello");
    appendParts(state, [BASE64_IMAGE], cursor);
    appendText(state, "more\n");

    expect(state.blocks.map((block) => block.id)).toEqual([
      "msg-1:text:0",
      "msg-1:image:0",
      "msg-1:text:1",
    ]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["hello", "more\n"]);
  });

  it("keeps a newline-terminated line ahead of a part and flushes nothing extra", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "hello\n");
    const changed = appendParts(state, [BASE64_IMAGE], cursor);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
    expect(textBlocks(state.blocks).map((block) => block.text)).toEqual(["hello\n"]);
  });

  it("does not flush buffered prose for a revision", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "before\n");
    appendParts(state, [BASE64_IMAGE], cursor);
    expect(appendText(state, "pending tail")).toEqual([]);

    const revised: AssistantPart = {
      ...BASE64_IMAGE,
      source: { type: "base64", media_type: "image/png", data: "REVISED" },
    };
    const changed = appendParts(state, [revised], cursor);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual(["msg-1:text:0", "msg-1:image:0"]);
  });
});

describe("revisions", () => {
  it("replaces a revised part in place under the same id", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendText(state, "before\n");
    appendParts(state, [BASE64_IMAGE], cursor);
    appendText(state, "after\n");

    const idsBefore = state.blocks.map((block) => block.id);
    const revised: AssistantPart = {
      ...BASE64_IMAGE,
      source: { type: "base64", media_type: "image/png", data: "REVISED" },
    };

    const changed = appendParts(state, [revised], cursor);

    expect(changed.map((block) => block.id)).toEqual(["msg-1:image:0"]);
    expect(state.blocks.map((block) => block.id)).toEqual(idsBefore);
    expect(state.blocks).toHaveLength(3);
    expect(expectImage(state.blocks[1]).source).toEqual({
      kind: "base64",
      mediaType: "image/png",
      data: "REVISED",
    });
  });

  it("does not report an unchanged part twice", () => {
    const state = newState();
    const cursor = createPartsCursor();

    appendParts(state, [BASE64_IMAGE], cursor);
    const changed = appendParts(state, [BASE64_IMAGE], cursor);

    expect(changed).toEqual([]);
    expect(state.blocks).toHaveLength(1);
  });
});
