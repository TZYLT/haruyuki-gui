/**
 * The unread badge, pinned from the six sides that make it trustable.
 *
 * Every case below can fail on its own, and each one names the wrong rule it
 * catches:
 *
 * - a turn is one count, however many messages it holds;
 * - a turn that ends while the conversation is on screen is not news;
 * - a subagent's turn is a real turn but never the reader's;
 * - entering a conversation empties the badge;
 * - the badge is capped in display while the figure stays honest;
 * - the row's figure is unread turns plus pending approvals.
 *
 * Two of these were verified by breaking the module on purpose: counting every
 * message instead of every turn, and dropping the "not on screen" condition.
 * Both turn the corresponding test red and nothing else, which is what makes
 * these assertions evidence rather than decoration.
 */

import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import type { TurnRecord } from "./turns.js";
import { createTurnTable, type TurnTable } from "./turns.js";
import { createUnreadCounter, UNREAD_CAP } from "./unread.js";

/** The fields every change in this suite carries. */
type Base = {
  readonly conversationId: string;
  readonly at: number;
  readonly subagentId: string | null;
};

const base = (at: number, conversationId = "c-1", subagentId: string | null = null): Base => ({
  conversationId,
  at,
  subagentId,
});

/** One assistant message change; the first one opens the turn's record. */
function message(at: number, messageId: string, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "message.final",
    messageId,
    runId: "local-run-1",
    messageType: "assistant",
    body: null,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** A stop reason change, which is the only close signal the recording has. */
function stopped(at: number, stopReason: string, overrides: Partial<Base> = {}): MergerChange {
  return {
    ...base(at),
    ...overrides,
    kind: "turn.stopped",
    runId: "local-run-1",
    turnId: null,
    stopReason,
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
  };
}

/** The one record a single-turn table holds; throwing beats a silent empty test. */
function onlyTurn(table: TurnTable): TurnRecord {
  const first = table.turns()[0];

  if (first === undefined) {
    throw new Error("the turn table holds no record");
  }

  return first;
}

/** One finished turn, built directly so a hundred of them stay readable. */
function closedTurn(index: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    turnRef: `c-1#${index}`,
    turnId: `t-${index}`,
    runId: "local-run-1",
    conversationId: "c-1",
    stopReason: "end_turn",
    open: false,
    blocks: [],
    usage: null,
    incomplete: false,
    startedAt: index,
    finishedAt: index + 1,
    agentKind: "main",
    ...overrides,
  };
}

/** The same turn, still being written. */
function openTurn(index: number, agentKind: TurnRecord["agentKind"] = "main"): TurnRecord {
  return closedTurn(index, { open: true, finishedAt: null, agentKind });
}

describe("unread counts turns, not messages", () => {
  it("counts one turn that holds five messages as one", () => {
    const table = createTurnTable();
    const counter = createUnreadCounter();

    for (let index = 1; index <= 5; index += 1) {
      table.ingest(message(index, `m-${index}`));
      table.ingestContent("c-1", {
        messageId: `m-${index}`,
        upserts: [{ blockId: `b-${index}` }],
        removes: [],
      });

      // Every message delivery offers the in-flight record. None of them is a
      // finished turn, so none of them may raise the count.
      expect(counter.observe(onlyTurn(table))).toBe(false);
    }

    expect(counter.unreadOf("c-1")).toBe(0);
    expect(onlyTurn(table).blocks).toHaveLength(5);

    table.ingest(stopped(6, "end_turn"));

    const closed = onlyTurn(table);

    expect(closed.open).toBe(false);
    expect(counter.observe(closed)).toBe(true);
    // The whole point: one, not five, even though the turn holds five messages.
    expect(counter.unreadOf("c-1")).toBe(1);
    expect(counter.stats().premature).toBe(5);
  });

  it("does not count the same finished turn twice", () => {
    const counter = createUnreadCounter();

    expect(counter.observe(closedTurn(1))).toBe(true);
    // A redelivered close is the same turn. Counting it again would make the
    // badge grow on a reconnect that replays the tail of the stream.
    expect(counter.observe(closedTurn(1))).toBe(false);
    expect(counter.unreadOf("c-1")).toBe(1);
    expect(counter.stats().duplicated).toBe(1);
  });
});

