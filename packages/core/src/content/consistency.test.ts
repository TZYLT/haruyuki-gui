/**
 * Streaming equals one-shot: the same content must become the same blocks
 * whichever door it comes through.
 *
 * The live door is the facade: one `message.delta` per fragment, cumulative
 * parts alongside, and a `message.complete` at the end. The one-shot door is
 * `parseHistoryPage`, where every message arrives whole. A reader must not be
 * able to tell which door was used from the blocks alone, so the two block
 * sequences are compared after folding the live upserts down to their final
 * shapes and normalising `status` (`streaming` to `complete` -- the only
 * difference the contract allows).
 *
 * Every case runs twice: once with one character per frame, once with a
 * deterministic 1-7 character split. Both are legitimate streams, and a
 * line-oriented fence scanner that only agreed with a whole-message parse on
 * "nice" boundaries would be a bug in the scanner rather than in the test.
 */

import type { Block, BlockId, ContentUpdate } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { AssistantPart, MergerChange } from "../merge/types.js";
import { parseHistoryPage } from "./history.js";
import { createContentModel } from "./model.js";
import type { SourceMessage } from "./types.js";

type Delta = Extract<MergerChange, { kind: "message.delta" }>;
type Final = Extract<MergerChange, { kind: "message.final" }>;
type Complete = Extract<MergerChange, { kind: "message.complete" }>;

const AT = 1_700_000_000_000;
const RUN = "run-consistency";

/** Fields every merger change carries; only the kind-specific ones matter here. */
function base() {
  return {
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId: "conv-consistency",
    at: AT,
  };
}

function deltaChange(
  messageId: string,
  text: string,
  parts: readonly AssistantPart[] = [],
  runId: string = RUN,
): Delta {
  return {
    ...base(),
    kind: "message.delta",
    messageId,
    runId,
    runSeq: 1,
    text,
    parts,
    first: false,
  };
}

function finalChange(
  messageId: string,
  messageType: string,
  body: unknown,
  runId: string = RUN,
): Final {
  return { ...base(), kind: "message.final", messageId, runId, messageType, body };
}

function completeChange(messageId: string, runId: string = RUN): Complete {
  return {
    ...base(),
    kind: "message.complete",
    messageId,
    runId,
    textLength: 0,
    incomplete: false,
  };
}

/** One source message, in the shape the history page and the final path share. */
function sourceMessage(
  id: string,
  messageType: string,
  body: unknown,
  role: SourceMessage["role"] = "assistant",
  runId: string = RUN,
): SourceMessage {
  return { id, messageType, role, body, runId, at: AT };
}

/** One assistant message whose whole text is already known. */
function assistantContent(id: string, content: unknown, runId: string = RUN): SourceMessage {
  return sourceMessage(id, "assistant_message", { content }, "assistant", runId);
}

/**
 * Replay the consumer's rules on an update stream.
 *
 * An upsert replaces the block under its id in place, so first-seen order
 * survives tool results and repeated text frames; a remove drops the block.
 * That is exactly what the conversation store does, and folding the same way
 * is what makes "the update stream" and "the final page" comparable.
 */
function foldUpdates(updates: readonly ContentUpdate[]): readonly Block[] {
  const slots: (Block | undefined)[] = [];
  const positions = new Map<BlockId, number>();

  for (const update of updates) {
    for (const id of update.removes) {
      const at = positions.get(id);
      if (at !== undefined) {
        slots[at] = undefined;
      }
    }
    for (const block of update.upserts) {
      const at = positions.get(block.id);
      if (at === undefined) {
        positions.set(block.id, slots.length);
        slots.push(block);
      } else {
        slots[at] = block;
      }
    }
  }

  return slots.filter((block): block is Block => block !== undefined);
}

/** The only status difference the contract allows: live text is closed later. */
function settle(blocks: readonly Block[]): readonly Block[] {
  return blocks.map((block): Block => {
    if (block.type === "text" || block.type === "code") {
      return block.status === "streaming" ? { ...block, status: "complete" } : block;
    }
    return block;
  });
}

/** One step of a live scene: a text frame (with its cumulative parts) or a whole message. */
type Step =
  | { readonly kind: "text"; readonly text: string; readonly parts?: readonly AssistantPart[] }
  | {
      readonly kind: "final";
      readonly messageId: string;
      readonly messageType: string;
      readonly body: unknown;
    };

