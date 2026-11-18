/**
 * Tests for the history page parser.
 *
 * These pin the contract the model facade and its callers rely on: a page of
 * already-finished messages becomes the same text/code/image/tool/notice shapes
 * the live path produces, tool calls pair only inside the page, a result that
 * lost its call becomes an orphan instead of disappearing, and parsing the same
 * page twice yields equal blocks.
 *
 * The entries are written in the engine's `message.list` shape (snake_case
 * `message_type`, `content` on the entry, `date`) to also cover the adapter
 * step that turns a history entry into the content model's `SourceMessage`.
 */

import type { Block } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { parseHistoryPage } from "./history.js";
import type { SourceMessage } from "./types.js";

type Entry = Record<string, unknown>;

/** The page as the caller passes it: either wrapped messages or raw entries. */
function page(...entries: readonly unknown[]): readonly SourceMessage[] {
  return entries as unknown as readonly SourceMessage[];
}

const REMINDER = "<system-reminder>\nagent-only context\n</system-reminder>";

function notification(summary: string, result: string): string {
  return [
    "<task-notification>",
    "<task-id>task_1</task-id>",
    `<summary>${summary}</summary>`,
    `<result>${result}</result>`,
    "</task-notification>",
  ].join("\n");
}

function userId(id: string, content: unknown, extra: Entry = {}): Entry {
  return { id, message_type: "user_message", role: "user", content, ...extra };
}

function assistantId(id: string, content: unknown, extra: Entry = {}): Entry {
  return { id, message_type: "assistant_message", role: "assistant", content, ...extra };
}

/** Narrow a block and prove its discriminator in one place. */
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

describe("user messages", () => {
  it("strips a reminder from string content and lifts a task notification", () => {
    const content = `hello\n${REMINDER}\n${notification("Agent &amp; done", "all good")}`;
    const blocks = parseHistoryPage(page(userId("u1", content)));

    expect(blocks.map((block) => block.type)).toEqual(["text", "notice"]);

    const text = typed(blocks[0], "text");
    expect(text.text).toBe("hello");
    expect(text.id).toBe("u1:text:0");
    expect(text.status).toBe("complete");
    expect(text.role).toBe("user");

    const notice = typed(blocks[1], "notice");
    expect(notice.id).toBe("u1:notice:0");
    expect(notice.category).toBe("task-notification");
    expect(notice.title).toBe("Agent & done");
    expect(notice.text).toBe("all good");
  });

  it("keeps an image between the paragraphs of array content", () => {
    const blocks = parseHistoryPage(
      page(
        userId("u2", [
          { type: "text", text: "first" },
          { type: "text", text: `${REMINDER}\n` },
          {
            type: "image",
            source: { type: "url", url: "https://example.test/cat.png" },
            alt: "cat",
          },
          { type: "text", text: "second" },
        ]),
      ),
    );

    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "text"]);

    expect(typed(blocks[0], "text").text).toBe("first");
    expect(typed(blocks[0], "text").id).toBe("u2:text:0");

    const image = typed(blocks[1], "image");
    expect(image.id).toBe("u2:image:0");
    expect(image.source).toEqual({ kind: "url", url: "https://example.test/cat.png" });
    expect(image.alt).toBe("cat");

    expect(typed(blocks[2], "text").text).toBe("second");
    expect(typed(blocks[2], "text").id).toBe("u2:text:1");
  });

  it("produces no block for a message that is only a reminder", () => {
    const blocks = parseHistoryPage(page(userId("u3", REMINDER)));

    expect(blocks).toEqual([]);
  });
});

