/**
 * The publication half: what one change wakes.
 *
 * These cases are about the cost of a change reaching the wrong subscriber. The
 * interesting failure is not a wrong value - the snapshot is shared, so a reader
 * that is re-run reads the same object every other reader does - but a page being
 * re-run for a conversation it is not looking at. A hundred sessions open and one
 * busy turn should cost one frame, and that is what these pin.
 */

import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { createSessionStore } from "./store.js";

/** One change, in the shape the event merger hands the store. */
function change(overrides: Record<string, unknown>): MergerChange {
  return {
    type: "test",
    raw: {},
    at: 1,
    authorAgentId: "a1",
    runtimeAgentId: "a1",
    subagentId: null,
    conversationId: "c1",
    ...overrides,
  } as unknown as MergerChange;
}

/** A store with `count` conversations on one agent, and one subscriber each. */
function withOneSubscriberPerConversation(count: number): {
  store: ReturnType<typeof createSessionStore>;
  frames: Map<string, number>;
  reset: () => void;
} {
  const store = createSessionStore();
  const ids = Array.from({ length: count }, (_, index) => `c${index}`);

  store.ingestConversations(
    ids.map((id) => ({ id, agent_id: "a1" })),
    { hasMore: false },
  );

  const frames = new Map<string, number>();

  for (const id of ids) {
    frames.set(id, 0);
    store.subscribe(
      { instanceId: `tab-${id}`, selector: "entity.turns", params: { conversationId: id } },
      () => {
        frames.set(id, (frames.get(id) ?? 0) + 1);
      },
    );
  }

  return {
    store,
    frames,
    reset: () => {
      for (const id of ids) {
        frames.set(id, 0);
      }
    },
  };
}

describe("publishing a change only wakes the subscriptions that read it", () => {
  it("answers one conversation's change and leaves the others alone", () => {
    const { store, frames, reset } = withOneSubscriberPerConversation(10);

    reset();
    store.ingest(
      change({
        kind: "message.delta",
        conversationId: "c0",
        messageId: "m1",
        runId: "r1",
      }),
    );

    // The bug this pins: naming the kind without its ids makes every subscriber
    // of that kind eligible, so one turn would cost ten frames.
    expect(frames.get("c0")).toBe(1);
    expect([...frames.entries()].filter(([id]) => id !== "c0").every(([, n]) => n === 0)).toBe(
      true,
    );
  });

  it("does not wake a conversation-scoped reader for another conversation", () => {
    const store = createSessionStore();

    store.ingestConversations(
      [
        { id: "c1", agent_id: "a1" },
        { id: "c2", agent_id: "a1" },
      ],
      { hasMore: false },
    );

    let first = 0;
    let second = 0;

    store.subscribe(
      { instanceId: "tab-1", selector: "entity.conversation", params: { conversationId: "c1" } },
      () => {
        first += 1;
      },
    );
    store.subscribe(
      { instanceId: "tab-2", selector: "entity.conversation", params: { conversationId: "c2" } },
      () => {
        second += 1;
      },
    );

    first = 0;
    second = 0;

    store.ingest(
      change({ kind: "message.delta", conversationId: "c1", messageId: "m1", runId: "r1" }),
    );

    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("still wakes a subscription that reads several kinds", () => {
    const store = createSessionStore();

    store.ingestConversations([{ id: "c1", agent_id: "a1" }], { hasMore: false });

    let rows = 0;

    store.subscribe(
      {
        instanceId: "nav",
        selector: "view.nav",
        params: { agentId: "a1", pinned: [], hasMore: false },
      },
      () => {
        rows += 1;
      },
    );

    rows = 0;

    // A navigation row carries its agent's badge as well as the conversation's
    // own facts, so narrowing must not silence it for the kind it does not name.
    store.ingestAgents([{ id: "a1", name: "Agent one" }]);

    expect(rows).toBe(1);
  });

  it("wakes a reader whose row was removed, not only one whose row was rewritten", () => {
    const store = createSessionStore();

    store.ingestConversations(
      [
        { id: "c1", agent_id: "a1" },
        { id: "c2", agent_id: "a1" },
      ],
      { hasMore: false },
    );

    let answered = 0;

    store.subscribe(
      { instanceId: "tab-1", selector: "entity.conversation", params: { conversationId: "c1" } },
      () => {
        answered += 1;
      },
    );

    answered = 0;

    // A page whose conversation vanished has to hear it: staying silent would
    // leave it drawing the last row it was sent.
    store.ingestConversations([{ id: "c2", agent_id: "a1" }], { hasMore: false });

    expect(answered).toBeGreaterThan(0);

    // The entity is still there - a gone conversation keeps its row so the page
    // can say why it looks empty - and the view is where the state is read.
    expect(
      store.select({
        instanceId: "",
        selector: "view.conversationRow",
        params: { conversationId: "c1" },
      }).value,
    ).toMatchObject({ state: "gone" });
  });
});
