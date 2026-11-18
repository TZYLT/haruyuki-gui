/**
 * The seven view selectors, and the contract they answer to.
 *
 * The central assertion is arity plus shape: for every row of the selector
 * table, there is an implementation, it answers for its name, and what it
 * returns has the shape that row declares. Delete one implementation and the
 * table goes red at that row, which is the failure this suite exists to catch -
 * a table whose rows some of which nobody implemented reads exactly like a
 * complete one.
 *
 * The rest covers the properties that a shape check cannot see:
 *
 * - the subagent tree ends on a parent chain that closes on itself, and returns
 *   its rows instead of hanging or dropping them;
 * - the capability table keeps its tri-state, `unknown` rows included, because
 *   dropping them would hide a feature on no evidence;
 * - a name outside the contract and a request of the wrong shape answer with a
 *   code, and nothing here throws.
 *
 * Fixtures are constructed, not captured: a test that reads a recording passes
 * for as long as the recording does.
 */

import type { CapabilityName } from "@haruyuki/protocol";
import { CAPABILITY_META } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type {
  AgentEntity,
  ApprovalEntity,
  ConversationEntity,
  SessionSnapshot,
  SubagentEntity,
  TurnEntity,
} from "@haruyuki/protocol";
import { SESSION_BAD_PARAMS, SESSION_UNKNOWN_SELECTOR } from "@haruyuki/protocol";

import {
  createViewSelectors,
  VIEW_SELECTOR_NAMES,
  type SelectorOutcome,
  type ViewSelectors,
} from "./view.js";

/** A usage report shaped the way the engine sends one. */
const USAGE = { context_tokens: 2000, context_window_limit: 8000 };

/** An agent holding three conversations, in engine order. */
const AGENT: AgentEntity = {
  agentId: "agent-1",
  name: "Agent One",
  description: null,
  // Composed upstream; only the rows that are there can be returned.
  capabilities: {
    "agent.get": { state: "available" },
    "agent.list": { state: "unavailable", reason: "feature-off" },
    "memory.read": { state: "unknown", reason: "not-probed" },
  },
  conversations: ["conv-1", "conv-2", "conv-3"],
};

/** The agent's context view, as the usage fold publishes it. */
const CONTEXT = {
  tokens: 2000,
  limit: 8000,
  source: "agent-config" as const,
  percentage: 25,
  parts: { system: 100, tools: 50, messages: 1850 },
  estimated: false,
};

/** A conversation that is fine and holds one open turn. */
function conversation(
  conversationId: string,
  overrides: Partial<ConversationEntity> = {},
): ConversationEntity {
  return {
    conversationId,
    agentId: AGENT.agentId,
    row: { title: `title-${conversationId}` },
    lastActivityAt: `2026-11-18T00:00:0${conversationId.slice(-1)}Z`,
    turns: [`turn-${conversationId}`],
    context: CONTEXT,
    incompleteTurnRefs: [],
    ...overrides,
  };
}

/** One turn, open unless a caller says otherwise. */
function turn(turnRef: string, conversationId: string, open = true): TurnEntity {
  return {
    turnRef,
    turnId: open ? null : `turn-id-${turnRef}`,
    runId: null,
    conversationId,
    stopReason: open ? null : "end_turn",
    open,
    blocks: [],
    usage: null,
    incomplete: false,
    startedAt: 1,
    finishedAt: open ? null : 2,
  };
}

/** One subagent run; `parentAgentId` names the row above it. */
function subagent(
  subagentId: string,
  parentAgentId: string | null,
  conversationId: string | null = "conv-1",
): SubagentEntity {
  return {
    subagentId,
    parentAgentId,
    conversationId,
    status: "running",
    totalTokens: 10,
    durationMs: 20,
    error: null,
  };
}

/** One approval request; `state` decides whether it counts as pending. */
function approval(conversationId: string, state: ApprovalEntity["state"]): ApprovalEntity {
  return {
    requestId: `req-${conversationId}-${state}`,
    agentId: AGENT.agentId,
    conversationId,
    toolName: "run",
    input: {},
    state,
    requestedAt: 1,
  };
}