describe("assistant messages", () => {
  it("scans string content for fences instead of showing it as one text block", () => {
    const blocks = parseHistoryPage(
      page(assistantId("a1", "intro\n```ts\nconst a = 1;\n```\nafter")),
    );

    expect(blocks.map((block) => block.type)).toEqual(["text", "code", "text"]);

    expect(typed(blocks[0], "text").text).toBe("intro\n");

    const code = typed(blocks[1], "code");
    expect(code.id).toBe("a1:code:0");
    expect(code.info).toBe("ts");
    expect(code.text).toBe("const a = 1;\n");
    expect(code.closed).toBe(true);
    expect(code.status).toBe("complete");

    expect(typed(blocks[2], "text").text).toBe("after");
  });

  it("walks array parts in order, skips reasoning and keeps an image in place", () => {
    const blocks = parseHistoryPage(
      page(
        assistantId(
          "a2",
          [
            { type: "text", text: "hello " },
            { type: "reasoning", reasoning: "hidden thinking" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
            { type: "text", text: "```js\nx\n```\n" },
          ],
          { run_id: "run-2" },
        ),
      ),
    );

    expect(blocks.map((block) => block.type)).toEqual(["text", "image", "code"]);

    expect(typed(blocks[0], "text").text).toBe("hello ");
    expect(typed(blocks[0], "text").status).toBe("complete");
    expect(typed(blocks[0], "text").runId).toBe("run-2");

    const image = typed(blocks[1], "image");
    expect(image.id).toBe("a2:image:0");
    expect(image.source).toEqual({ kind: "base64", mediaType: "image/png", data: "AAAA" });

    expect(typed(blocks[2], "code").info).toBe("js");
    expect(typed(blocks[2], "code").text).toBe("x\n");

    expect(JSON.stringify(blocks)).not.toContain("hidden thinking");
  });
});

describe("tool messages", () => {
  const CALL = {
    id: "c1",
    message_type: "tool_call_message",
    role: "tool",
    tool_call: { tool_call_id: "call_1", name: "Bash", arguments: '{"command":"echo ok"}' },
    run_id: "run-1",
  };

  const RETURN = {
    id: "r1",
    message_type: "tool_return_message",
    role: "tool",
    tool_call_id: "call_1",
    status: "success",
    tool_return: "ok",
    run_id: "run-1",
  };

  it("pairs a call with its return into one updated block", () => {
    const blocks = parseHistoryPage(page(CALL, RETURN));

    expect(blocks).toHaveLength(1);

    const tool = typed(blocks[0], "tool_call");
    expect(tool.id).toBe("tool:call_1");
    expect(tool.messageId).toBe("c1");
    expect(tool.runId).toBe("run-1");
    expect(tool.name).toBe("Bash");
    expect(tool.argumentsText).toBe('{"command":"echo ok"}');
    expect(tool.result).toBe("ok");
    expect(tool.status).toBe("success");
    expect(tool.orphan).toBe(false);
  });

  it("turns a result seen before its call into an orphan block", () => {
    const blocks = parseHistoryPage(page(RETURN, CALL));

    expect(blocks).toHaveLength(1);

    const tool = typed(blocks[0], "tool_call");
    expect(tool.orphan).toBe(true);
    expect(tool.messageId).toBe("r1");
    expect(tool.name).toBeNull();
    expect(tool.argumentsText).toBe("");
    expect(tool.result).toBe("ok");
    expect(tool.status).toBe("success");
  });

  it("does not pair a call and a return that land on different pages", () => {
    const first = parseHistoryPage(page(CALL));
    const second = parseHistoryPage(page(RETURN));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);

    expect(typed(first[0], "tool_call").status).toBe("running");
    expect(typed(first[0], "tool_call").orphan).toBe(false);
    expect(typed(first[0], "tool_call").result).toBeNull();

    expect(typed(second[0], "tool_call").status).toBe("success");
    expect(typed(second[0], "tool_call").orphan).toBe(true);
    expect(typed(second[0], "tool_call").id).toBe("tool:call_1");
  });

  it("keeps a tool block at its first position when its result arrives later", () => {
    const blocks = parseHistoryPage(
      page(userId("u4", "before"), CALL, assistantId("a4", "after"), RETURN),
    );

    expect(blocks.map((block) => block.type)).toEqual(["text", "tool_call", "text"]);

    const tool = typed(blocks[1], "tool_call");
    expect(tool.id).toBe("tool:call_1");
    expect(tool.result).toBe("ok");
    expect(tool.status).toBe("success");
  });
});

describe("reasoning messages", () => {
  it("aggregates fragments that share an id and hides hidden reasoning", () => {
    const blocks = parseHistoryPage(
      page(
        {
          id: "a5:reasoning:0",
          message_type: "reasoning_message",
          role: "assistant",
          reasoning: "world",
          seq_id: 2,
          run_id: "run-5",
        },
        {
          id: "h5",
          message_type: "hidden_reasoning_message",
          role: "assistant",
          reasoning: "agent-only secret",
        },
        userId("u5", "between"),
        {
          id: "a5:reasoning:0",
          message_type: "reasoning_message",
          role: "assistant",
          reasoning: "hello ",
          seq_id: 1,
        },
      ),
    );

    expect(blocks.map((block) => block.type)).toEqual(["reasoning", "text"]);

    const reasoning = typed(blocks[0], "reasoning");
    expect(reasoning.id).toBe("a5:reasoning:0");
    expect(reasoning.messageId).toBe("a5");
    expect(reasoning.text).toBe("hello world");

    expect(typed(blocks[1], "text").text).toBe("between");
    expect(JSON.stringify(blocks)).not.toContain("agent-only secret");
  });
});

