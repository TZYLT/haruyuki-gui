/**
 * Replay and idempotence: feeding the same recorded changes to this layer must
 * produce the same updates, every time, whoever feeds them.
 *
 * Three guarantees are pinned here:
 *
 * 1. **Same input, same updates.** Two independent models replaying one
 *    recording emit deep-equal `ContentUpdate` streams, ids included. Nothing
 *    may depend on wall-clock time, randomness or arrival order.
 * 2. **Reset is a clean slate.** One model that replays a recording, resets and
 *    replays it again emits exactly what it emitted the first time.
 * 3. **Replay does not duplicate.** A recorded tool lifecycle (approval, client
 *    start, interim return, end marker, final return) plus reasoning fragments
 *    folds into one tool card and one reasoning block -- never two -- and the
 *    same call id is never given a second block.
 *
 * The recordings are hand-built `MergerChange` sequences in the shape the
 * upstream merger emits, not parser internals, so these tests fail if replay
 * behaviour changes rather than if a helper is renamed.
 */

import type { Block, BlockId, ContentUpdate } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { createContentModel } from "./model.js";
import type { ContentModel } from "./types.js";

type Delta = Extract<MergerChange, { kind: "message.delta" }>;
type Final = Extract<MergerChange, { kind: "message.final" }>;
type Complete = Extract<MergerChange, { kind: "message.complete" }>;
type Finished = Extract<MergerChange, { kind: "turn.finished" }>;

const AT = 1_700_000_000_000;
const RUN = "run-replay";

/** Fields every merger change carries; the tests only vary the clock here. */
function base(at: number) {
  return {
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId: "conv-replay",
    at,
  };
}

function deltaChange(messageId: string, text: string, at: number): Delta {
  return {
    ...base(at),
    kind: "message.delta",
    messageId,
    runId: RUN,
    runSeq: 1,
    text,
    parts: [],
    first: false,
  };
}

function finalChange(messageId: string, messageType: string, body: unknown, at: number): Final {
  return { ...base(at), kind: "message.final", messageId, runId: RUN, messageType, body };
}

function completeChange(messageId: string, at: number): Complete {
  return {
    ...base(at),
    kind: "message.complete",
    messageId,
    runId: RUN,
    textLength: 0,
    incomplete: false,
  };
}

function turnFinishedChange(at: number): Finished {
  return {
    ...base(at),
    kind: "turn.finished",
    turnId: "turn-1",
    runId: RUN,
    stopReason: "end_turn",
    usage: null,
    incomplete: false,
  };
}

/** Feed a whole recording to one model and keep every update it emitted. */
function run(model: ContentModel, changes: readonly MergerChange[]): readonly ContentUpdate[] {
  const updates: ContentUpdate[] = [];
  for (const change of changes) {
    updates.push(...model.ingest(change));
  }
  return updates;
}

/** Fold an update stream the way the store does: upsert by id, keep the first slot. */
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

/** Every block id the folded sequence contains, in order. */
function idsOf(blocks: readonly Block[]): readonly BlockId[] {
  return blocks.map((block) => block.id);
}

/** Prose, a fence, a tool call and a reasoning segment, in that order. */
function recording(at: number = AT): readonly MergerChange[] {
  return [
    deltaChange("msg-a", "Here is the plan.\n", at),
    deltaChange("msg-a", "```ts\nconst answer = 42;\n", at),
    deltaChange("msg-a", "```\n", at),
    deltaChange("msg-a", "All done.", at),
    completeChange("msg-a", at),
    finalChange(
      "msg-tc",
      "tool_call_message",
      { tool_call_id: "call-1", name: "shell", arguments: '{"cmd":"ls"}' },
      at,
    ),
    finalChange(
      "msg-tr",
      "tool_return_message",
      { tool_call_id: "call-1", status: "success", tool_return: "a.txt\n" },
      at,
    ),
    finalChange("msg-r:reasoning:0", "reasoning_message", { reasoning: "Let me ", seq_id: 0 }, at),
    finalChange("msg-r:reasoning:0", "reasoning_message", { reasoning: "explain.", seq_id: 1 }, at),
    turnFinishedChange(at),
  ];
}