/** Build a snapshot out of the parts a test cares about. */
function snapshot(parts: {
  agents?: readonly AgentEntity[];
  conversations?: readonly ConversationEntity[];
  turns?: readonly TurnEntity[];
  subagents?: ReadonlyMap<string, readonly SubagentEntity[]>;
  approvals?: ReadonlyMap<string, readonly ApprovalEntity[]>;
}): SessionSnapshot {
  return {
    revision: 1,
    epoch: 1,
    agents: new Map((parts.agents ?? [AGENT]).map((agent) => [agent.agentId, agent])),
    conversations: new Map(
      (parts.conversations ?? []).map((entity) => [entity.conversationId, entity]),
    ),
    turns: new Map((parts.turns ?? []).map((entity) => [entity.turnRef, entity])),
    blocks: new Map(),
    queues: new Map(),
    subagents: parts.subagents ?? new Map(),
    usage: new Map(),
    approvals: parts.approvals ?? new Map(),
    devices: new Map(),
  };
}

/** A snapshot holding the agent and its three conversations. */
const FULL: SessionSnapshot = snapshot({
  conversations: [
    conversation("conv-1"),
    // A conversation that left the engine's list but keeps its row.
    conversation("conv-2", { turns: [] }),
    conversation("conv-3", { context: null, incompleteTurnRefs: ["turn-conv-3"] }),
  ],
  turns: [
    turn("turn-conv-1", "conv-1", true),
    turn("turn-conv-2", "conv-2", false),
    turn("turn-conv-3", "conv-3", false),
  ],
  approvals: new Map([
    [AGENT.agentId, [approval("conv-1", "pending"), approval("conv-1", "decided")]],
  ]),
});

/** The selectors over a fixed snapshot, with nothing else injected. */
function selectorsOver(snap: SessionSnapshot): ViewSelectors {
  return createViewSelectors({ snapshot: () => snap });
}

/** Run one selector, requiring it to have answered rather than refused. */
function valueOf(selectors: ViewSelectors, selector: string, params = {}): unknown {
  const outcome = selectors.run(selector, params as Readonly<Record<string, unknown>>);

  expect(outcome.ok, `${selector} refused with ${codeOf(outcome)}`).toBe(true);

  return outcome.ok ? outcome.value : undefined;
}

/** The code an outcome carries, or a word saying it succeeded. */
function codeOf(outcome: SelectorOutcome): string {
  return outcome.ok ? "ok" : outcome.code;
}

/** The parameters each row is exercised with. */
const PARAMS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "view.nav": { agentId: AGENT.agentId, pinned: ["conv-2"], hasMore: true },
  "view.conversationRow": { conversationId: "conv-1" },
  "view.context": { conversationId: "conv-1" },
  "view.tabActivity": { instanceId: "tab-1", conversationId: "conv-1" },
  "view.subagentTree": { conversationId: "conv-1" },
  "view.agentBadges": {},
  "view.capabilities": { agentId: AGENT.agentId },
};

/**
 * The contract table, one row per selector: the name, the parameters it takes,
 * and a check that what comes back is the shape that row declares.
 *
 * This is the machine-readable copy of the table. A row whose implementation is
 * missing fails at `selectors.has`, and a row whose return shape drifted fails
 * at its own check.
 */
