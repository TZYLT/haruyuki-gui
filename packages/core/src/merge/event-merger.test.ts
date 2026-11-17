/**
 * The merge loop's own tests: the order of work inside `ingest`, the branches
 * that produce no change, and the two reset behaviours a reconnect depends on.
 *
 * The per-module tests already cover ordering and mapping in isolation. What is
 * checked here is the wiring: that a duplicate is refused before it spends a
 * buffer slot, that a turn end closes the messages it owns before it reports
 * itself, that terminal bytes never become a change, and that a reset keeps a
 * half-streamed message without keeping its old numbering.
 */

import { describe, expect, it } from "vitest";

import type { EngineEventFrame } from "../engine/client/index.js";

import { createEventMerger } from "./event-merger.js";
import type { MergerChange } from "./types.js";

const RUNTIME = { agent_id: "agent-a", conversation_id: "conv-1" };

/** One sequenced frame with the given event number. */
function frame(
  seq: number,
  raw: Record<string, unknown>,
  extra: { readonly key?: string; readonly at?: number } = {},
): EngineEventFrame {
  return {
    type: String(raw["type"] ?? "stream_delta"),
    raw,
    at: extra.at ?? 1_000 + seq,
    envelope: {
      event_seq: seq,
      ...(extra.key === undefined ? {} : { idempotency_key: extra.key }),
      runtime: RUNTIME,
    },
  };
}

/** One delta of an assistant message. */
function delta(seqId: number, text: string, id = "m-1", runId = "r-1"): Record<string, unknown> {
  return {
    type: "stream_delta",
    delta: {
      message_type: "assistant_message",
      id,
      run_id: runId,
      seq_id: seqId,
      content: [{ type: "text", text }],
    },
  };
}

/** A usage report for the given run. */
function usage(runId = "r-1"): Record<string, unknown> {
  return {
    type: "stream_delta",
    delta: {
      message_type: "usage_statistics",
      run_id: runId,
      prompt_tokens: 5,
      total_tokens: 7,
    },
  };
}

/** A turn end. */
function finished(runId = "r-1"): Record<string, unknown> {
  return { type: "turn_finished", turn_id: "t-1", run_id: runId, stop_reason: "end_turn" };
}

/** The change kinds produced, in order. */
function kinds(changes: readonly MergerChange[]): string[] {
  return changes.map((change) => change.kind);
}

describe("createEventMerger delivery", () => {
  it("emits one delta per piece and hands the same changes to subscribers", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const seen: MergerChange[] = [];

    merger.subscribe((change) => seen.push(change));

    const changes = [
      ...merger.ingest(frame(1, delta(1, "he"))),
      ...merger.ingest(frame(2, delta(2, "llo"))),
    ];

    expect(kinds(changes)).toEqual(["message.delta", "message.delta"]);
    expect(seen.map((change) => change.kind)).toEqual(["message.delta", "message.delta"]);
    expect(changes.map((change) => (change.kind === "message.delta" ? change.text : ""))).toEqual([
      "he",
      "llo",
    ]);
  });

  it("refuses a repeated event number and counts it", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "he")));
    const again = merger.ingest(frame(1, delta(1, "he")));

    expect(again).toEqual([]);
    expect(merger.stats().duplicates).toBe(1);
    expect(merger.stats().orderedFrames).toBe(1);
  });

  it("refuses a repeated idempotency key even under a new event number", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "he"), { key: "k-1" }));
    const again = merger.ingest(frame(2, delta(2, "llo"), { key: "k-1" }));

    expect(again).toEqual([]);
    expect(merger.stats().duplicates).toBe(1);
  });

  it("isolates a throwing subscriber from the other one", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const seen: string[] = [];

    merger.subscribe(() => {
      throw new Error("consumer failed");
    });
    merger.subscribe((change) => seen.push(change.kind));

    merger.ingest(frame(1, delta(1, "he")));

    expect(seen).toEqual(["message.delta"]);
  });
});

