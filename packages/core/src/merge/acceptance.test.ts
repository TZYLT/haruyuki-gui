/**
 * Acceptance tests: the properties a consumer relies on across a whole session.
 *
 * Isolation, immutability, bounds, unknown types, reset placement and a full
 * corpus replay. Each one is a promise that is cheap to state and expensive to
 * lose: two mergers sharing a watermark, a change rewriting itself under a
 * subscriber, an unbounded table, or a reconnect whose reset no longer matches
 * the numbering that follows it.
 *
 * The corpus half reuses the same frame construction as the integration suite:
 * envelope fields lifted out of the wire message, the message itself as `raw`.
 * Synthetic frames are used where the property is about volume or numbering
 * rather than about recorded content.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  EngineEventEnvelope,
  EngineEventFrame,
  RuntimeScope,
} from "../engine/client/index.js";
import { loadFixture } from "../testing/index.js";

import { asRecord, readString } from "./envelope.js";
import { createEventMerger } from "./event-merger.js";
import type { EventMerger, MergerChange } from "./types.js";

/** The recorded sessions, by scenario name. */
const RECORDINGS = [
  "approval",
  "compaction",
  "memory",
  "subagent",
  "terminal",
  "tool-call",
  "user-message",
] as const;

type RecordingName = (typeof RECORDINGS)[number];

/** `packages/core/src/merge` up to the repository root: four levels. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** The runtime every synthetic frame reports. */
const RUNTIME: RuntimeScope = { agent_id: "agent-a", conversation_id: "conv-1" };

/**
 * One recording's replayable messages, in recorded order.
 *
 * @param name the scenario
 */
async function messagesOf(name: RecordingName): Promise<readonly Record<string, unknown>[]> {
  const fixture = await loadFixture(
    path.join(REPO_ROOT, "fixtures", "engine", "recordings", `${name}.jsonl`),
  );

  return fixture.lines.filter((line) => line.dir === "s2c").map((line) => line.msg);
}

/**
 * `msg.runtime` as the client's scope shape, or `undefined` when unusable.
 *
 * @param value the raw runtime block
 */
function runtimeScopeOf(value: unknown): RuntimeScope | undefined {
  const record = asRecord(value);
  const conversationId = readString(record?.["conversation_id"]);

  if (conversationId === null) {
    return undefined;
  }

  return { agent_id: readString(record?.["agent_id"]), conversation_id: conversationId };
}

/**
 * The envelope the client would attach to one wire message.
 *
 * @param msg one wire message
 */
function envelopeOf(msg: Record<string, unknown>): EngineEventEnvelope | undefined {
  const seq = msg["event_seq"];

  if (typeof seq !== "number") {
    return undefined;
  }

  const runtime = runtimeScopeOf(msg["runtime"]);
  const key = readString(msg["idempotency_key"]);

  return {
    event_seq: seq,
    ...(runtime === undefined ? {} : { runtime }),
    ...(key === null ? {} : { idempotency_key: key }),
  };
}

/**
 * The frames a recording turns into.
 *
 * @param messages the recording's `s2c` messages
 */
function framesOf(messages: readonly Record<string, unknown>[]): readonly EngineEventFrame[] {
  return messages.map((msg, index) => {
    const envelope = envelopeOf(msg);

    return {
      type: readString(msg["type"]) ?? "",
      raw: msg,
      at: index,
      ...(envelope === undefined ? {} : { envelope }),
    };
  });
}

/**
 * Ingest every frame and return the changes.
 *
 * @param merger the merger under test
 * @param frames the frames to feed
 */
function feed(merger: EventMerger, frames: readonly EngineEventFrame[]): readonly MergerChange[] {
  const changes: MergerChange[] = [];

  for (const frame of frames) {
    changes.push(...merger.ingest(frame));
  }

  return changes;
}