/** One recorded client-side tool lifecycle plus two reasoning fragments. */
function toolRecording(at: number = AT): readonly MergerChange[] {
  return [
    finalChange(
      "tc-approval",
      "approval_request_message",
      { tool_call: { tool_call_id: "call-9", name: "shell", arguments: '{"cmd":"echo hi"}' } },
      at,
    ),
    finalChange(
      "tc-decision",
      "approval_response_message",
      { tool_call_id: "call-9", decision: "approve" },
      at,
    ),
    finalChange(
      "tc-start",
      "client_tool_start",
      { tool_call_id: "call-9", name: "shell", tool_args: '{"cmd":"echo hi"}' },
      at,
    ),
    finalChange(
      "tc-snapshot",
      "tool_return_message",
      { tool_call_id: "call-9", status: "success", tool_return: "hi\n" },
      at,
    ),
    finalChange("tc-end", "client_tool_end", { tool_call_id: "call-9", status: "success" }, at),
    finalChange(
      "tc-final",
      "tool_return_message",
      { tool_call_id: "call-9", status: "success", tool_return: "hi there\n" },
      at,
    ),
    finalChange(
      "msg-t:reasoning:0",
      "reasoning_message",
      { reasoning: "Checking ", seq_id: 0 },
      at,
    ),
    finalChange(
      "msg-t:reasoning:0",
      "reasoning_message",
      { reasoning: "the tool.", seq_id: 1 },
      at,
    ),
  ];
}

describe("replay is deterministic and idempotent", () => {
  it("two independent instances emit the same update stream", () => {
    const changes = recording();
    const first = run(createContentModel(), changes);
    const second = run(createContentModel(), changes);

    expect(second).toEqual(first);
    expect(idsOf(foldUpdates(first))).toEqual([
      "msg-a:text:0",
      "msg-a:code:0",
      "msg-a:text:1",
      "tool:call-1",
      "msg-r:reasoning:0",
    ]);
  });

  it("arrival time never reaches a block id", () => {
    const early = run(createContentModel(), recording(AT));
    const late = run(createContentModel(), recording(AT + 5 * 60_000));

    expect(late).toEqual(early);
  });

  it("reset followed by the same replay emits the same updates again", () => {
    const changes = recording();
    const model = createContentModel();
    const first = run(model, changes);

    model.reset();
    expect(model.stats().inFlightMessages).toBe(0);
    expect(model.stats().inFlightToolCalls).toBe(0);

    const second = run(model, changes);
    expect(second).toEqual(first);
    expect(idsOf(foldUpdates(second))).toEqual(idsOf(foldUpdates(first)));
  });

  it("a recorded tool lifecycle replays into one tool block and one reasoning block", () => {
    const first = run(createContentModel(), toolRecording());
    const second = run(createContentModel(), toolRecording());

    const firstBlocks = foldUpdates(first);
    const secondBlocks = foldUpdates(second);

    expect(second).toEqual(first);
    expect(secondBlocks).toEqual(firstBlocks);
    expect(idsOf(secondBlocks)).toEqual(idsOf(firstBlocks));

    // No doubling: one card per call id, one block per reasoning segment.
    expect(firstBlocks.filter((block) => block.type === "tool_call")).toHaveLength(1);
    expect(firstBlocks.filter((block) => block.type === "reasoning")).toHaveLength(1);
    expect(new Set(idsOf(firstBlocks)).size).toBe(firstBlocks.length);

    expect(firstBlocks).toEqual([
      {
        id: "tool:call-9",
        messageId: "tc-approval",
        runId: RUN,
        role: "tool",
        type: "tool_call",
        toolCallId: "call-9",
        name: "shell",
        argumentsText: '{"cmd":"echo hi"}',
        result: "hi there\n",
        status: "success",
        orphan: false,
      },
      {
        id: "msg-t:reasoning:0",
        messageId: "msg-t",
        runId: RUN,
        role: "assistant",
        type: "reasoning",
        text: "Checking the tool.",
      },
    ]);
  });

  it("replaying the tool recording after a reset does not double the tool", () => {
    const changes = toolRecording();
    const model = createContentModel();
    const first = foldUpdates(run(model, changes));

    model.reset();
    const second = foldUpdates(run(model, changes));

    expect(second).toEqual(first);
    expect(second.filter((block) => block.type === "tool_call")).toHaveLength(1);
    expect(new Set(idsOf(second)).size).toBe(second.length);
  });
});
