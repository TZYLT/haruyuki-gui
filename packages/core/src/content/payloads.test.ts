/**
 * Large payloads: a big body, a big image and a big tool result reach a block
 * without truncation, rewriting or decoding.
 *
 * The point is not throughput but fidelity: each test compares the payload that
 * went in with the string on the block character for character, and the tool
 * result is taken through a JSON round trip as well. The sizes are the stress
 * values -- 100,000 characters of prose, a 1 MiB base64 image and a 50 MiB tool
 * result -- so a future cap added for "safety" fails here instead of
 * silently trimming what the engine sent.
 *
 * The 50 MiB case is the only slow one; its measured duration is reported
 * rather than asserted, because a wall-clock bound would make the suite flaky
 * on a busy machine.
 */

import type {
  Block,
  ContentUpdate,
  ImageBlock,
  TextBlock,
  ToolCallBlock,
} from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { parseHistoryPage } from "./history.js";
import { createContentModel } from "./model.js";

const AT = 1_700_000_000_000;

/** Fields every change carries; only the payload varies. */
const BASE = {
  authorAgentId: "agent-payload",
  runtimeAgentId: "agent-payload",
  subagentId: null,
  conversationId: "conv-payload",
  at: AT,
} as const;

/** Fold an update stream the way the store does: upsert by id, keep the slot. */
function foldUpdates(updates: readonly ContentUpdate[]): readonly Block[] {
  const slots: (Block | undefined)[] = [];
  const positions = new Map<string, number>();

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

/** Stream one assistant body through the model in fixed-size frames. */
function streamAssistant(messageId: string, text: string, chunkSize: number): readonly Block[] {
  const model = createContentModel();
  const updates: ContentUpdate[] = [];

  for (let offset = 0, seq = 0; offset < text.length; offset += chunkSize, seq += 1) {
    const change: MergerChange = {
      ...BASE,
      kind: "message.delta",
      messageId,
      runId: "run-payload",
      runSeq: seq,
      text: text.slice(offset, offset + chunkSize),
      parts: [],
      first: offset === 0,
    };
    updates.push(...model.ingest(change));
  }

  updates.push(
    ...model.ingest({
      ...BASE,
      kind: "message.complete",
      messageId,
      runId: "run-payload",
      textLength: text.length,
      incomplete: false,
    }),
  );

  return foldUpdates(updates);
}

/** One assistant history message carrying `content`. */
function assistantPage(id: string, content: unknown): ReturnType<typeof parseHistoryPage> {
  return parseHistoryPage([
    {
      id,
      messageType: "assistant_message",
      role: "assistant",
      body: { content },
      runId: "run-payload",
      at: null,
    },
  ]);
}

describe("large payloads survive the content layer", () => {
  it("keeps a 100k-character assistant body on the streaming and one-shot paths", () => {
    const text = "0123456789abcdef".repeat(6_250);
    expect(text).toHaveLength(100_000);

    const live = streamAssistant("payload-live", text, 4_000);
    expect(live).toHaveLength(1);
    const liveBlock = live[0] as TextBlock;
    expect(liveBlock.type).toBe("text");
    expect(liveBlock.text).toHaveLength(text.length);
    expect(liveBlock.text).toBe(text);

    const oneShot = assistantPage("payload-history", text);
    expect(oneShot).toHaveLength(1);
    const historyBlock = oneShot[0] as TextBlock;
    expect(historyBlock.type).toBe("text");
    expect(historyBlock.text).toHaveLength(text.length);
    expect(historyBlock.text).toBe(text);
    expect(historyBlock.text).toBe(liveBlock.text);
  });

  it("passes a 1 MiB base64 image through without decoding it", () => {
    const data = "A".repeat(1024 * 1024);
    const blocks = parseHistoryPage([
      {
        id: "payload-image",
        messageType: "user_message",
        role: "user",
        body: {
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data },
            },
          ],
        },
        runId: "run-payload",
        at: null,
      },
    ]);

    expect(blocks).toHaveLength(1);
    const image = blocks[0] as ImageBlock;
    expect(image.type).toBe("image");
    expect(image.source.kind).toBe("base64");
    if (image.source.kind !== "base64") {
      throw new Error("expected a base64 image source");
    }
    expect(image.source.data).toHaveLength(data.length);
    expect(image.source.data).toBe(data);
    expect(image.alt).toBeNull();
  });

  it("keeps a 50 MiB tool result verbatim through a JSON round trip", () => {
    const payload = "0123456789abcdef".repeat(3_276_800);
    expect(payload).toHaveLength(50 * 1024 * 1024);

    const blocks = parseHistoryPage([
      {
        id: "payload-tool",
        messageType: "tool_return_message",
        role: "tool",
        body: {
          tool_call_id: "call-big",
          status: "success",
          tool_return: payload,
        },
        runId: "run-payload",
        at: null,
      },
    ]);

    expect(blocks).toHaveLength(1);
    const tool = blocks[0] as ToolCallBlock;
    expect(tool.type).toBe("tool_call");
    expect(tool.orphan).toBe(true);
    expect(typeof tool.result).toBe("string");
    expect(tool.result).toHaveLength(payload.length);
    expect(tool.result).toBe(payload);

    const roundTrip = JSON.parse(JSON.stringify(tool)) as ToolCallBlock;
    expect(typeof roundTrip.result).toBe("string");
    expect(roundTrip.result).toHaveLength(payload.length);
    expect(roundTrip.result).toBe(payload);
  }, 60_000);
});