describe("unread only grows while nobody is watching", () => {
  it("holds the badge still when the conversation is active", () => {
    const counter = createUnreadCounter();

    counter.setActive("c-1", true);

    expect(counter.observe(closedTurn(1))).toBe(false);
    expect(counter.unreadOf("c-1")).toBe(0);
    expect(counter.stats().suppressed).toBe(1);

    // Watched, so nothing counted; and the turn was seen, so leaving the
    // conversation and seeing the same close again cannot resurrect it.
    counter.setActive("c-1", false);

    expect(counter.observe(closedTurn(1))).toBe(false);
    expect(counter.unreadOf("c-1")).toBe(0);

    // A turn that ends after the reader left is news again.
    expect(counter.observe(closedTurn(2))).toBe(true);
    expect(counter.unreadOf("c-1")).toBe(1);
  });

  it("counts once the conversation is no longer active", () => {
    const counter = createUnreadCounter();

    counter.setActive("c-1", true);
    counter.observe(closedTurn(1));
    counter.setActive("c-1", false);

    expect(counter.observe(closedTurn(2))).toBe(true);
    expect(counter.unreadOf("c-1")).toBe(1);
  });
});

describe("a subagent's turn is not the reader's", () => {
  it("ignores a subagent turn that ends", () => {
    const table = createTurnTable();
    const counter = createUnreadCounter();

    table.ingest(message(1, "m-1", { subagentId: "s-1" }));
    table.ingest(stopped(2, "end_turn", { subagentId: "s-1" }));

    const record = onlyTurn(table);

    expect(record.agentKind).toBe("subagent");
    expect(counter.observe(record)).toBe(false);
    expect(counter.unreadOf("c-1")).toBe(0);
    expect(counter.stats().delegated).toBe(1);
  });

  it("counts the main agent's turn in the same conversation", () => {
    const counter = createUnreadCounter();

    expect(counter.observe(closedTurn(1, { agentKind: "subagent" }))).toBe(false);
    expect(counter.observe(closedTurn(1))).toBe(true);
    expect(counter.unreadOf("c-1")).toBe(1);
  });
});

describe("entering a conversation clears the badge", () => {
  it("goes back to zero on clear, and an unknown conversation is a no-op", () => {
    const counter = createUnreadCounter();

    counter.observe(closedTurn(1));
    counter.observe(closedTurn(2));
    counter.observe(closedTurn(3));
    expect(counter.unreadOf("c-1")).toBe(3);

    counter.clear("c-1");
    expect(counter.unreadOf("c-1")).toBe(0);
    expect(counter.badgeOf("c-1").badge).toBe(0);

    // Clearing twice is ordinary: two views may both report the entry.
    counter.clear("c-1");
    expect(counter.unreadOf("c-1")).toBe(0);

    counter.clear("never-seen");
    expect(counter.unreadOf("never-seen")).toBe(0);
  });

  it("cannot count a turn the reader already saw before dropping the badge", () => {
    const counter = createUnreadCounter();

    counter.observe(closedTurn(1));
    counter.clear("c-1");

    // The redelivered close of a turn that was read must not come back as new.
    expect(counter.observe(closedTurn(1))).toBe(false);
    expect(counter.unreadOf("c-1")).toBe(0);
  });
});

describe("the badge is capped in display, not in value", () => {
  it("stays honest at a hundred and flags the cap", () => {
    const counter = createUnreadCounter();

    for (let index = 1; index <= 100; index += 1) {
      counter.observe(closedTurn(index));
    }

    const badge = counter.badgeOf("c-1");

    expect(counter.unreadOf("c-1")).toBe(100);
    expect(badge.badge).toBe(100);
    expect(badge.badgeCapped).toBe(true);
  });

  it("does not flag the cap at ninety-nine", () => {
    const counter = createUnreadCounter();

    for (let index = 1; index <= UNREAD_CAP; index += 1) {
      counter.observe(closedTurn(index));
    }

    const badge = counter.badgeOf("c-1");

    expect(badge.badge).toBe(99);
    expect(badge.badgeCapped).toBe(false);
  });
});

