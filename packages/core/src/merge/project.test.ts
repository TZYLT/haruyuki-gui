/**
 * Tests for the delta classifier.
 *
 * The classifier is the merger's only reading of the engine's polymorphic
 * `stream_delta`, so the cases are the four kinds plus the payloads that must
 * not be forced into one:
 *
 * - an assistant delta is placed by its id and sequence, and becomes `other`
 *   when either is unusable rather than acquiring a made-up value;
 * - a usage payload copies exactly the counts it reported -- a token count the
 *   frame did not mention must be absent, not `0`, because "not reported" and
 *   "zero" are different facts to every consumer that reads a cost;
 * - a stop reason is taken from the payload and nowhere else;
 * - anything that is not a `stream_delta` with a payload is `null`, which is the
 *   merger's signal that another module owns the event.
 */

import { describe, expect, it } from "vitest";

import { classifyDelta, usageOf, type DeltaClassification } from "./project.js";
import type { UsageSnapshot } from "./types.js";

/** One `stream_delta` event around a delta payload. */
function event(delta: unknown): { type: string; delta: unknown } {
  return { type: "stream_delta", delta };
}

/** The usage snapshot of a classification that must be a usage frame. */
function usageFromResult(result: DeltaClassification | null): UsageSnapshot {
  if (result === null || result.kind !== "usage") {
    throw new Error(`expected a usage classification, got ${result?.kind ?? "null"}`);
  }

  return result.usage;
}

