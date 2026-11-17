/**
 * Hardening checks that sit between the per-module tests and the acceptance
 * suite: the fallback that heals a frozen stream, the bound on the assembly
 * table, and the "unknown means unknown" count under many distinct types.
 *
 * These are the paths that only a long or unlucky session reaches, which is why
 * they are not covered by replaying a recording: no recording contains 32 late
 * frames, 600 messages, or a hundred event types the build has never seen.
 */

import { describe, expect, it } from "vitest";

import type { EngineEventFrame } from "../engine/client/index.js";

import { createAssembler } from "./assemble.js";
import { createEventMerger } from "./event-merger.js";

const RUNTIME = { agent_id: "agent-a", conversation_id: "conv-1" };

/** One sequenced frame with the given event number. */
function frame(seq: number, raw: Record<string, unknown>): EngineEventFrame {
  return {
    type: String(raw["type"] ?? "stream_delta"),
    raw,
    at: 1_000 + seq,
    envelope: { event_seq: seq, runtime: RUNTIME },
  };
}

/** One delta of an assistant message. */
function delta(seqId: number, text: string, id = "m-1"): Record<string, unknown> {
  return {
    type: "stream_delta",
    delta: {
      message_type: "assistant_message",
      id,
      run_id: "r-1",
      seq_id: seqId,
      content: [{ type: "text", text }],
    },
  };
}

describe("stream healing", () => {
  it("rebaselines after a run of late frames and reports it", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    // A reconnected stream that continues at 47: the first frame becomes the
    // new base, so 47 is delivered and everything below it looks late.
    merger.ingest(frame(1, delta(1, "a")));
    merger.reset("silent");
    merger.ingest(frame(47, delta(2, "b")));

    expect(merger.watermark()).toBe(47);

    // 32 numbers below the watermark that were never delivered: the fallback
    // pulls the watermark back instead of dropping the stream forever.
    for (let seq = 1; seq <= 32; seq += 1) {
      merger.ingest(frame(seq, delta(seq + 2, "x")));
    }

    expect(merger.stats().rebaselines).toBe(1);
    expect(merger.stats().lastRebaselineAt).not.toBeNull();
  });
});

describe("assembly bound", () => {
  it("forgets the least recently used message once the table is full", () => {
    const assembler = createAssembler({ limit: 2 });

    assembler.push({
      authorAgentId: "agent-a",
      subagentId: null,
      messageId: "m-1",
      runId: "r-1",
      runSeq: 1,
      parts: [{ type: "text", text: "one" }],
      at: 1,
    });
    assembler.push({
      authorAgentId: "agent-a",
      subagentId: null,
      messageId: "m-2",
      runId: "r-1",
      runSeq: 1,
      parts: [{ type: "text", text: "two" }],
      at: 2,
    });
    assembler.push({
      authorAgentId: "agent-a",
      subagentId: null,
      messageId: "m-3",
      runId: "r-1",
      runSeq: 1,
      parts: [{ type: "text", text: "three" }],
      at: 3,
    });

    expect(assembler.size()).toBe(2);
    expect(assembler.complete("agent-a", null, "m-1")).toBeNull();
    expect(assembler.complete("agent-a", null, "m-3")?.textLength).toBe(5);
  });
});

describe("unknown types", () => {
  it("counts a hundred distinct unknown types without failing", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    for (let index = 0; index < 100; index += 1) {
      const changes = merger.ingest({
        type: `never_heard_of_${index}`,
        raw: { type: `never_heard_of_${index}` },
        at: index,
      });

      expect(changes).toEqual([]);
    }

    expect(merger.stats().unknownTypes).toBe(100);
  });
});