type Chunker = (text: string) => readonly string[];

/** Feed one scene through the facade and fold the result to final blocks. */
function liveBlocks(messageId: string, steps: readonly Step[], chunk: Chunker): readonly Block[] {
  const model = createContentModel();
  const updates: ContentUpdate[] = [];

  for (const step of steps) {
    if (step.kind === "final") {
      updates.push(...model.ingest(finalChange(step.messageId, step.messageType, step.body)));
      continue;
    }

    for (const piece of chunk(step.text)) {
      updates.push(...model.ingest(deltaChange(messageId, piece)));
    }
    if (step.parts !== undefined) {
      updates.push(...model.ingest(deltaChange(messageId, "", step.parts)));
    }
  }

  updates.push(...model.ingest(completeChange(messageId)));
  return settle(foldUpdates(updates));
}

/**
 * Feed already-shaped live frames through the facade and fold the result.
 *
 * Unlike `liveBlocks`, every frame carries its own `text` and the message's
 * cumulative `parts`, which is the shape the upstream assembler publishes: the
 * frame's text is exactly the text its new text parts contribute.
 */
function liveFromFrames(
  messageId: string,
  frames: readonly { readonly text: string; readonly parts: readonly AssistantPart[] }[],
): readonly Block[] {
  const model = createContentModel();
  const updates: ContentUpdate[] = [];

  for (const frame of frames) {
    updates.push(...model.ingest(deltaChange(messageId, frame.text, frame.parts)));
  }
  updates.push(...model.ingest(completeChange(messageId)));

  return settle(foldUpdates(updates));
}

/** The same scene as one history page. */
function oneShotBlocks(messages: readonly SourceMessage[]): readonly Block[] {
  return settle(parseHistoryPage(messages));
}

/** Deterministic 1-7 character frames, so a rerun splits identically. */
function randomFrames(text: string, seed: number): readonly string[] {
  let state = seed >>> 0;
  const frames: string[] = [];
  let at = 0;

  while (at < text.length) {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    const size = 1 + ((((value ^ (value >>> 14)) >>> 0) % 7) | 0);
    frames.push(text.slice(at, at + size));
    at += size;
  }

  return frames;
}

const CHUNKERS: readonly { readonly name: string; readonly chunk: Chunker }[] = [
  { name: "one character per frame", chunk: (text) => [...text] },
  { name: "random 1-7 character frames", chunk: (text) => randomFrames(text, 0x5eed) },
];

const PROSE =
  "## Agenda\n\n- keep the fence\n- keep <script>alert(1)</script> verbatim\n\nCafé ✓\n";

const FENCED =
  "Here is the sample:\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\nThat is all.\n";

const UNCLOSED = "Look:\n\n```js\nconst x = 1;\nreturn x;";

const IMAGE_BASE64: AssistantPart = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
};

const IMAGE_URL: AssistantPart = {
  type: "image",
  source: { type: "url", url: "https://example.test/diagram.png" },
  alt: "diagram",
};