describe("the row figure is unread turns plus pending approvals", () => {
  it("adds the two, and the page only displays it", () => {
    const counter = createUnreadCounter({
      countApprovals: (conversationId) => (conversationId === "c-1" ? 2 : 0),
    });

    counter.observe(closedTurn(1));
    counter.observe(closedTurn(2));
    counter.observe(closedTurn(3));

    const badge = counter.badgeOf("c-1");

    expect(badge.unread).toBe(3);
    expect(badge.approvals).toBe(2);
    expect(badge.badge).toBe(5);
    // The cap follows the merged figure, not the unread part alone.
    expect(badge.badgeCapped).toBe(false);
  });

  it("reads zero approvals when no approval table is wired in", () => {
    const counter = createUnreadCounter();

    counter.observe(closedTurn(1));

    expect(counter.badgeOf("c-1")).toEqual({
      conversationId: "c-1",
      unread: 1,
      approvals: 0,
      badge: 1,
      badgeCapped: false,
    });
  });

  it("survives an approval count that throws or answers nonsense", () => {
    const throwing = createUnreadCounter({
      countApprovals: () => {
        throw new Error("the approval table is not ready");
      },
    });
    const nonsense = createUnreadCounter({
      countApprovals: () => Number.NaN,
    });

    throwing.observe(closedTurn(1));
    nonsense.observe(closedTurn(1));

    // A neighbour being written must not cost the badge: unread still counts.
    expect(throwing.badgeOf("c-1").badge).toBe(1);
    expect(throwing.badgeOf("c-1").approvals).toBe(0);
    expect(nonsense.badgeOf("c-1").badge).toBe(1);
  });

  it("flags the cap on the merged figure", () => {
    const counter = createUnreadCounter({ countApprovals: () => 1 });

    for (let index = 1; index <= UNREAD_CAP; index += 1) {
      counter.observe(closedTurn(index));
    }

    const badge = counter.badgeOf("c-1");

    expect(badge.badge).toBe(100);
    expect(badge.badgeCapped).toBe(true);
  });
});

describe("bad input is a skipped observation, never an exception", () => {
  it("ignores a record it cannot read and keeps counting the next one", () => {
    const counter = createUnreadCounter();

    expect(counter.observe(null as unknown as TurnRecord)).toBe(false);
    expect(counter.observe({} as unknown as TurnRecord)).toBe(false);
    expect(counter.observe(closedTurn(1, { conversationId: "" }))).toBe(false);
    expect(counter.stats().dropped).toBe(3);

    expect(counter.observe(closedTurn(2))).toBe(true);
    expect(counter.unreadOf("c-1")).toBe(1);

    counter.setActive("", true);
    counter.clear("");
    expect(counter.isActive("")).toBe(false);
  });
});

describe("the table stays bounded", () => {
  it("evicts a conversation with nothing to show before one carrying a badge", () => {
    const counter = createUnreadCounter({ conversations: 2 });

    // A conversation that is watched but never counted: it has nothing to lose.
    counter.setActive("quiet", true);
    counter.observe(closedTurn(1, { conversationId: "a" }));

    // A third conversation arrives and the table is already full. Evicting the
    // one with a badge would silently drop news the reader has not seen.
    counter.observe(closedTurn(1, { conversationId: "c" }));

    expect(counter.badgeOf("a").badge).toBe(1);
    expect(counter.badgeOf("c").badge).toBe(1);
    expect(counter.isActive("quiet")).toBe(false);
    expect(counter.stats().evicted).toBe(1);
    expect(counter.stats().conversations).toBe(2);
  });

  it("keeps one badge per conversation, even when two report the same turn id", () => {
    const counter = createUnreadCounter();

    expect(counter.observe(closedTurn(1, { conversationId: "a" }))).toBe(true);
    // The same id in a second conversation is a different turn, not a replay.
    expect(counter.observe(closedTurn(1, { conversationId: "b" }))).toBe(true);

    expect(counter.unreadOf("a")).toBe(1);
    expect(counter.unreadOf("b")).toBe(1);
    expect(counter.stats().duplicated).toBe(0);
  });

  it("corrects a bound that is not a positive integer instead of evicting each write", () => {
    const counter = createUnreadCounter({ conversations: 0 });

    counter.observe(closedTurn(1, { conversationId: "a" }));
    counter.observe(closedTurn(2, { conversationId: "b" }));

    expect(counter.badgeOf("a").badge).toBe(1);
    expect(counter.badgeOf("b").badge).toBe(1);
    expect(counter.stats().evicted).toBe(0);
  });
});
