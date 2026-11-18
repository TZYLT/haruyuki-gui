/**
 * Tests for the JSON-safety exit gate.
 *
 * These pin the three promises the module makes, and the ways they can break:
 *
 * 1. cleaning is not escaping -- a payload that contains markup must come out
 *    with the same characters, otherwise the author's text is corrupted;
 * 2. cleaning is total -- values JSON cannot represent disappear without making
 *    the surrounding block unstringifiable, and a cycle is cut instead of
 *    recursing forever;
 * 3. cleaning is shape-preserving -- every block type keeps its fields (and its
 *    `type`/`status`) and survives a JSON round trip deep-equal.
 */

import type {
  Block,
  CodeBlock,
  ContentUpdate,
  ErrorBlock,
  ImageBlock,
  NoticeBlock,
  ReasoningBlock,
  TextBlock,
  ToolCallBlock,
  UnknownBlock,
} from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { sanitizeBlock, sanitizeUpdate, toJsonSafe } from "./sanitize.js";

const SCRIPT = "<script>alert(1)</script>";

class Widget {
  readonly label = "w";
  readonly size = 3;

  describe(): string {
    return `${this.label}:${this.size}`;
  }
}

function textBlock(text: string): TextBlock {
  return {
    id: "msg-1:text:0",
    messageId: "msg-1",
    runId: "run-1",
    role: "assistant",
    type: "text",
    text,
    flavor: "markdown",
    status: "complete",
  };
}

function codeBlock(): CodeBlock {
  return {
    id: "msg-1:code:0",
    messageId: "msg-1",
    runId: "run-1",
    role: "assistant",
    type: "code",
    text: "const answer = 42;",
    info: "ts",
    closed: true,
    status: "complete",
  };
}