/** A sequenced frame carrying one known event type. */
function loopFrame(seq: number): EngineEventFrame {
  return {
    type: "update_loop_status",
    raw: { type: "update_loop_status", loop_status: { status: "IDLE" } },
    at: seq,
    envelope: { event_seq: seq, runtime: RUNTIME },
  };
}

/** A sequenced assistant delta. */
function deltaFrame(seq: number, seqId: number, text: string, messageId = "m-1"): EngineEventFrame {
  return {
    type: "stream_delta",
    raw: {
      type: "stream_delta",
      delta: {
        message_type: "assistant_message",
        id: messageId,
        run_id: "r-1",
        seq_id: seqId,
        content: [{ type: "text", text }],
      },
    },
    at: seq,
    envelope: { event_seq: seq, runtime: RUNTIME },
  };
}

/** A sequenced turn end. */
function finishedFrame(seq: number): EngineEventFrame {
  return {
    type: "turn_finished",
    raw: { type: "turn_finished", turn_id: "t-1", run_id: "r-1", stop_reason: "end_turn" },
    at: seq,
    envelope: { event_seq: seq, runtime: RUNTIME },
  };
}

/** A frame with no sequence number, which the merger delivers immediately. */
function unorderedFrame(raw: Record<string, unknown>): EngineEventFrame {
  return { type: String(raw["type"]), raw, at: 0 };
}

describe("two mergers", () => {
  it("keep their watermarks and counters independent when fed interleaved", () => {
    const a = createEventMerger({ agentId: "agent-a" });
    const b = createEventMerger({ agentId: "agent-b" });

    a.ingest(loopFrame(1));
    b.ingest(loopFrame(1));
    a.ingest(loopFrame(2));
    b.ingest(loopFrame(1)); // a repeat on b's channel only
    a.ingest(loopFrame(3));

    expect(a.watermark()).toBe(3);
    expect(b.watermark()).toBe(1);
    expect(a.stats().orderedFrames).toBe(3);
    expect(b.stats().orderedFrames).toBe(1);
    expect(a.stats().duplicates).toBe(0);
    expect(b.stats().duplicates).toBe(1);
  });
});

describe("change immutability", () => {
  it("never rewrites a change that was already handed to a subscriber", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const first: MergerChange[] = [];
    const second: MergerChange[] = [];

    merger.subscribe((change) => first.push(change));
    merger.subscribe((change) => second.push(change));

    feed(merger, [deltaFrame(1, 1, "hello")]);

    const captured = first.at(0);
    // Copy the parts: holding the array itself would compare the live array with
    // itself and pass no matter what a later delta does to it.
    const snapshot =
      captured?.kind === "message.delta"
        ? { text: captured.text, parts: [...captured.parts] }
        : null;

    expect(snapshot).toEqual({ text: "hello", parts: [{ type: "text", text: "hello" }] });

    // More text for the same message; the change already delivered must not grow
    // with it, or a consumer that renders on subscription would rewrite history.
    feed(merger, [deltaFrame(2, 2, " world")]);

    const after =
      captured?.kind === "message.delta"
        ? { text: captured.text, parts: [...captured.parts] }
        : null;

    expect(after).toEqual(snapshot);
    expect(after?.parts).toHaveLength(1);
    expect(second.at(0)).toEqual(captured);
    expect(second.map((change) => change.kind)).toEqual(first.map((change) => change.kind));
    expect(second.at(1)).toEqual(first.at(1));
  });
});