describe("streaming and one-shot produce the same block sequence", () => {
  for (const { name, chunk } of CHUNKERS) {
    it(`plain prose keeps one text block verbatim (${name})`, () => {
      const live = liveBlocks("msg-prose", [{ kind: "text", text: PROSE }], chunk);
      const once = oneShotBlocks([assistantContent("msg-prose", PROSE)]);

      expect(live).toEqual(once);
      expect(live).toEqual([
        {
          id: "msg-prose:text:0",
          messageId: "msg-prose",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: PROSE,
          flavor: "markdown",
          status: "complete",
        },
      ]);
    });

    it(`a closed fence becomes one code block with its info (${name})`, () => {
      const live = liveBlocks("msg-fence", [{ kind: "text", text: FENCED }], chunk);
      const once = oneShotBlocks([assistantContent("msg-fence", FENCED)]);

      expect(live).toEqual(once);
      expect(live).toEqual([
        {
          id: "msg-fence:text:0",
          messageId: "msg-fence",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "Here is the sample:\n\n",
          flavor: "markdown",
          status: "complete",
        },
        {
          id: "msg-fence:code:0",
          messageId: "msg-fence",
          runId: RUN,
          role: "assistant",
          type: "code",
          text: "const answer = 42;\nconsole.log(answer);\n",
          info: "ts",
          closed: true,
          status: "complete",
        },
        {
          id: "msg-fence:text:1",
          messageId: "msg-fence",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "\nThat is all.\n",
          flavor: "markdown",
          status: "complete",
        },
      ]);
    });

    it(`an unclosed fence stays code, complete but not closed (${name})`, () => {
      const live = liveBlocks("msg-open", [{ kind: "text", text: UNCLOSED }], chunk);
      const once = oneShotBlocks([assistantContent("msg-open", UNCLOSED)]);

      expect(live).toEqual(once);
      expect(live).toEqual([
        {
          id: "msg-open:text:0",
          messageId: "msg-open",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "Look:\n\n",
          flavor: "markdown",
          status: "complete",
        },
        {
          id: "msg-open:code:0",
          messageId: "msg-open",
          runId: RUN,
          role: "assistant",
          type: "code",
          text: "const x = 1;\nreturn x;",
          info: "js",
          closed: false,
          status: "complete",
        },
      ]);
    });

    it(`image parts keep their position and source (${name})`, () => {
      const parts: readonly AssistantPart[] = [
        { type: "text", text: "Before the image.\n" },
        IMAGE_BASE64,
        IMAGE_URL,
      ];
      const live = liveBlocks(
        "msg-image",
        [
          { kind: "text", text: "Before the image.\n" },
          { kind: "text", text: "", parts },
        ],
        chunk,
      );
      const once = oneShotBlocks([assistantContent("msg-image", parts)]);

      expect(live).toEqual(once);
      expect(live).toEqual([
        {
          id: "msg-image:text:0",
          messageId: "msg-image",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "Before the image.\n",
          flavor: "markdown",
          status: "complete",
        },
        {
          id: "msg-image:image:0",
          messageId: "msg-image",
          runId: RUN,
          role: "assistant",
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
          alt: null,
        },
        {
          id: "msg-image:image:1",
          messageId: "msg-image",
          runId: RUN,
          role: "assistant",
          type: "image",
          source: { kind: "url", url: "https://example.test/diagram.png" },
          alt: "diagram",
        },
      ]);
    });

    it(`a body with no trailing newline keeps its place before an image (${name})`, () => {
      // Regression case: "Before the image." has no newline, so it is still
      // buffered in the fence scanner when the image part arrives. Appending
      // the part first put the image ahead of that prose on the live door
      // ([image, text]) while the one-shot door produced [text, image]. The
      // part builder now flushes the buffered tail before appending, so both
      // doors have to agree on the order, not just on the content.
      const body = "Before the image.";
      const parts: readonly AssistantPart[] = [{ type: "text", text: body }, IMAGE_BASE64];

      const live = liveBlocks(
        "msg-image-runon",
        [
          { kind: "text", text: body },
          { kind: "text", text: "", parts },
        ],
        chunk,
      );
      const once = oneShotBlocks([assistantContent("msg-image-runon", parts)]);

      expect(live).toEqual(once);
      expect(live.map((block) => block.type)).toEqual(["text", "image"]);
      expect(live[0]).toMatchObject({ type: "text", text: "Before the image." });
      expect(live).toEqual([
        {
          id: "msg-image-runon:text:0",
          messageId: "msg-image-runon",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "Before the image.",
          flavor: "markdown",
          status: "complete",
        },
        {
          id: "msg-image-runon:image:0",
          messageId: "msg-image-runon",
          runId: RUN,
          role: "assistant",
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
          alt: null,
        },
      ]);
    });

    it(`a tool call plus its return is one block on both paths (${name})`, () => {
      const callBody = (argumentsText: string): Record<string, unknown> => ({
        tool_call_id: "call-1",
        name: "shell",
        arguments: argumentsText,
      });
      const returnBody: Record<string, unknown> = {
        tool_call_id: "call-1",
        status: "success",
        tool_return: "a.txt\nb.txt\n",
      };

      const live = liveBlocks(
        "msg-tool",
        [
          { kind: "text", text: "Let me check the files.\n" },
          {
            kind: "final",
            messageId: "msg-tc1",
            messageType: "tool_call_message",
            body: callBody('{"cmd":"'),
          },
          {
            kind: "final",
            messageId: "msg-tc2",
            messageType: "tool_call_message",
            body: callBody('ls"}'),
          },
          {
            kind: "final",
            messageId: "msg-tr",
            messageType: "tool_return_message",
            body: returnBody,
          },
        ],
        chunk,
      );

      const once = oneShotBlocks([
        assistantContent("msg-tool", "Let me check the files.\n"),
        sourceMessage("msg-tc1", "tool_call_message", callBody('{"cmd":"'), "tool"),
        sourceMessage("msg-tc2", "tool_call_message", callBody('ls"}'), "tool"),
        sourceMessage("msg-tr", "tool_return_message", returnBody, "tool"),
      ]);

      expect(live).toEqual(once);
      expect(live.filter((block) => block.type === "tool_call")).toHaveLength(1);
      expect(live).toEqual([
        {
          id: "msg-tool:text:0",
          messageId: "msg-tool",
          runId: RUN,
          role: "assistant",
          type: "text",
          text: "Let me check the files.\n",
          flavor: "markdown",
          status: "complete",
        },
        {
          id: "tool:call-1",
          messageId: "msg-tc1",
          runId: RUN,
          role: "tool",
          type: "tool_call",
          toolCallId: "call-1",
          name: "shell",
          argumentsText: '{"cmd":"ls"}',
          result: "a.txt\nb.txt\n",
          status: "success",
          orphan: false,
        },
      ]);
    });

    it(`reasoning fragments join into one block in sequence order (${name})`, () => {
      const firstFragment: Record<string, unknown> = { reasoning: " world", seq_id: 1 };
      const secondFragment: Record<string, unknown> = { reasoning: "Hello", seq_id: 0 };

      const live = liveBlocks(
        "msg-reasoning",
        [
          {
            kind: "final",
            messageId: "msg-r:reasoning:0",
            messageType: "reasoning_message",
            body: firstFragment,
          },
          {
            kind: "final",
            messageId: "msg-r:reasoning:0",
            messageType: "reasoning_message",
            body: secondFragment,
          },
        ],
        chunk,
      );

      const once = oneShotBlocks([
        sourceMessage("msg-r:reasoning:0", "reasoning_message", firstFragment),
        sourceMessage("msg-r:reasoning:0", "reasoning_message", secondFragment),
      ]);

      expect(live).toEqual(once);
      expect(live).toEqual([
        {
          id: "msg-r:reasoning:0",
          messageId: "msg-r",
          runId: RUN,
          role: "assistant",
          type: "reasoning",
          text: "Hello world",
        },
      ]);
    });
  }
});