function imageBlock(): ImageBlock {
  return {
    id: "msg-1:image:0",
    messageId: "msg-1",
    runId: null,
    role: "user",
    type: "image",
    source: { kind: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" },
    alt: "a cat",
  };
}

function toolCallBlock(result: unknown): ToolCallBlock {
  return {
    id: "tool:call-1",
    messageId: "msg-2",
    runId: "run-1",
    role: "tool",
    type: "tool_call",
    toolCallId: "call-1",
    name: "search",
    argumentsText: '{"q":"cats"}',
    result,
    status: "success",
    orphan: false,
  };
}

function reasoningBlock(): ReasoningBlock {
  return {
    id: "msg-1:reasoning:0",
    messageId: "msg-1",
    runId: "run-1",
    role: "assistant",
    type: "reasoning",
    text: "thinking about the answer",
  };
}

function noticeBlock(): NoticeBlock {
  return {
    id: "msg-1:notice:0",
    messageId: "msg-1",
    runId: "run-1",
    role: "system",
    type: "notice",
    category: "task-notification",
    title: "Task finished",
    text: "the task result",
  };
}

function errorBlock(): ErrorBlock {
  return {
    id: "msg-1:error:0",
    messageId: "msg-1",
    runId: "run-1",
    role: "system",
    type: "error",
    message: "request failed",
    errorType: "network",
    detail: "connection reset",
  };
}

function unknownBlock(raw: unknown): UnknownBlock {
  return {
    id: "msg-3:unknown:0",
    messageId: "msg-3",
    runId: "run-1",
    role: "system",
    type: "unknown",
    rawType: "new_part",
    raw,
  };
}

function fixtureBlocks(): Block[] {
  return [
    textBlock("hello"),
    codeBlock(),
    imageBlock(),
    toolCallBlock({ ok: true, hits: [1, 2] }),
    reasoningBlock(),
    noticeBlock(),
    errorBlock(),
    unknownBlock({ type: "new_part", nested: { value: 1 } }),
  ];
}

describe("strings are copied, never escaped", () => {
  it("keeps a script tag character for character in text and in a raw payload", () => {
    const text = textBlock(`before ${SCRIPT} after`);
    const unknown = unknownBlock({ html: SCRIPT, list: [SCRIPT] });

    const cleanText = sanitizeBlock(text) as TextBlock;
    const cleanUnknown = sanitizeBlock(unknown) as UnknownBlock;

    expect(cleanText.text).toBe(text.text);
    expect(cleanText.text).toContain(SCRIPT);
    expect(cleanUnknown.raw).toEqual({ html: SCRIPT, list: [SCRIPT] });
    expect(JSON.stringify(cleanUnknown)).toContain(SCRIPT);
    expect(JSON.stringify(cleanUnknown)).not.toContain("&lt;");
    expect(toJsonSafe(SCRIPT)).toBe(SCRIPT);
  });
});

describe("toJsonSafe", () => {
  it("drops undefined, functions, symbols, bigints and non-finite numbers", () => {
    const input = {
      keep: "ok",
      zero: -0,
      undef: undefined,
      fn: () => 1,
      sym: Symbol("s"),
      big: 12n,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
      date: new Date(0),
      map: new Map([["a", 1]]),
      set: new Set([1]),
      widget: new Widget(),
    };

    const cleaned = toJsonSafe(input) as Record<string, unknown>;

    expect(Object.keys(cleaned)).toEqual(["keep", "zero", "date", "map", "set", "widget"]);
    expect(cleaned.keep).toBe("ok");
    expect(cleaned.zero).toBe(0);
    expect(Object.is(cleaned.zero, -0)).toBe(false);
    expect(cleaned.date).toEqual({});
    expect(cleaned.map).toEqual({});
    expect(cleaned.set).toEqual({});
    expect(cleaned.widget).toEqual({ label: "w", size: 3 });
    expect(() => JSON.stringify(cleaned)).not.toThrow();
    expect(JSON.parse(JSON.stringify(cleaned))).toEqual(cleaned);
  });

  it("turns an unusable array entry into null so later positions keep their index", () => {
    const cleaned = toJsonSafe([
      "text",
      undefined,
      () => 1,
      Symbol("s"),
      12n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(0),
    ]);

    expect(cleaned).toEqual(["text", null, null, null, null, null, null, null, {}]);
  });

  it("returns null when the whole value is outside the subset", () => {
    expect(toJsonSafe(undefined)).toBeNull();
    expect(toJsonSafe(() => 1)).toBeNull();
    expect(toJsonSafe(Symbol("s"))).toBeNull();
    expect(toJsonSafe(7n)).toBeNull();
    expect(toJsonSafe(Number.NaN)).toBeNull();
  });

  it("cuts a cycle on the current path and keeps the finite part", () => {
    const node: Record<string, unknown> = { name: "root" };
    node.self = node;
    node.child = { parent: node };

    expect(() => toJsonSafe(node)).not.toThrow();
    expect(toJsonSafe(node)).toEqual({ name: "root", child: {} });
    expect(() => JSON.stringify(toJsonSafe(node))).not.toThrow();

    const list: unknown[] = [];
    list.push(list);
    expect(toJsonSafe(list)).toEqual([null]);
  });

  it("copies a shared reference twice instead of treating it as a cycle", () => {
    const shared = { value: 1 };
    expect(toJsonSafe({ left: shared, right: shared })).toEqual({
      left: { value: 1 },
      right: { value: 1 },
    });
  });

  it("does not run accessors and survives a throwing getter", () => {
    const hostile = {
      safe: 1,
      get boom(): number {
        throw new Error("the getter must not run");
      },
    };

    expect(() => toJsonSafe(hostile)).not.toThrow();
    expect(toJsonSafe(hostile)).toEqual({ safe: 1 });
  });
});

describe("sanitizeBlock", () => {
  it("passes each of the eight block types through unchanged and JSON-safe", () => {
    const blocks = fixtureBlocks();
    expect(new Set(blocks.map((block) => block.type)).size).toBe(8);

    for (const block of blocks) {
      const cleaned = sanitizeBlock(block);
      expect(cleaned).toEqual(block);
      expect(cleaned.type).toBe(block.type);
      expect(JSON.parse(JSON.stringify(cleaned))).toEqual(block);
    }
  });

  it("keeps image bytes and urls verbatim without decoding or rewriting them", () => {
    const cleanBase64 = sanitizeBlock(imageBlock()) as ImageBlock;
    expect(cleanBase64.source).toEqual({
      kind: "base64",
      mediaType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(cleanBase64.alt).toBe("a cat");

    const urlBlock: ImageBlock = {
      ...imageBlock(),
      source: { kind: "url", url: "https://example.test/cat.png" },
    };
    const cleanUrl = sanitizeBlock(urlBlock) as ImageBlock;
    expect(cleanUrl.source).toEqual({ kind: "url", url: "https://example.test/cat.png" });
    expect(JSON.stringify(cleanUrl)).not.toContain("blob:");
  });

  it("cleans a tool result without touching argument text, type or status", () => {
    const before = toolCallBlock({
      ok: true,
      note: SCRIPT,
      run: () => 1,
      at: new Date(0),
      ratio: Number.NaN,
    });

    const after = sanitizeBlock(before) as ToolCallBlock;

    expect(after.result).toEqual({ ok: true, note: SCRIPT, at: {} });
    expect(after.argumentsText).toBe(before.argumentsText);
    expect(after.type).toBe("tool_call");
    expect(after.status).toBe("success");
  });

  it("normalises non-string fields that are declared string or null", () => {
    const malformedError = { ...errorBlock(), detail: { leak: () => 1 } } as unknown as ErrorBlock;
    const malformedImage = { ...imageBlock(), alt: 42 } as unknown as ImageBlock;
    const malformedUnknown = unknownBlock(undefined);

    expect((sanitizeBlock(malformedError) as ErrorBlock).detail).toBeNull();
    expect((sanitizeBlock(malformedImage) as ImageBlock).alt).toBeNull();
    expect((sanitizeBlock(malformedUnknown) as UnknownBlock).raw).toBeNull();
  });

  it("degrades an unusable image source instead of throwing", () => {
    const malformed = { ...imageBlock(), source: undefined } as unknown as ImageBlock;

    expect(() => sanitizeBlock(malformed)).not.toThrow();
    expect((sanitizeBlock(malformed) as ImageBlock).source).toEqual({ kind: "url", url: "" });
  });

  it("cuts a cycle inside an unknown payload", () => {
    const raw: Record<string, unknown> = { name: "loop" };
    raw.self = raw;

    const clean = sanitizeBlock(unknownBlock(raw)) as UnknownBlock;
    expect(clean.raw).toEqual({ name: "loop" });
    expect(() => JSON.stringify(clean)).not.toThrow();
  });

  it("returns a JSON value rather than throwing when handed no block at all", () => {
    expect(sanitizeBlock(null as unknown as Block)).toBeNull();
  });
});

describe("sanitizeUpdate", () => {
  it("keeps upsert order while cleaning each block", () => {
    const first = textBlock("one");
    const second = codeBlock();
    const third = unknownBlock({ drop: () => 1, keep: "v" });
    const update: ContentUpdate = {
      messageId: "msg-1",
      upserts: [first, second, third],
      removes: [],
    };

    const cleaned = sanitizeUpdate(update);

    expect(cleaned.upserts.map((block) => block.type)).toEqual(["text", "code", "unknown"]);
    expect(cleaned.upserts[0]).toEqual(first);
    expect((cleaned.upserts[2] as UnknownBlock).raw).toEqual({ keep: "v" });
    expect(JSON.parse(JSON.stringify(cleaned))).toEqual(cleaned);
  });

  it("dedupes removes in first-seen order and keeps empty arrays", () => {
    const update: ContentUpdate = {
      messageId: "msg-1",
      upserts: [],
      removes: ["msg-1:text:0", "tool:call-1", "msg-1:text:0"],
    };

    const cleaned = sanitizeUpdate(update);
    expect(cleaned.removes).toEqual(["msg-1:text:0", "tool:call-1"]);
    expect(cleaned.upserts).toEqual([]);

    const empty = sanitizeUpdate({ messageId: "msg-9", upserts: [], removes: [] });
    expect(empty).toEqual({ messageId: "msg-9", upserts: [], removes: [] });
  });

  it("does not throw on a malformed update and returns empty lists", () => {
    const missingLists = { messageId: "msg-1" } as unknown as ContentUpdate;
    expect(sanitizeUpdate(missingLists)).toEqual({
      messageId: "msg-1",
      upserts: [],
      removes: [],
    });

    expect(sanitizeUpdate(null as unknown as ContentUpdate)).toEqual({
      messageId: "",
      upserts: [],
      removes: [],
    });
  });
});
