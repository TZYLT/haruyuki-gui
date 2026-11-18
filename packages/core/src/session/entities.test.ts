/**
 * The two list entities, pinned from the directions they can fail quietly.
 *
 * The failures this suite is written against, in the order they would hurt:
 *
 * - **A re-sent page appends instead of replacing.** It type-checks, every
 *   single-page test still passes, and the only symptom is the reader seeing one
 *   conversation twice with one of the two copies stale. The first test below
 *   therefore feeds the same id twice with different content and asserts both the
 *   table length *and* the field value; the mutation written up in the report is
 *   exactly that one line.
 * - **A missing field is filled in.** "The engine did not say" and "the engine
 *   said zero" draw differently, and only one of them is a reason to show a blank
 *   name, so an absent field must stay `null` - and the counter must move, or the
 *   fill-in becomes invisible in diagnostics.
 * - **A conversation that leaves the list disappears.** The list is a list, not a
 *   world: the reader may be looking at that conversation, and the tag must stay
 *   open with a readable reason. The entity is therefore kept and its state moves
 *   to `gone`, which is the third of the three states the row view already has.
 * - **A page that is not the whole list is read as one.** Its absences would then
 *   delete every conversation that merely lives on the next page, once per scroll.
 *
 * The malformed rows are here for the other half of the contract: a row this
 * module cannot file costs a counter and a skipped row, never a thrown error, and
 * never the rows around it.
 */

import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import { ENTITY_ID_CHAR_LIMIT, createAgentTable, createConversationTable } from "./entities.js";

/** One conversation row as the engine's list sends it. */
function conversationRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "conv-1",
    agent_id: "agent-1",
    last_message_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T09:00:00Z",
    created_at: "2026-11-17T08:00:00Z",
    hidden: false,
    context_message_count: 12,
    ...overrides,
  };
}

/** One agent row as the engine's list sends it. */
function agentRow(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return { id: "agent-1", name: "First", description: "the first agent", ...overrides };
}

/** One change the merger would have produced for a conversation. */
function change(kind: string, conversationId: string): MergerChange {
  return {
    kind,
    authorAgentId: "agent-1",
    runtimeAgentId: "agent-1",
    subagentId: null,
    conversationId,
    at: 1,
  } as MergerChange;
}

describe("agents: a page replaces, it does not append", () => {
  it("keeps one record per id and takes the newer fields", () => {
    const table = createAgentTable();

    table.ingest([agentRow()]);
    table.ingest([agentRow({ name: "Renamed", description: "renamed too" })]);

    expect(table.agents()).toHaveLength(1);
    expect(table.get("agent-1")).toEqual({
      agentId: "agent-1",
      name: "Renamed",
      description: "renamed too",
      capabilities: {},
      conversations: [],
    });
    expect(table.stats()).toMatchObject({ rows: 2, held: 1, added: 1, replaced: 1 });
  });

  it("keeps the capability table and conversation ids another layer attached", () => {
    const table = createAgentTable();

    table.ingest([agentRow()]);
    table.join("agent-1", "conv-1");
    table.join("agent-1", "conv-2");

    // A list row declares neither capability availability nor a conversation
    // list, so a re-sent page must not blank what the other layers composed.
    table.ingest([agentRow({ name: "Second" })]);

    expect(table.get("agent-1")?.conversations).toEqual(["conv-1", "conv-2"]);
    expect(table.get("agent-1")?.name).toBe("Second");
  });

  it("drops a conversation from membership without touching its position elsewhere", () => {
    const table = createAgentTable();

    table.join("agent-1", "conv-1");
    table.join("agent-1", "conv-2");
    table.leave("agent-1", "conv-1");

    expect(table.get("agent-1")?.conversations).toEqual(["conv-2"]);
    expect(table.stats().held).toBe(1);
  });
});

describe("agents: an absent field is null, and counted", () => {
  it("stores null for what the row does not name", () => {
    const table = createAgentTable();

    // No `name`, no `description`, and `name` is the wrong type besides.
    table.ingest([{ id: "agent-2" }, { id: "agent-3", name: 42, description: null }]);

    expect(table.get("agent-2")).toEqual({
      agentId: "agent-2",
      name: null,
      description: null,
      capabilities: {},
      conversations: [],
    });
    expect(table.get("agent-3")?.name).toBeNull();
    expect(table.get("agent-3")?.description).toBeNull();
    // `agent-2` names neither field, `agent-3` names both with no usable value.
    expect(table.stats().absentFields).toBe(4);
    expect(table.stats().refused).toBe(0);
  });

  it("drops an over-long text field instead of truncating it", () => {
    const table = createAgentTable();
    const long = "n".repeat(ENTITY_ID_CHAR_LIMIT + 1);

    table.ingest([{ id: "agent-4", name: long }]);

    expect(table.get("agent-4")?.name).toBeNull();
    expect(table.stats().overlongFields).toBe(1);
  });
});