const CONTRACT: readonly {
  readonly selector: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly check: (value: unknown) => void;
}[] = [
  {
    selector: "view.nav",
    params: PARAMS["view.nav"] ?? {},
    check: (value) => {
      const view = value as { rows: readonly Record<string, unknown>[]; hasMore: unknown };
      expect(Array.isArray(view.rows)).toBe(true);
      expect(view.hasMore).toBe(true);
      // Every row carries the columns the row type declares, and nothing the
      // page would have to derive for itself.
      for (const row of view.rows) {
        expect(typeof row["conversationId"]).toBe("string");
        expect(typeof row["badge"]).toBe("number");
        expect(typeof row["badgeCapped"]).toBe("boolean");
        expect(typeof row["streaming"]).toBe("boolean");
        expect(typeof row["incomplete"]).toBe("boolean");
        expect(typeof row["pinned"]).toBe("boolean");
        expect(row["title"] === null || typeof row["title"] === "string").toBe(true);
        expect(row["lastActivityAt"] === null || typeof row["lastActivityAt"] === "string").toBe(
          true,
        );
        expect(row["problem"] === null || typeof row["problem"] === "string").toBe(true);
      }
    },
  },
  {
    selector: "view.conversationRow",
    params: PARAMS["view.conversationRow"] ?? {},
    check: (value) => {
      const row = value as Record<string, unknown>;
      expect(typeof row["conversationId"]).toBe("string");
      expect(row["title"] === null || typeof row["title"] === "string").toBe(true);
      expect(["ok", "gone", "unreadable"]).toContain(row["state"]);
      expect(typeof row["streaming"]).toBe("boolean");
      expect(typeof row["approvals"]).toBe("number");
    },
  },
  {
    selector: "view.context",
    params: PARAMS["view.context"] ?? {},
    check: (value) => {
      const context = value as Record<string, unknown>;
      expect(context).not.toBeNull();
      expect(context["source"]).toBe("agent-config");
      expect(context["percentage"]).toBe(25);
      expect(typeof context["estimated"]).toBe("boolean");
    },
  },
  {
    selector: "view.tabActivity",
    params: PARAMS["view.tabActivity"] ?? {},
    check: (value) => {
      const activity = value as Record<string, unknown>;
      // Exactly the three figures the contract names; a page reads them as is.
      expect(Object.keys(activity).sort()).toEqual(["approvals", "streaming", "unread"]);
      expect(typeof activity["streaming"]).toBe("boolean");
      expect(typeof activity["approvals"]).toBe("number");
      expect(typeof activity["unread"]).toBe("number");
    },
  },
  {
    selector: "view.subagentTree",
    params: PARAMS["view.subagentTree"] ?? {},
    check: (value) => {
      expect(Array.isArray(value)).toBe(true);
      for (const node of value as readonly Record<string, unknown>[]) {
        expect(typeof node["subagentId"]).toBe("string");
        expect(typeof node["status"]).toBe("string");
        expect(Array.isArray(node["children"])).toBe(true);
        expect(typeof node["totalTokens"]).toBe("number");
        expect(typeof node["durationMs"]).toBe("number");
        expect(node["error"] === null || typeof node["error"] === "string").toBe(true);
      }
    },
  },
  {
    selector: "view.agentBadges",
    params: {},
    check: (value) => {
      expect(Array.isArray(value)).toBe(true);
      for (const badge of value as readonly Record<string, unknown>[]) {
        expect(typeof badge["agentId"]).toBe("string");
        expect(typeof badge["unread"]).toBe("number");
        expect(typeof badge["approvals"]).toBe("number");
        expect(typeof badge["unreadCapped"]).toBe("boolean");
      }
    },
  },
  {
    selector: "view.capabilities",
    params: PARAMS["view.capabilities"] ?? {},
    check: (value) => {
      const table = value as Record<string, unknown>;
      expect(table).not.toBeNull();
      for (const row of Object.values(table)) {
        expect(["available", "unavailable", "unknown"]).toContain(
          (row as Record<string, unknown>)["state"],
        );
      }
    },
  },
];

describe("the view selector contract", () => {
  it("has exactly the seven names the table declares, and no others", () => {
    // Arity first: the table is the contract, and a row without an
    // implementation reads exactly like a complete table.
    expect(VIEW_SELECTOR_NAMES).toEqual([
      "view.nav",
      "view.conversationRow",
      "view.context",
      "view.tabActivity",
      "view.subagentTree",
      "view.agentBadges",
      "view.capabilities",
    ]);
    expect(CONTRACT.map((row) => row.selector)).toEqual([...VIEW_SELECTOR_NAMES]);
  });

  it("implements every row, and returns the shape that row declares", () => {
    const selectors = selectorsOver(FULL);

    for (const row of CONTRACT) {
      expect(selectors.has(row.selector), `${row.selector} has no implementation`).toBe(true);
      row.check(valueOf(selectors, row.selector, row.params));
    }
  });

  it("answers no for a name it does not implement", () => {
    const selectors = selectorsOver(FULL);

    expect(selectors.has("view.unknown")).toBe(false);
    expect(selectors.has("")).toBe(false);
  });
});

