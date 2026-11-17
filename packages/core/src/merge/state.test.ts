/**
 * Tests for the state mapper.
 *
 * Two properties carry the weight, and both are about not "helpfully" reshaping
 * the payload:
 *
 * - the four state types keep the engine's object as it arrived, including the
 *   `removed` delta inside a queue update; a mapper that kept only the newest
 *   `queue` array would look green on every other assertion and still lose the
 *   one piece consumers need to clear a queued mark;
 * - the change base is copied from the envelope facts, and a missing author or
 *   runtime stays visibly missing (`null` / `""`) instead of being filled in.
 */

import { describe, expect, it } from "vitest";

import type { EnvelopeFacts } from "./envelope.js";
import { stateChangeOf } from "./state.js";

/** Complete envelope facts, overridable per case. */
function facts(overrides: Partial<EnvelopeFacts> = {}): EnvelopeFacts {
  return {
    seq: 12,
    idempotencyKey: "key-1",
    runtimeAgentId: "runtime-main",
    conversationId: "conversation-1",
    authorAgentId: "author-1",
    subagentId: null,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

/** The four state types and the kind each must produce. */
const STATE_TYPES: readonly (readonly [type: string, kind: string])[] = [
  ["update_loop_status", "state.loop"],
  ["update_device_status", "state.device"],
  ["update_queue", "state.queue"],
  ["update_subagent_state", "state.subagents"],
];

describe("stateChangeOf kinds", () => {
  it.each(STATE_TYPES)("maps %s to %s", (type, kind) => {
    const change = stateChangeOf(type, { type, marker: type }, facts());

    expect(change?.kind).toBe(kind);
  });

  it.each(STATE_TYPES)("keeps the %s payload deep-equal to the input", (type) => {
    const payload = {
      type,
      model: "gpt-5",
      nested: { list: [1, 2, { deep: true }], label: `${type}-label` },
    };

    // `objectContaining` compares the `value` field with deep equality while
    // keeping the assertion type-safe: `MergerChange` is a union, so reading
    // `change.value` directly would need a narrowing cast.
    expect(stateChangeOf(type, payload, facts())).toEqual(
      expect.objectContaining({ value: payload }),
    );
  });

  it("keeps the removed entries of a queue update, not just the newest queue", () => {
    const payload = {
      queue: [{ id: "task-2" }],
      removed: [{ id: "task-1", reason: "cancelled" }, { id: "task-0" }],
    };

    const change = stateChangeOf("update_queue", payload, facts());

    expect(change?.kind).toBe("state.queue");
    expect(change).toEqual(expect.objectContaining({ value: payload }));
    expect(change).toEqual(
      expect.objectContaining({
        value: expect.objectContaining({
          removed: [{ id: "task-1", reason: "cancelled" }, { id: "task-0" }],
        }),
      }),
    );
  });

  it.each([
    "message_delta",
    "stream_delta",
    "terminal_output",
    "usage_statistics",
    "UPDATE_QUEUE",
    "updateQueue",
    "",
  ])("returns null for the non-state type %j", (type) => {
    expect(stateChangeOf(type, {}, facts())).toBeNull();
  });
});

describe("stateChangeOf change base", () => {
  it("takes who, where and when from the facts", () => {
    const change = stateChangeOf("update_device_status", {}, facts());

    expect(change).toMatchObject({
      authorAgentId: "author-1",
      runtimeAgentId: "runtime-main",
      subagentId: null,
      conversationId: "conversation-1",
      at: 1_700_000_000_000,
    });
  });

  it("keeps a null author and an absent runtime instead of inventing them", () => {
    const change = stateChangeOf(
      "update_loop_status",
      {},
      facts({ authorAgentId: null, runtimeAgentId: null }),
    );

    expect(change?.authorAgentId).toBeNull();
    expect(change?.runtimeAgentId).toBe("");
  });

  it("keeps the subagent context when the frame carries one", () => {
    const change = stateChangeOf(
      "update_subagent_state",
      {},
      facts({ subagentId: "subagent-1794661146742-1", conversationId: "conversation-2" }),
    );

    expect(change?.subagentId).toBe("subagent-1794661146742-1");
    expect(change?.conversationId).toBe("conversation-2");
  });

  it("copies the conversation id verbatim", () => {
    const change = stateChangeOf("update_queue", {}, facts({ conversationId: "conversation-3" }));

    expect(change?.conversationId).toBe("conversation-3");
  });

  it("does not leak sequencing or idempotency fields into the change", () => {
    const change = stateChangeOf("update_queue", {}, facts());

    expect(change).not.toHaveProperty("seq");
    expect(change).not.toHaveProperty("idempotencyKey");
  });
});
