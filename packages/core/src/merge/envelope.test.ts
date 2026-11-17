/**
 * Tests for the envelope reader.
 *
 * The point is not "the fields are copied"; it is that the reader never invents
 * a value and that the author fallback chain has `session_id` ahead of
 * `runtime.agent_id`. The measured frame that makes the order load-bearing is
 * reproduced verbatim in the third case: a subagent `stop_reason` with
 * `agent_id = null`, `session_id = <subagent>`, `runtime.agent_id = <main>`.
 */

import { describe, expect, it } from "vitest";

import type { EngineEventFrame } from "../engine/client/index.js";

import { readEnvelope, readSeq } from "./envelope.js";

function frame(raw: unknown, envelope?: EngineEventFrame["envelope"], at = 1234): EngineEventFrame {
  return {
    type: "stream_delta",
    raw,
    at,
    ...(envelope === undefined ? {} : { envelope }),
  };
}

describe("readSeq", () => {
  it("accepts a finite integer", () => {
    expect(readSeq(7)).toBe(7);
    expect(readSeq(0)).toBe(0);
  });

  it("refuses strings, floats, negatives and null", () => {
    expect(readSeq("7")).toBeNull();
    expect(readSeq(7.5)).toBeNull();
    expect(readSeq(-1)).toBeNull();
    expect(readSeq(null)).toBeNull();
    expect(readSeq(undefined)).toBeNull();
  });
});

describe("readEnvelope author attribution", () => {
  it("prefers delta.agent_id", () => {
    const facts = readEnvelope(
      frame(
        {
          type: "stream_delta",
          delta: { agent_id: "agent-a", session_id: "agent-b" },
          runtime: { agent_id: "agent-main" },
        },
        { runtime: { agent_id: "agent-main", conversation_id: "c-1" } },
      ),
      "default",
    );

    expect(facts.authorAgentId).toBe("agent-a");
    expect(facts.runtimeAgentId).toBe("agent-main");
    expect(facts.conversationId).toBe("c-1");
  });

  it("falls back to delta.session_id before runtime.agent_id", () => {
    const facts = readEnvelope(
      frame(
        {
          type: "stream_delta",
          delta: {
            message_type: "stop_reason",
            agent_id: null,
            session_id: "agent-local-ae45e895",
            stop_reason: "end_turn",
          },
          subagent_id: "subagent-1794661146742-1",
          runtime: { agent_id: "agent-local-6fdb12c0", conversation_id: "default" },
        },
        {
          event_seq: 13,
          runtime: { agent_id: "agent-local-6fdb12c0", conversation_id: "default" },
        },
      ),
      "default",
    );

    expect(facts.authorAgentId).toBe("agent-local-ae45e895");
    expect(facts.runtimeAgentId).toBe("agent-local-6fdb12c0");
    expect(facts.subagentId).toBe("subagent-1794661146742-1");
    expect(facts.seq).toBe(13);
  });

  it("falls back to runtime.agent_id when the delta has no identity", () => {
    const facts = readEnvelope(
      frame(
        { type: "turn_finished", run_id: "local-run-1" },
        { runtime: { agent_id: "agent-main", conversation_id: "default" } },
      ),
      "default",
    );

    expect(facts.authorAgentId).toBe("agent-main");
    expect(facts.subagentId).toBeNull();
  });

  it("keeps null when nothing identifies the author", () => {
    const facts = readEnvelope(frame({ type: "memory_updated" }), "default");

    expect(facts.authorAgentId).toBeNull();
    expect(facts.runtimeAgentId).toBeNull();
    expect(facts.seq).toBeNull();
    expect(facts.idempotencyKey).toBeNull();
    expect(facts.conversationId).toBe("default");
  });
});

describe("readEnvelope envelope facts", () => {
  it("keeps the idempotency key and the arrival time", () => {
    const facts = readEnvelope(
      frame({ type: "stream_delta", delta: {} }, { idempotency_key: "k-1" }, 4567),
      "default",
    );

    expect(facts.idempotencyKey).toBe("k-1");
    expect(facts.at).toBe(4567);
  });

  it("treats a NaN arrival time as 0 rather than passing it on", () => {
    expect(readEnvelope(frame({ type: "x" }, undefined, Number.NaN), "default").at).toBe(0);
  });

  it("falls back to the merger's conversation when the frame has none", () => {
    const facts = readEnvelope(frame({ type: "x" }), "fallback");

    expect(facts.conversationId).toBe("fallback");
  });
});