/**
 * A frame's text is the text of *its* new text parts, not a separate stream.
 * When a frame carries `[image, text "b"]`, the part order must decide the
 * block order, so the live door may not append the frame's text before folding
 * the parts in: that would merge "b" into the previous paragraph and put the
 * image last, while a one-shot parse keeps `[text a, image, text b]`.
 */
describe("live frames keep the source part order", () => {
  it("a later text part after an image keeps the one-shot order (text/image/text)", () => {
    const frames = [
      { text: "a", parts: [{ type: "text", text: "a" } as AssistantPart] },
      {
        text: "b\n",
        parts: [
          { type: "text", text: "a" } as AssistantPart,
          IMAGE_BASE64,
          { type: "text", text: "b\n" } as AssistantPart,
        ],
      },
    ];

    const live = liveFromFrames("msg-live-order", frames);
    const once = oneShotBlocks([assistantContent("msg-live-order", frames[1]?.parts ?? [])]);

    expect(live).toEqual(once);
    expect(live.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(
      live.map((block) => (block.type === "text" || block.type === "code" ? block.text : null)),
    ).toEqual(["a", null, "b\n"]);
  });

  it("a text part before an image keeps the one-shot order (text before image)", () => {
    const frames = [
      { text: "a", parts: [{ type: "text", text: "a" } as AssistantPart] },
      {
        text: "b\n",
        parts: [
          { type: "text", text: "a" } as AssistantPart,
          { type: "text", text: "b\n" } as AssistantPart,
          IMAGE_BASE64,
        ],
      },
    ];

    const live = liveFromFrames("msg-live-order-reverse", frames);
    const once = oneShotBlocks([
      assistantContent("msg-live-order-reverse", frames[1]?.parts ?? []),
    ]);

    expect(live).toEqual(once);
    expect(live.map((block) => block.type)).toEqual(["text", "image"]);
    expect(live[0]).toMatchObject({ type: "text", text: "ab\n" });
  });
});