describe("conversations: a page replaces, it does not append", () => {
  it("keeps one record per id and takes the newer row", () => {
    const table = createConversationTable();

    table.ingest([conversationRow()], { hasMore: false });
    table.ingest([conversationRow({ last_message_at: "2026-11-19T12:00:00Z", hidden: true })], {
      hasMore: false,
    });

    expect(table.conversations()).toHaveLength(1);
    expect(table.stats()).toMatchObject({ added: 1, replaced: 1, duplicates: 0 });
    expect(table.get("conv-1")?.lastActivityAt).toBe("2026-11-19T12:00:00Z");
    // The row is stored as sent, including the fields this layer does not read.
    expect(table.get("conv-1")?.row).toEqual(
      conversationRow({ last_message_at: "2026-11-19T12:00:00Z", hidden: true }),
    );
  });

  it("takes the last activity from the engine's own order of the three stamps", () => {
    const table = createConversationTable();

    table.ingest(
      [
        conversationRow({ id: "conv-both", last_message_at: "B", updated_at: "A" }),
        conversationRow({
          id: "conv-updated",
          last_message_at: null,
          updated_at: "U",
          created_at: "C",
        }),
        conversationRow({
          id: "conv-created",
          last_message_at: null,
          updated_at: null,
          created_at: "C",
        }),
        conversationRow({
          id: "conv-none",
          last_message_at: null,
          updated_at: null,
          created_at: null,
        }),
      ],
      { hasMore: false },
    );

    expect(table.get("conv-both")?.lastActivityAt).toBe("B");
    expect(table.get("conv-updated")?.lastActivityAt).toBe("U");
    expect(table.get("conv-created")?.lastActivityAt).toBe("C");
    expect(table.get("conv-none")?.lastActivityAt).toBeNull();
  });

  it("keeps the turn list another layer stored", () => {
    const table = createConversationTable();

    table.ingest([conversationRow()], { hasMore: false });
    expect(table.setTurns("conv-1", ["conv-1#0", "conv-1#1"])).toBe(true);

    table.ingest([conversationRow()], { hasMore: false });

    expect(table.get("conv-1")?.turns).toEqual(["conv-1#0", "conv-1#1"]);
    expect(table.setTurns("conv-missing", ["x#0"])).toBe(false);
  });

  it("joins the agent's conversation list, in the order the rows arrived", () => {
    const agents = createAgentTable();
    const table = createConversationTable({ agents });

    agents.ingest([agentRow()]);
    table.ingest([conversationRow({ id: "conv-1" }), conversationRow({ id: "conv-2" })], {
      hasMore: false,
    });

    expect(agents.get("agent-1")?.conversations).toEqual(["conv-1", "conv-2"]);
  });
});

describe("conversations: leaving the list is not a deletion", () => {
  it("keeps the entity and marks it gone when a complete page omits it", () => {
    const agents = createAgentTable();
    const table = createConversationTable({ agents });

    agents.ingest([agentRow()]);
    table.ingest([conversationRow({ id: "conv-1" }), conversationRow({ id: "conv-2" })], {
      hasMore: false,
    });

    // The reader still has conv-1 open; only the list stopped naming it.
    table.ingest([conversationRow({ id: "conv-2" })], { hasMore: false });

    expect(table.stateOf("conv-1")).toBe("gone");
    expect(table.stateOf("conv-2")).toBe("ok");
    expect(table.gone()).toEqual(["conv-1"]);
    // Not silently gone: the entity, its last row and its stamp are still here.
    expect(table.get("conv-1")?.row).toEqual(conversationRow());
    expect(table.get("conv-1")?.lastActivityAt).toBe("2026-11-18T10:00:00Z");
    expect(table.stats().gone).toBe(1);
  });

  it("never marks anything gone from a page that says more is behind it", () => {
    const table = createConversationTable();

    table.ingest([conversationRow({ id: "conv-1" })], { hasMore: true });

    // conv-1 lives on this page; conv-2 would be on the next one. A partial page
    // must not turn either into a gone row.
    expect(table.stateOf("conv-1")).toBe("ok");
    expect(table.stats().gone).toBe(0);
  });

  it("brings a gone conversation back when a list or a change names it again", () => {
    const table = createConversationTable();

    table.ingest([conversationRow({ id: "conv-1" })], { hasMore: false });
    table.ingest([], { hasMore: false });
    expect(table.stateOf("conv-1")).toBe("gone");

    table.ingest([conversationRow({ id: "conv-1" })], { hasMore: false });

    expect(table.stateOf("conv-1")).toBe("ok");
    expect(table.stats().revived).toBeGreaterThanOrEqual(1);
    expect(table.gone()).toEqual([]);
  });

  it("revives a gone conversation on a conversation-scoped change", () => {
    const table = createConversationTable();

    table.ingest([conversationRow({ id: "conv-1" })], { hasMore: false });
    table.ingest([], { hasMore: false });
    expect(table.stateOf("conv-1")).toBe("gone");

    expect(table.apply(change("turn.finished", "conv-1"))).toEqual({
      kind: "turn.finished",
      effect: "revived",
      conversationId: "conv-1",
    });
    expect(table.stateOf("conv-1")).toBe("ok");
  });

  it("ignores a change that is not scoped to a conversation it holds", () => {
    const table = createConversationTable();

    table.ingest([conversationRow()], { hasMore: false });

    expect(table.apply(change("state.device", "conv-1")).effect).toBe("ignored");
    expect(table.apply(change("passthrough", "conv-1")).effect).toBe("ignored");
    expect(table.apply(change("turn.finished", "conv-unknown")).effect).toBe("ignored");
    expect(table.apply(change("turn.finished", "conv-1")).effect).toBe("seen");
    expect(table.stats().unmatched).toBe(1);
    // Nothing was created for a conversation no page ever sent.
    expect(table.conversations()).toHaveLength(1);
  });
});