describe("bounded assembly", () => {
  it("streams ten thousand deltas of one message without collapsing it", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const texts: string[] = [];
    const partCounts: number[] = [];

    for (let index = 1; index <= 10_000; index += 1) {
      for (const change of merger.ingest(deltaFrame(index, index, "x"))) {
        if (change.kind !== "message.delta") {
          continue;
        }

        texts.push(change.text);
        partCounts.push(change.parts.length);
      }
    }

    expect(texts).toHaveLength(10_000);
    expect(texts.join("")).toBe("x".repeat(10_000));

    // `parts` is the message so far, not the delta's own share: the last delta
    // has to carry all ten thousand, and the list only grows.
    expect(partCounts[0]).toBe(1);
    expect(partCounts.at(-1)).toBe(10_000);
    expect(
      partCounts.every((count, index) => index === 0 || count >= (partCounts[index - 1] ?? 0)),
    ).toBe(true);

    // A second message does not displace the first; closing the turn reports
    // both, each with its own size.
    merger.ingest(deltaFrame(10_001, 1, "y", "m-2"));

    const closed = merger.ingest(finishedFrame(10_002));
    const completes = closed.filter((change) => change.kind === "message.complete");
    const lengths = completes.map((change) =>
      change.kind === "message.complete" ? change.textLength : -1,
    );
    const ids = completes.map((change) =>
      change.kind === "message.complete" ? change.messageId : "",
    );

    expect(ids).toEqual(["m-1", "m-2"]);
    expect(lengths).toEqual([10_000, 1]);
  });
});

describe("unknown event types", () => {
  it("counts fifty distinct unknown types and produces no changes", () => {
    const merger = createEventMerger({ agentId: "agent-a" });
    const produced: MergerChange[] = [];

    expect(() => {
      for (let index = 0; index < 50; index += 1) {
        produced.push(...merger.ingest(unorderedFrame({ type: `synthetic_unknown_${index}` })));
      }
    }).not.toThrow();

    expect(produced).toHaveLength(0);
    expect(merger.stats().unknownTypes).toBe(50);
  });
});

describe("reset at a connection boundary", () => {
  it("adopts the first frame after a reset as the new base", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    feed(merger, [loopFrame(1), loopFrame(2), loopFrame(3)]);
    merger.reset("reconnect-reset");
    feed(merger, [loopFrame(7)]);

    // 7 continues a numbering the old connection never reached; without the
    // reset it would be held waiting for 4..6 forever.
    expect(merger.stats().late).toBe(0);
    expect(merger.stats().resetReason).toBe("reconnect-reset");
    expect(merger.watermark()).toBe(7);
  });

  it("counts a frame from the old numbering as late after the base moved", () => {
    const merger = createEventMerger({ agentId: "agent-a" });

    feed(merger, [loopFrame(1), loopFrame(2), loopFrame(3)]);

    // The reset is moved behind the frame it was meant to precede: 7 is held
    // waiting for 4..6 instead of becoming the new base.
    feed(merger, [loopFrame(7)]);
    expect(merger.watermark()).toBe(3);

    merger.reset("reconnect-reset");
    feed(merger, [loopFrame(7)]);
    expect(merger.stats().late).toBe(0);

    // A frame from the previous numbering now arrives below the base. This is
    // the same assertion as the test above, one frame later: proof that `late`
    // is a live signal rather than a constant zero.
    feed(merger, [loopFrame(5)]);
    expect(merger.stats().late).toBe(1);
  });
});

describe("full corpus replay", () => {
  it("replays all seven recordings through one merger", async () => {
    const byRecording = await Promise.all(
      RECORDINGS.map(async (name) => framesOf(await messagesOf(name))),
    );
    const merger = createEventMerger({ agentId: "agent-a" });
    let changes = 0;

    expect(() => {
      for (const [index, frames] of byRecording.entries()) {
        // Each file is one session whose numbering starts at one again. The
        // boundary is the same reset the reconnect path performs, so the second
        // session's first frame becomes its base instead of looking late.
        if (index > 0) {
          merger.reset("reconnect-reset");
        }

        changes += feed(merger, frames).length;
      }
    }).not.toThrow();

    const sequenced = byRecording.flat().filter((frame) => frame.envelope?.event_seq !== undefined);

    expect(sequenced.length).toBeGreaterThan(0);
    expect(changes).toBeGreaterThan(0);
    expect(merger.stats().orderedFrames).toBe(sequenced.length);
    expect(merger.stats().gaps).toBe(0);
    expect(merger.stats().late).toBe(0);
  });
});