describe("createEventMerger turn lifecycle", () => {
  it("closes the open message before it reports the turn end, and attaches the usage", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "he")));
    merger.ingest(frame(2, usage()));

    const changes = merger.ingest(frame(3, finished()));

    expect(kinds(changes)).toEqual(["message.complete", "turn.finished"]);

    const end = changes[1];

    if (end === undefined || end.kind !== "turn.finished") {
      throw new Error("expected a turn end");
    }

    expect(end.incomplete).toBe(false);
    expect(end.usage?.totalTokens).toBe(7);
    expect(end.stopReason).toBe("end_turn");
  });

  it("marks a turn incomplete when a gap was declared in it", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "he")));

    // 257 held frames exceed the buffer, so the hole at 2 is declared and the
    // stream moves on rather than waiting forever.
    for (let seq = 3; seq <= 259; seq += 1) {
      merger.ingest(frame(seq, delta(seq, "x")));
    }

    expect(merger.stats().gaps).toBe(1);

    const changes = merger.ingest(frame(260, finished()));
    const end = changes.find((change) => change.kind === "turn.finished");

    expect(end !== undefined && end.kind === "turn.finished" && end.incomplete).toBe(true);
    expect(merger.stats().incompleteTurns).toBe(1);
  });

  it("closes a subagent's message on stop_reason, without a turn end", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    const subagentDelta = {
      type: "stream_delta",
      subagent_id: "sub-1",
      delta: {
        message_type: "assistant_message",
        id: "m-2",
        run_id: "r-2",
        seq_id: 1,
        session_id: "agent-sub",
        content: [{ type: "text", text: "sub" }],
      },
    };

    merger.ingest(frame(1, subagentDelta));
    const changes = merger.ingest(
      frame(2, {
        type: "stream_delta",
        delta: {
          message_type: "stop_reason",
          agent_id: null,
          session_id: "agent-sub",
          stop_reason: "end_turn",
        },
      }),
    );

    expect(kinds(changes)).toEqual(["message.complete", "turn.stopped"]);

    const stop = changes[1];

    if (stop === undefined || stop.kind !== "turn.stopped") {
      throw new Error("expected a stop");
    }

    // The author fallback chain puts the subagent's own session id first.
    expect(stop.authorAgentId).toBe("agent-sub");
  });

  it("pauses on requires_approval instead of closing the message", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "before")));
    const paused = merger.ingest(
      frame(2, {
        type: "stream_delta",
        delta: {
          message_type: "stop_reason",
          run_id: "r-1",
          stop_reason: "requires_approval",
        },
      }),
    );

    expect(kinds(paused)).toEqual(["turn.stopped"]);

    // The answer keeps growing after the approval, so the message stays open.
    const after = merger.ingest(frame(3, delta(2, " after")));

    expect(kinds(after)).toEqual(["message.delta"]);
  });

  it("announces a restart before the first piece of the new run", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    // The run began mid-message, so the first accepted piece was number two;
    // an unseen number one is therefore the engine starting over.
    merger.ingest(frame(1, delta(2, "old ")));
    merger.ingest(frame(2, delta(3, "text")));

    const changes = merger.ingest(frame(3, delta(1, "new ")));

    expect(kinds(changes)).toEqual(["message.reset", "message.delta"]);
  });

  it("does not reset a message when a finished one is pushed again", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "done")));
    merger.ingest(frame(2, finished()));

    const again = merger.ingest(frame(3, delta(1, "done")));

    // Nothing is open any more, so this is a new run that happens to share the
    // id; no reset may be announced, or the text already on screen would clear.
    expect(kinds(again)).toEqual(["message.delta"]);
  });
});

describe("createEventMerger pass-through branches", () => {
  it("sends terminal bytes to the frame sink and never to the change stream", () => {
    const frames: string[] = [];
    const merger = createEventMerger({
      agentId: "agent-a",
      onFrame: (terminal) => frames.push((terminal.body as { text?: string }).text ?? ""),
    });

    const changes = merger.ingest({
      type: "terminal_output",
      raw: { type: "terminal_output", terminal_id: "t-1", data: "hi" },
      at: 1,
    });

    expect(changes).toEqual([]);
    expect(frames).toEqual(["hi"]);
    expect(merger.stats().terminalDropped).toBe(0);
  });

  it("counts a terminal frame with no sink as dropped", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest({
      type: "terminal_output",
      raw: { type: "terminal_output", terminal_id: "t-1", data: "hi" },
      at: 1,
    });

    expect(merger.stats().terminalDropped).toBe(1);
  });

  it("maps a control request to an approval change", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    const changes = merger.ingest({
      type: "control_request",
      raw: { type: "control_request", request_id: "req-9" },
      at: 1,
    });

    expect(kinds(changes)).toEqual(["approval.requested"]);
    expect(changes[0]?.kind === "approval.requested" && changes[0].requestId).toBe("req-9");
  });

  it("counts an unknown event and emits nothing", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    const changes = merger.ingest({ type: "something_new", raw: { type: "something_new" }, at: 1 });

    expect(changes).toEqual([]);
    expect(merger.stats().unknownTypes).toBe(1);
  });

  it("passes a late answer through instead of calling its type unknown", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    const changes = merger.ingest({
      type: "sync_response",
      raw: { type: "sync_response", request_id: "req-late" },
      at: 1,
    });

    expect(kinds(changes)).toEqual(["passthrough"]);
    expect(merger.stats().unknownTypes).toBe(0);
    expect(merger.stats().passthroughFrames).toBe(1);
  });

  it("passes a known informational event through", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    const changes = merger.ingest({
      type: "memory_updated",
      raw: { type: "memory_updated", memory: [] },
      at: 1,
    });

    expect(kinds(changes)).toEqual(["passthrough"]);
    expect(merger.stats().passthroughFrames).toBe(1);
  });
});

describe("createEventMerger reset", () => {
  it("keeps the half-streamed message and adopts the next number as the new base", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    merger.ingest(frame(1, delta(1, "half")));
    expect(merger.watermark()).toBe(1);

    merger.reset("silent");

    expect(merger.watermark()).toBeNull();
    expect(merger.stats().resetReason).toBe("silent");

    const changes = merger.ingest(frame(9, delta(2, " message")));

    expect(kinds(changes)).toEqual(["message.delta"]);
    expect(changes[0]?.kind === "message.delta" && changes[0].text).toBe(" message");
    expect(merger.watermark()).toBe(9);
  });

  it("does not clear subscribers or the statistics on reset", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const seen: string[] = [];

    merger.subscribe((change) => seen.push(change.kind));
    merger.ingest(frame(1, delta(1, "a")));
    merger.reset("user-retry");
    merger.ingest(frame(2, delta(2, "b")));

    expect(seen).toEqual(["message.delta", "message.delta"]);
    expect(merger.stats().orderedFrames).toBe(2);
  });
});
