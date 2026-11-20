/**
 * Replay of a real engine recording: the merger turns recorded `s2c` frames
 * into changes, and two independent content models turn those changes into the
 * same upsert stream and the same folded blocks.
 *
 * This complements `replay.test.ts`: that suite drives hand-built
 * `MergerChange`s, which proves the content layer is deterministic but not that
 * a recorded session survives the whole event-merger-to-content-model path.
 * Here the frames keep their recorded `event_seq`, `runtime` and idempotency
 * key, so the merger's ordering and dedupe run for real.
 *
 * The recording is read only. It is also the fixture that carries an
 * `approval_classification_end` stream delta, which makes the process-event
 * assertion non-vacuous: the merger does deliver it as a `message.final`, and
 * the content model must drop it instead of showing an `unknown` block.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Block, ContentUpdate, ToolCallBlock, UnknownBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { EngineEventFrame } from "../engine/client/index.js";
import { createEventMerger } from "../merge/event-merger.js";
import type { MergerChange } from "../merge/types.js";
import { createContentModel } from "./model.js";

/** `packages/core/src/content` up to the repository root, then the recordings. */
const RECORDINGS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "engine",
  "recordings",
);

type WireEntry = {
  readonly dir: string;
  readonly at: number;
  readonly msg: Record<string, unknown>;
};

/** One recording's client-bound frames, in recorded order. */
function entriesOf(name: string): readonly WireEntry[] {
  const text = readFileSync(path.join(RECORDINGS_DIR, `${name}.jsonl`), "utf8");

  return text.split(/\r?\n/).flatMap((line) => {
    if (line.trim() === "") {
      return [];
    }
    const entry = JSON.parse(line) as WireEntry;
    return entry.dir === "s2c" ? [entry] : [];
  });
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The frame the client would attach to one recorded message.
 *
 * `event_seq` is only passed through when the recording has a real integer;
 * inventing one for the frames that carry none would make the merger order
 * unrelated events. The runtime identity falls back to fixed ids so the two
 * replays agree even for frames recorded without a `runtime` block.
 */
function frameOf(entry: WireEntry): EngineEventFrame {
  const msg = entry.msg;
  const delta = recordOf(msg["delta"]);
  const runtime = recordOf(msg["runtime"]);
  const seq = msg["event_seq"];
  const key = stringOf(msg["idempotency_key"]);
  const agentId =
    stringOf(delta?.["agent_id"]) ?? stringOf(runtime?.["agent_id"]) ?? "agent-recording";
  const conversationId =
    stringOf(delta?.["conversation_id"]) ??
    stringOf(runtime?.["conversation_id"]) ??
    "conv-recording";

  return {
    type: stringOf(msg["type"]) ?? "",
    raw: msg,
    at: entry.at,
    envelope: {
      ...(typeof seq === "number" && Number.isInteger(seq) ? { event_seq: seq } : {}),
      runtime: { agent_id: agentId, conversation_id: conversationId },
      ...(key === null ? {} : { idempotency_key: key }),
    },
  };
}

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

type Replay = {
  readonly changes: readonly MergerChange[];
  readonly updates: readonly ContentUpdate[];
  readonly blocks: readonly Block[];
};

/** Run the whole recorded session through one merger and one content model. */
function replay(entries: readonly WireEntry[]): Replay {
  const merger = createEventMerger({ agentId: "agent-recording" });
  const model = createContentModel();
  const changes: MergerChange[] = [];
  const updates: ContentUpdate[] = [];

  for (const entry of entries) {
    for (const change of merger.ingest(frameOf(entry))) {
      changes.push(change);
      updates.push(...model.ingest(change));
    }
  }

  return { changes, updates, blocks: foldUpdates(updates) };
}

describe("a real recording replays through the whole path", () => {
  it("two independent models emit the same updates and the same folded blocks", () => {
    const entries = entriesOf("approval");
    expect(entries.length).toBeGreaterThan(0);

    const first = replay(entries);
    const second = replay(entries);

    expect(second.updates).toStrictEqual(first.updates);
    expect(second.blocks).toStrictEqual(first.blocks);
    expect(first.blocks.length).toBeGreaterThan(0);
  });

  it("drops the recorded approval_classification_end instead of making an unknown block", () => {
    const entries = entriesOf("approval");
    const classificationFrames = entries.filter(
      (entry) => recordOf(entry.msg["delta"])?.["message_type"] === "approval_classification_end",
    );

    // Non-vacuity: the recording really carries the event, and the merger
    // really delivers it as a final change.
    expect(classificationFrames).toHaveLength(1);
    const result = replay(entries);
    expect(
      result.changes.some(
        (change) =>
          change.kind === "message.final" && change.messageType === "approval_classification_end",
      ),
    ).toBe(true);

    const unknown = result.blocks.filter(
      (block): block is UnknownBlock => block.type === "unknown",
    );
    expect(unknown.map((block) => block.rawType)).not.toContain("approval_classification_end");
    expect(unknown).toEqual([]);
  });

  it("folds the recorded tool lifecycle into one block with the last return", () => {
    const tools = replay(entriesOf("approval")).blocks.filter(
      (block): block is ToolCallBlock => block.type === "tool_call",
    );

    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (tool === undefined) {
      throw new Error("expected one recorded tool block");
    }
    expect(tool).toMatchObject({
      id: "tool:call_00_vbdPg4EJlimwePztEYG20737",
      name: "Bash",
      status: "success",
      orphan: false,
    });
    // Two returns were recorded; the later one ends with CRLF.
    expect(tool.result).toBe("a3-approval-ok\r\n");
  });
});