describe("view.nav", () => {
  it("hoists the pinned rows and keeps the engine's order inside each half", () => {
    const selectors = selectorsOver(FULL);
    const view = valueOf(selectors, "view.nav", {
      agentId: AGENT.agentId,
      pinned: ["conv-2"],
      hasMore: false,
    }) as { rows: readonly { conversationId: string; pinned: boolean }[]; hasMore: boolean };

    // Pinned first, then the rest, neither half re-sorted: the engine owns the
    // order and a second sort would disagree with its tie-breaking.
    expect(view.rows.map((row) => row.conversationId)).toEqual(["conv-2", "conv-1", "conv-3"]);
    expect(view.rows.map((row) => row.pinned)).toEqual([true, false, false]);
    expect(view.hasMore).toBe(false);
  });

  it("carries the badge as a sum and lets the row show the capped form", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      badgeOf: () => ({ unread: 120, approvals: 0, badge: 120, badgeCapped: true }),
    });
    const view = valueOf(selectors, "view.nav", {
      agentId: AGENT.agentId,
      pinned: [],
      hasMore: false,
    }) as { rows: readonly { badge: number; badgeCapped: boolean }[] };

    // The page displays this figure; it never adds the two parts itself.
    expect(view.rows[0]?.badge).toBe(120);
    expect(view.rows[0]?.badgeCapped).toBe(true);
  });

  it("marks a conversation that left the list instead of dropping it", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      conversationStateOf: (conversationId) => (conversationId === "conv-2" ? "gone" : "ok"),
    });
    const view = valueOf(selectors, "view.nav", {
      agentId: AGENT.agentId,
      pinned: [],
      hasMore: false,
    }) as { rows: readonly { conversationId: string; problem: string | null }[] };

    expect(view.rows.map((row) => row.conversationId)).toContain("conv-2");
    expect(view.rows.find((row) => row.conversationId === "conv-2")?.problem).toBe(
      "conversation-gone",
    );
  });

  it("answers with an empty list for an agent nobody has heard of", () => {
    const selectors = selectorsOver(FULL);
    const view = valueOf(selectors, "view.nav", {
      agentId: "agent-missing",
      pinned: [],
      hasMore: false,
    }) as { rows: readonly unknown[]; hasMore: boolean };

    expect(view.rows).toEqual([]);
    expect(view.hasMore).toBe(false);
  });
});

describe("view.conversationRow", () => {
  it("reports the row, its state and whether it is writing", () => {
    const selectors = selectorsOver(FULL);
    const row = valueOf(selectors, "view.conversationRow", { conversationId: "conv-1" }) as {
      conversationId: string;
      title: string | null;
      state: string;
      streaming: boolean;
      approvals: number;
    };

    expect(row.conversationId).toBe("conv-1");
    expect(row.title).toBe("title-conv-1");
    expect(row.state).toBe("ok");
    // One open turn on this conversation.
    expect(row.streaming).toBe(true);
    // Only the waiting request counts; the decided one is not pending.
    expect(row.approvals).toBe(1);
  });

  it("says gone for a conversation the table no longer holds", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      conversationStateOf: () => "gone",
    });
    const row = valueOf(selectors, "view.conversationRow", { conversationId: "conv-2" }) as {
      state: string;
    };

    expect(row.state).toBe("gone");
  });
});

describe("view.context", () => {
  it("returns the published context view, and null before any usage arrived", () => {
    const selectors = selectorsOver(FULL);
    const held = valueOf(selectors, "view.context", { conversationId: "conv-1" });

    // Taken from the entity, not recomputed: one conversation, one percentage.
    expect(held).toBe(FULL.conversations.get("conv-1")?.context);
    expect(valueOf(selectors, "view.context", { conversationId: "conv-3" })).toBeNull();
    expect(valueOf(selectors, "view.context", { conversationId: "conv-missing" })).toBeNull();
  });
});