describe("classifyDelta", () => {
  it("classifies an assistant delta with its identity and parts", () => {
    const result = classifyDelta(
      event({
        id: "ui-msg-4",
        date: "2026-11-14T13:03:26.611Z",
        agent_id: "agent-local-54b313a7",
        conversation_id: "default",
        message_type: "assistant_message",
        content: [{ type: "text", text: "a" }],
        run_id: "local-run-2",
        seq_id: 1,
        type: "message",
      }),
    );

    expect(result).toEqual({
      kind: "assistant",
      messageId: "ui-msg-4",
      runId: "local-run-2",
      runSeq: 1,
      parts: [{ type: "text", text: "a" }],
    });
  });

  it("classifies an assistant delta without content as having no parts", () => {
    expect(classifyDelta(event({ message_type: "assistant_message", id: "m", seq_id: 1 }))).toEqual(
      {
        kind: "assistant",
        messageId: "m",
        runId: null,
        runSeq: 1,
        parts: [],
      },
    );
  });

  it("drops content elements that carry no part type", () => {
    const result = classifyDelta(
      event({
        message_type: "assistant_message",
        id: "m",
        seq_id: 1,
        content: [{ text: "no type" }, { type: "text", text: "ok" }, "junk"],
      }),
    );

    expect(result).toEqual({
      kind: "assistant",
      messageId: "m",
      runId: null,
      runSeq: 1,
      parts: [{ type: "text", text: "ok" }],
    });
  });

  it("files an assistant delta without a usable id or sequence as other", () => {
    expect(classifyDelta(event({ message_type: "assistant_message", id: 7, seq_id: 1 }))).toEqual(
      expect.objectContaining({ kind: "other", messageId: null }),
    );

    expect(
      classifyDelta(event({ message_type: "assistant_message", id: "m", seq_id: "1" })),
    ).toEqual(expect.objectContaining({ kind: "other" }));

    expect(
      classifyDelta(event({ message_type: "assistant_message", id: "m", seq_id: 1.5 })),
    ).toEqual(expect.objectContaining({ kind: "other" }));
  });

  it("copies every usage count the payload reported", () => {
    const result = classifyDelta(
      event({
        id: "letta-msg-2",
        message_type: "usage_statistics",
        prompt_tokens: 706,
        completion_tokens: 63,
        total_tokens: 23169,
        cached_input_tokens: 22400,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
        context_tokens: 23169,
        context_system_tokens: 2074,
        context_messages_tokens: 464,
        context_tools_tokens: 21305,
        cost_usd: 0.0004218,
        cost_input_usd: 0.0002118,
        cost_output_usd: 0.0000756,
        cost_cache_read_usd: 0.0001344,
        cost_cache_write_usd: 0,
        run_id: "local-run-1",
        seq_id: 2,
        type: "message",
      }),
    );

    expect(result).toEqual({
      kind: "usage",
      runId: "local-run-1",
      usage: {
        promptTokens: 706,
        completionTokens: 63,
        totalTokens: 23169,
        cachedInputTokens: 22400,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        contextTokens: 23169,
        contextSystemTokens: 2074,
        contextMessagesTokens: 464,
        contextToolsTokens: 21305,
        costUsd: 0.0004218,
        costInputUsd: 0.0002118,
        costOutputUsd: 0.0000756,
        costCacheReadUsd: 0.0001344,
        costCacheWriteUsd: 0,
      },
    });
  });

  it("leaves a usage field the payload did not report absent rather than zero", () => {
    const usage = usageFromResult(
      classifyDelta(event({ message_type: "usage_statistics", prompt_tokens: 7, cost_usd: 0.5 })),
    );

    expect(Object.keys(usage).sort()).toEqual(["costUsd", "promptTokens"]);
    expect("completionTokens" in usage).toBe(false);
    expect("totalTokens" in usage).toBe(false);
    // No key may hold `undefined`: a consumer reading the object must be able to
    // tell "reported" from "not reported" by the key's presence alone.
    expect(Object.values(usage).every((value) => typeof value === "number")).toBe(true);
  });

  it("keeps a usage frame with no recognised number as an empty snapshot", () => {
    const usage = usageFromResult(
      classifyDelta(event({ message_type: "usage_statistics", run_id: "local-run-1", seq_id: 2 })),
    );

    expect(Object.keys(usage)).toEqual([]);
  });

  it("classifies a stop reason", () => {
    expect(
      classifyDelta(
        event({
          message_type: "stop_reason",
          stop_reason: "end_turn",
          run_id: "local-run-1",
          seq_id: 3,
          type: "message",
        }),
      ),
    ).toEqual({ kind: "stop", runId: "local-run-1", stopReason: "end_turn" });
  });

  it("files a stop delta without a reason as other", () => {
    expect(classifyDelta(event({ message_type: "stop_reason", run_id: "local-run-1" }))).toEqual(
      expect.objectContaining({ kind: "other", messageType: "stop_reason" }),
    );
  });

  it("keeps any other message type whole", () => {
    const delta = {
      id: "letta-msg-1",
      message_type: "approval_request_message",
      run_id: "local-run-1",
      tool_call: { tool_call_id: "call-1", name: "Bash" },
      seq_id: 1,
      type: "message",
    };

    expect(classifyDelta({ type: "stream_delta", delta })).toEqual({
      kind: "other",
      messageType: "approval_request_message",
      messageId: "letta-msg-1",
      runId: "local-run-1",
      body: delta,
    });
  });

  it("returns null for an event it does not own", () => {
    expect(
      classifyDelta({ type: "term.output", delta: { message_type: "assistant_message" } }),
    ).toBeNull();
    expect(classifyDelta({ type: "stream_delta" })).toBeNull();
    expect(classifyDelta({ type: "stream_delta", delta: null })).toBeNull();
    expect(classifyDelta({ type: "stream_delta", delta: "x" })).toBeNull();
    expect(classifyDelta(event({ id: "m", seq_id: 1 }))).toBeNull();
    expect(classifyDelta(null)).toBeNull();
    expect(classifyDelta(undefined)).toBeNull();
    expect(classifyDelta(42)).toBeNull();
    expect(classifyDelta("stream_delta")).toBeNull();
  });
});

describe("usageOf", () => {
  it("reads the usage numbers out of a payload", () => {
    expect(usageOf(event({ prompt_tokens: 3, total_tokens: 4 }))).toEqual({
      promptTokens: 3,
      totalTokens: 4,
    });
  });

  it("refuses values that are not counts", () => {
    expect(
      usageOf(
        event({
          prompt_tokens: "706",
          completion_tokens: Number.POSITIVE_INFINITY,
          total_tokens: Number.NaN,
          cost_usd: null,
          cost_input_usd: { amount: 1 },
        }),
      ),
    ).toBeNull();
  });

  it("returns null when there is nothing to read", () => {
    expect(usageOf({ type: "stream_delta" })).toBeNull();
    expect(usageOf(event({ id: "m" }))).toBeNull();
    expect(usageOf(null)).toBeNull();
    expect(usageOf(42)).toBeNull();
  });
});