describe("degraded content", () => {
  it("downgrades system, summary and event messages to unknown blocks", () => {
    const entries = [
      { id: "s1", message_type: "system_message", role: "system", content: "sys" },
      { id: "su1", message_type: "summary_message", role: "system", summary: "sum" },
      { id: "e1", message_type: "event_message", role: "system", event: "evt" },
    ];
    const blocks = parseHistoryPage(page(...entries));

    expect(blocks.map((block) => block.type)).toEqual(["unknown", "unknown", "unknown"]);
    expect(blocks.map((block) => typed(block, "unknown").rawType)).toEqual([
      "system_message",
      "summary_message",
      "event_message",
    ]);
    expect(typed(blocks[0], "unknown").id).toBe("s1:unknown:0");
    expect(typed(blocks[0], "unknown").raw).toEqual(entries[0]);
  });

  it("turns an error message into an error block", () => {
    const blocks = parseHistoryPage(
      page({
        id: "err1",
        message_type: "error_message",
        role: "system",
        message: "Provider is not configured",
        error_type: "llm_error",
        detail: "no provider",
        run_id: "run-err",
      }),
    );

    expect(blocks).toHaveLength(1);

    const error = typed(blocks[0], "error");
    expect(error.id).toBe("err1:error:0");
    expect(error.message).toBe("Provider is not configured");
    expect(error.errorType).toBe("llm_error");
    expect(error.detail).toBe("no provider");
    expect(error.runId).toBe("run-err");
  });

  it("does not throw on malformed content and keeps what it can classify", () => {
    const assistant = parseHistoryPage(
      page(assistantId("a6", [null, 42, { type: "text", text: 42 }, { type: "image" }, "tail"])),
    );

    expect(assistant.map((block) => block.type)).toEqual(["unknown", "text"]);
    expect(typed(assistant[0], "unknown").rawType).toBe("image");
    expect(typed(assistant[1], "text").text).toBe("tail");

    const user = parseHistoryPage(
      page(userId("u6", [null, { type: "text", text: 42 }, { type: "image" }])),
    );

    expect(user.map((block) => block.type)).toEqual(["unknown"]);
    expect(typed(user[0], "unknown").rawType).toBe("image");
  });

  it("skips an entry that is not an object and survives an unparseable date", () => {
    const blocks = parseHistoryPage(page(null, userId("u7", "still here", { date: "not-a-date" })));

    expect(blocks).toHaveLength(1);
    expect(typed(blocks[0], "text").text).toBe("still here");
  });
});

describe("normalisation", () => {
  it("reads the type, role, run and content out of a raw history entry", () => {
    const blocks = parseHistoryPage(
      page({ id: "u8", message_type: "user_message", content: "raw", run_id: "run-8" }),
    );

    expect(blocks).toHaveLength(1);

    const text = typed(blocks[0], "text");
    expect(text.text).toBe("raw");
    expect(text.role).toBe("user");
    expect(text.runId).toBe("run-8");
  });

  it("accepts an already wrapped message and prefers the payload's run id", () => {
    const message: SourceMessage = {
      id: "a7",
      messageType: "assistant_message",
      role: "assistant",
      body: { content: "wrapped", run_id: "body-run" },
      runId: "outer-run",
      at: 1_700_000_000_000,
    };

    const blocks = parseHistoryPage([message]);

    expect(blocks).toHaveLength(1);
    expect(typed(blocks[0], "text").text).toBe("wrapped");
    expect(typed(blocks[0], "text").runId).toBe("body-run");
  });
});

describe("idempotence", () => {
  it("returns the same block sequence when the same page is parsed twice", () => {
    const entries = page(
      userId("u9", `hi ${REMINDER}`),
      assistantId("a9", "text\n```py\nprint(1)\n```\n"),
      {
        id: "c9",
        message_type: "tool_call_message",
        role: "tool",
        tool_call: { tool_call_id: "call_9", name: "Read", arguments: "{}" },
      },
      {
        id: "r9",
        message_type: "tool_return_message",
        role: "tool",
        tool_call_id: "call_9",
        status: "error",
        tool_return: "boom",
      },
    );

    const first = parseHistoryPage(entries);
    const second = parseHistoryPage(entries);

    expect(first.length).toBeGreaterThan(3);
    expect(second).toEqual(first);
  });
});