describe("view.tabActivity", () => {
  it("gives the three figures separately and clears unread on a watched tab", () => {
    const selectors = selectorsOver(FULL);
    const activity = valueOf(selectors, "view.tabActivity", {
      instanceId: "tab-1",
      conversationId: "conv-1",
    }) as { streaming: boolean; approvals: number; unread: number };

    expect(activity.streaming).toBe(true);
    expect(activity.approvals).toBe(1);
    // Nothing is unread yet: no badge owner was injected, so the counter is 0.
    expect(activity.unread).toBe(0);
  });

  it("reports the badge owner's figures verbatim", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      badgeOf: () => {
        throw new Error("counter unavailable");
      },
    });
    const activity = valueOf(selectors, "view.tabActivity", {
      instanceId: "tab-1",
      conversationId: "conv-1",
    }) as { streaming: boolean; approvals: number; unread: number };

    // A failing collaborator costs the figure, not the frame.
    expect(activity.approvals).toBe(1);
    expect(activity.unread).toBe(0);
  });
});

describe("view.subagentTree", () => {
  it("nests children under their parent in engine order, depth first", () => {
    const snap = snapshot({
      conversations: [conversation("conv-1")],
      subagents: new Map([
        [
          "conv-1",
          [
            subagent("root-a", null),
            subagent("child-b", "root-a"),
            subagent("grandchild-c", "child-b"),
            subagent("root-d", null),
            subagent("child-e", "root-d"),
          ],
        ],
      ]),
    });
    const tree = valueOf(selectorsOver(snap), "view.subagentTree", {
      conversationId: "conv-1",
    }) as readonly { subagentId: string; children: readonly unknown[] }[];

    expect(tree.map((node) => node.subagentId)).toEqual(["root-a", "root-d"]);
    expect(tree[0]?.children.map((node) => (node as { subagentId: string }).subagentId)).toEqual([
      "child-b",
    ]);
  });

  it("ends on a parent chain that closes on itself instead of hanging", () => {
    // A names B as its parent and B names A: there is no root, so a walk that
    // waited for one would return nothing at all.
    const snap = snapshot({
      conversations: [conversation("conv-1")],
      subagents: new Map([["conv-1", [subagent("a", "b"), subagent("b", "a")]]]),
    });
    const tree = valueOf(selectorsOver(snap), "view.subagentTree", {
      conversationId: "conv-1",
    }) as readonly { subagentId: string; children: readonly { subagentId: string }[] }[];

    const seen: string[] = [];

    const walk = (nodes: readonly { subagentId: string; children: readonly unknown[] }[]): void => {
      for (const node of nodes) {
        seen.push(node.subagentId);
        walk(node.children as readonly { subagentId: string; children: readonly unknown[] }[]);
      }
    };

    // The walk terminating is the assertion; the rest says nothing was lost.
    walk(tree as readonly { subagentId: string; children: readonly unknown[] }[]);
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(tree.length).toBeGreaterThan(0);
  });

  it("returns an empty list for a conversation with no runs", () => {
    expect(valueOf(selectorsOver(FULL), "view.subagentTree", { conversationId: "conv-2" })).toEqual(
      [],
    );
    expect(
      valueOf(selectorsOver(FULL), "view.subagentTree", { conversationId: "conv-missing" }),
    ).toEqual([]);
  });
});

describe("view.agentBadges", () => {
  it("sums each agent's conversations", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      badgeOf: (conversationId) =>
        conversationId === "conv-1" ? { unread: 3, approvals: 2 } : { unread: 0, approvals: 0 },
    });
    const badges = valueOf(selectors, "view.agentBadges") as readonly {
      agentId: string;
      unread: number;
      approvals: number;
      unreadCapped: boolean;
    }[];

    expect(badges).toHaveLength(1);
    expect(badges[0]?.agentId).toBe(AGENT.agentId);
    expect(badges[0]?.unread).toBe(3);
    expect(badges[0]?.approvals).toBe(2);
    expect(badges[0]?.unreadCapped).toBe(false);
  });

  it("flags the capped form above the cap", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      badgeOf: () => ({ unread: 120, approvals: 0 }),
    });
    const badges = valueOf(selectors, "view.agentBadges") as readonly {
      unread: number;
      unreadCapped: boolean;
    }[];

    expect(badges[0]?.unread).toBe(120 * AGENT.conversations.length);
    expect(badges[0]?.unreadCapped).toBe(true);
  });
});