describe("conversations: hasMore is carried, not guessed", () => {
  it("hands back exactly what the caller reported", () => {
    const table = createConversationTable();

    expect(table.hasMore()).toBe(false);

    table.ingest([conversationRow()], { hasMore: true });
    expect(table.hasMore()).toBe(true);

    table.ingest([conversationRow()], { hasMore: false });
    expect(table.hasMore()).toBe(false);
  });
});

describe("malformed rows cost a row, never the session", () => {
  it("skips a row with no id", () => {
    const agents = createAgentTable();
    const conversations = createConversationTable();

    agents.ingest([{ name: "anonymous" }, agentRow()]);
    conversations.ingest([{ agent_id: "agent-1" }, conversationRow()], { hasMore: false });

    expect(agents.stats().refused).toBe(1);
    expect(agents.agents()).toHaveLength(1);
    expect(conversations.stats().refused).toBe(1);
    expect(conversations.conversations()).toHaveLength(1);
  });

  it("skips a row that is not an object at all", () => {
    const agents = createAgentTable();
    const conversations = createConversationTable();

    // `null`, a string and an array are the three shapes a list row can take by
    // accident; none of them is a record.
    agents.ingest([null, "agent-1", ["agent-1"]] as never);
    conversations.ingest([null, "conv-1", ["conv-1"]] as never, { hasMore: false });

    expect(agents.stats()).toMatchObject({ refused: 3, rows: 3, held: 0 });
    expect(conversations.stats()).toMatchObject({ refused: 3, rows: 3, held: 0 });
    expect(agents.agents()).toEqual([]);
    expect(conversations.conversations()).toEqual([]);
  });

  it("refuses an over-long id rather than storing a shortened one", () => {
    const table = createConversationTable();
    const long = "c".repeat(ENTITY_ID_CHAR_LIMIT + 1);

    table.ingest([conversationRow({ id: long }), conversationRow()], { hasMore: false });

    expect(table.stats()).toMatchObject({ refused: 1, added: 1 });
    expect(table.get(long)).toBeNull();
    expect(table.get("conv-1")).not.toBeNull();
  });

  it("marks a row unreadable, counts its cause, and keeps the row already held", () => {
    const table = createConversationTable();

    table.ingest([conversationRow()], { hasMore: false });

    // The row is in the list but does not name an agent, so no entity can be
    // composed for it; the conversation is still there, with the row it had.
    table.ingest([conversationRow({ agent_id: undefined })], { hasMore: false });

    expect(table.stateOf("conv-1")).toBe("unreadable");
    expect(table.get("conv-1")?.agentId).toBe("agent-1");
    expect(table.stats()).toMatchObject({
      unreadable: 1,
      // The cause, counted on its own: a row with no agent is a missing field,
      // not an unreadable value, and a diagnostic reading has to tell them apart.
      missingAgentId: 1,
      refused: 0,
      gone: 0,
    });
  });
});

describe("the tables publish immutable values", () => {
  it("freezes the entities and the maps it hands out", () => {
    const agents = createAgentTable();
    const conversations = createConversationTable({ agents });

    agents.ingest([agentRow()]);
    conversations.ingest([conversationRow()], { hasMore: false });

    const agent = agents.get("agent-1");
    const conversation = conversations.get("conv-1");

    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(conversation)).toBe(true);
    expect(Object.isFrozen(conversation?.row)).toBe(true);
    expect(() => (conversations.map() as Map<string, unknown>).set("x", null)).toThrow();
    expect(Object.isFrozen(conversations.stats())).toBe(true);
  });
});