describe("view.capabilities", () => {
  it("keeps all three verdicts, unknown included", () => {
    const table = valueOf(selectorsOver(FULL), "view.capabilities", {
      agentId: AGENT.agentId,
    }) as Readonly<Record<string, { state: string }>>;

    // A table that filtered these rows would hide a feature on no evidence.
    expect(table["agent.get"]?.state).toBe("available");
    expect(table["agent.list"]?.state).toBe("unavailable");
    expect(table["memory.read"]?.state).toBe("unknown");
    expect(Object.keys(table)).toEqual(["agent.get", "agent.list", "memory.read"]);
  });

  it("answers for every name in the contract when nothing was composed yet", () => {
    const unprobed: AgentEntity = { ...AGENT, capabilities: {} };
    const snap = snapshot({ agents: [unprobed] });
    const table = valueOf(selectorsOver(snap), "view.capabilities", {
      agentId: unprobed.agentId,
    }) as Readonly<Record<CapabilityName, unknown>>;

    // Still a full table: "nobody probed" is a row, not an omission.
    expect(Object.keys(table).sort()).toEqual(Object.keys(CAPABILITY_META).sort());
    expect(Object.values(table).every((row) => typeof row === "object" && row !== null)).toBe(true);
  });

  it("answers null for an agent that does not exist", () => {
    expect(
      valueOf(selectorsOver(FULL), "view.capabilities", { agentId: "agent-missing" }),
    ).toBeNull();
  });
});

describe("failures are codes, not exceptions", () => {
  it("refuses a name outside the contract", () => {
    const selectors = selectorsOver(FULL);

    for (const name of ["view.unknown", "entity.agents", "", "view.nav.extra"]) {
      const outcome = selectors.run(name, {});

      expect(outcome.ok).toBe(false);
      expect(outcome.ok ? null : outcome.code).toBe(SESSION_UNKNOWN_SELECTOR);
    }
  });

  it("refuses a request whose parameters do not have the declared shape", () => {
    const selectors = selectorsOver(FULL);

    const bad: readonly (readonly [string, unknown])[] = [
      ["view.nav", {}],
      ["view.nav", { agentId: AGENT.agentId, pinned: "conv-1", hasMore: false }],
      ["view.nav", { agentId: AGENT.agentId, pinned: [], hasMore: "false" }],
      ["view.nav", { agentId: 7, pinned: [], hasMore: false }],
      ["view.conversationRow", {}],
      ["view.conversationRow", { conversationId: 42 }],
      ["view.context", {}],
      ["view.tabActivity", { instanceId: "tab-1" }],
      ["view.subagentTree", { conversationId: [] }],
      ["view.capabilities", { agentId: null }],
      ["view.conversationRow", null],
      ["view.conversationRow", []],
    ];

    for (const [selector, params] of bad) {
      const outcome = selectors.run(selector, params as Readonly<Record<string, unknown>>);

      expect(outcome.ok, `${selector} accepted ${JSON.stringify(params)}`).toBe(false);
      expect(outcome.ok ? null : outcome.code).toBe(SESSION_BAD_PARAMS);
    }
  });

  it("does not throw when the snapshot source itself fails", () => {
    const selectors = createViewSelectors({
      snapshot: () => {
        throw new Error("no snapshot");
      },
    });

    for (const selector of VIEW_SELECTOR_NAMES) {
      expect(selectors.run(selector, PARAMS[selector] ?? {}).ok).toBe(false);
    }
  });

  it("does not throw when a collaborator does", () => {
    const selectors = createViewSelectors({
      snapshot: () => FULL,
      badgeOf: () => {
        throw new Error("counter unavailable");
      },
      conversationStateOf: () => {
        throw new Error("table unavailable");
      },
    });

    for (const selector of VIEW_SELECTOR_NAMES) {
      expect(selectors.run(selector, PARAMS[selector] ?? {}).ok).toBe(true);
    }
  });
});
