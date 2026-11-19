/**
 * The seven view selectors: the derived values a page renders, assembled from
 * the parts that already own each rule.
 *
 * A page never recomputes a derived value. It asks for one by name, this module
 * runs it against the current snapshot, and the answer travels back as a
 * selector result. There is deliberately no business rule in this file: the
 * navigation order belongs to the navigation builder, the badge arithmetic to
 * the unread counter, the capability verdicts to the capability table. What this
 * module owns is the seam between those parts and the request shape the contract
 * declares - which selector takes which keys, and what each one returns.
 *
 * Three properties hold for every selector here:
 *
 * - **Never throws.** The caller is a frame handler; a selector that throws
 *   would cost the session, and a page asked for a value it cannot have. A
 *   handler that fails internally reports no value instead.
 * - **A missing value is not an error.** A conversation that is not held, an
 *   agent nothing has been heard of, a context that never arrived: each answers
 *   with the empty form its own return type allows (`null`, `[]`, or zeroes),
 *   because "nothing yet" is a state a page draws, not a failure.
 * - **Three codes, and only those three.** A name outside the contract is
 *   `SESSION_UNKNOWN_SELECTOR`; a request whose parameters do not have the
 *   declared shape is `SESSION_BAD_PARAMS`; a snapshot that cannot be read at
 *   all is `SESSION_UNAVAILABLE`.
 */

import type {
  AgentBadge,
  AgentEntity,
  ConversationEntity,
  ConversationRowView,
  NavView,
  SessionSnapshot,
  SubagentEntity,
  SubagentNode,
} from "@haruyuki/protocol";
import {
  SESSION_BAD_PARAMS,
  SESSION_UNAVAILABLE,
  SESSION_UNKNOWN_SELECTOR,
} from "@haruyuki/protocol";

import { capabilityTable, type CapabilityTable } from "../capability-gate.js";
import { ENTITY_ID_CHAR_LIMIT } from "../entities.js";
import { buildNavView, type NavBadgeReading, type NavRowSource } from "../nav.js";
import { UNREAD_CAP, type UnreadBadge } from "../unread.js";
import type { SelectorOutcome } from "./entity.js";

/**
 * The outcome shape is the entity selectors' declaration, imported rather than
 * restated: the assembly tries one table and then the other, so a field added
 * to one copy and not the other would show up as "half the selectors answer in
 * a shape the caller does not expect". Re-exported under this module's name
 * because a caller that only holds the view table should not have to reach
 * into its neighbour for the type of what it gets back.
 */
export type { SelectorOutcome };

/** The seven names, in contract order. The table is the contract; this is it. */
export const VIEW_SELECTOR_NAMES = [
  "view.nav",
  "view.conversationRow",
  "view.context",
  "view.tabActivity",
  "view.subagentTree",
  "view.agentBadges",
  "view.capabilities",
] as const;

/** One of the names above. */
export type ViewSelectorName = (typeof VIEW_SELECTOR_NAMES)[number];

/**
 * What one selector run amounts to.
 *
 * The same shape the entity selectors answer with, so the assembly can try one
 * table and then the other without translating an outcome. `value` is declared
 * `unknown` here and narrowed by {@link ViewSelectors.run} callers against the
 * contract, because a single union of seven return shapes would be read as one
 * shape by everyone who does not switch on the selector first.
 */

/** The badge figures one conversation reports, as its owner computed them. */
type BadgeReading = {
  readonly unread: number;
  readonly approvals: number;
  readonly badge: number;
  readonly badgeCapped: boolean;
};

/**
 * What the selectors need from the assembly.
 *
 * `snapshot` is the only required member: it is the one source every selector
 * reads. The rest are collaborator seams for values whose owner lives outside
 * the snapshot - the badge counter is a mutable table the store holds, the
 * conversation states live in the conversation table, and whether a
 * conversation is writing has no entity slot of its own. Each is optional:
 * with none of them injected the selectors still answer, using the snapshot and
 * documented defaults, so a test can run this module alone.
 */
export interface ViewSelectorDeps {
  /** The current snapshot; called once per run. */
  readonly snapshot: () => SessionSnapshot;
  /**
   * The merged badge for one conversation, as the unread counter reports it.
   *
   * When injected it is the authority for both the unread figure and the
   * pending-approval figure, because the two are counted by the same table.
   */
  readonly badgeOf?: (conversationId: string) => Partial<UnreadBadge> | null | undefined;
  /** Whether one conversation is currently writing. Falls back to its open turns. */
  readonly streamingOf?: (conversationId: string) => boolean;
  /**
   * One conversation's table state (`ok` / `gone` / `unreadable`).
   *
   * Kept as a seam rather than a snapshot field because the state is the
   * conversation table's, not the entity's: an entity stays after its row left
   * the list, and only the table knows which of the two happened.
   */
  readonly conversationStateOf?: (
    conversationId: string,
  ) => ConversationRowView["state"] | null | undefined;
  /** The engine's reported version, for composing a capability table. */
  readonly engineVersion?: () => string | null;
}

/** The selector table. */
export interface ViewSelectors {
  /** The seven names, in contract order. */
  readonly names: readonly string[];
  /** Whether this table answers for one name. */
  has(selector: string): boolean;
  /**
   * Run one selector.
   *
   * @param selector a name from the contract
   * @param params the parameters that name declares
   * @returns the value, or the one code that says why there is none
   */
  run(selector: string, params: Readonly<Record<string, unknown>>): SelectorOutcome;
}

/** One handler: it reads its own parameters and never throws outward. */
type ViewHandler = (params: unknown) => SelectorOutcome;

/** The id length the entity layer accepts; the same rule applies to a request. */
const ID_CHAR_LIMIT = ENTITY_ID_CHAR_LIMIT;

/** A refusal no handler needs to construct by hand. */
const BAD_PARAMS: SelectorOutcome = { ok: false, code: SESSION_BAD_PARAMS };
const UNAVAILABLE: SelectorOutcome = { ok: false, code: SESSION_UNAVAILABLE };

/** A bounded read, so a getter that throws costs one field and not the answer. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** An id, or `null` when the value cannot be one. */
function readId(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > ID_CHAR_LIMIT) {
    return null;
  }

  return value;
}

/** Text, or `null`; an empty string is no text rather than an empty one. */
function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A count, or `null` when the value is not one a figure could be. */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A flag, read strictly: anything but `true` is not a yes. */
function readFlag(value: unknown): boolean {
  return value === true;
}

/** One of the three row states, or `null`. */
function readRowState(value: unknown): ConversationRowView["state"] | null {
  return value === "ok" || value === "gone" || value === "unreadable" ? value : null;
}

/** One of the four subagent states, or `null`. */
function readSubagentStatus(value: unknown): SubagentEntity["status"] | null {
  return value === "pending" || value === "running" || value === "completed" || value === "error"
    ? value
    : null;
}

/** The parameters as a record, or `null` when the caller sent something else. */
function readParams(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Readonly<Record<string, unknown>>;
}

/** A list of ids, or `null` when the value is not one. */
function readIdList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const ids: string[] = [];

  for (const entry of value) {
    const id = readId(entry);

    if (id === null) {
      return null;
    }

    ids.push(id);
  }

  return Object.freeze(ids);
}

/** The conversation title, read off the row the engine sent, or `null`. */
function titleOf(conversation: ConversationEntity | null): string | null {
  if (conversation === null) {
    return null;
  }

  return readText(attempt(() => conversation.row["title"], null));
}

/**
 * Build the seven view selectors over one assembly.
 *
 * @param deps the snapshot source and the optional collaborator seams
 * @returns the table, with the names it answers for
 */
export function createViewSelectors(deps: ViewSelectorDeps): ViewSelectors {
  /** The snapshot, or `null` when the source itself cannot be read. */
  const snapshotOrNull = (): SessionSnapshot | null => attempt(() => deps.snapshot(), null);

  /** The badge figures for one conversation, from the owner or the snapshot. */
  const badgeOf = (conversationId: string, snapshot: SessionSnapshot): BadgeReading => {
    const injected =
      deps.badgeOf === undefined
        ? null
        : attempt(() => deps.badgeOf?.(conversationId) ?? null, null);

    const unread = readCount(injected?.unread) ?? 0;
    const approvals =
      readCount(injected?.approvals) ??
      // No badge owner: what the snapshot still says for certain is how many
      // requests are waiting. An unread count nobody reported reads as zero.
      countPendingApprovals(conversationId, snapshot);
    const badge = readCount(injected?.badge) ?? unread + approvals;

    return {
      unread,
      approvals,
      badge,
      badgeCapped:
        typeof injected?.badgeCapped === "boolean" ? injected.badgeCapped : badge > UNREAD_CAP,
    };
  };

  /** Pending approvals for one conversation, as the snapshot holds them. */
  const countPendingApprovals = (conversationId: string, snapshot: SessionSnapshot): number => {
    let pending = 0;

    for (const rows of snapshot.approvals.values()) {
      for (const row of rows) {
        if (readId(attempt(() => row.conversationId, null)) === conversationId) {
          if (attempt(() => row.state, null) === "pending") {
            pending += 1;
          }
        }
      }
    }

    return pending;
  };

  /**
   * Whether one conversation is writing.
   *
   * Injected when the assembly projects it from the loop state; otherwise a
   * conversation is writing exactly while it still has an open turn, which is
   * the same fact the turn table folds.
   */
  const streamingOf = (conversationId: string, snapshot: SessionSnapshot): boolean => {
    if (deps.streamingOf !== undefined) {
      return attempt(() => deps.streamingOf?.(conversationId) === true, false);
    }

    const conversation = snapshot.conversations.get(conversationId) ?? null;

    if (conversation === null) {
      return false;
    }

    for (const turnRef of conversation.turns) {
      const turn = snapshot.turns.get(turnRef);

      if (turn !== undefined && turn.open === true) {
        return true;
      }
    }

    return false;
  };

  /** One conversation's state, from the table that owns it, or the entity's. */
  const stateOf = (
    conversationId: string,
    snapshot: SessionSnapshot,
  ): ConversationRowView["state"] => {
    if (deps.conversationStateOf !== undefined) {
      const declared = attempt(
        () => readRowState(deps.conversationStateOf?.(conversationId) ?? null),
        null,
      );

      if (declared !== null) {
        return declared;
      }
    }

    // An entity stays after its row left the latest list, so presence is not a
    // substitute for the table's answer; it is only the fallback when nobody
    // injected one.
    return snapshot.conversations.has(conversationId) ? "ok" : "gone";
  };

  /** The navigation rows for one agent, in the order the agent holds them. */
  const navRowsOf = (agent: AgentEntity, snapshot: SessionSnapshot): readonly NavRowSource[] => {
    const rows: NavRowSource[] = [];

    for (const conversationId of agent.conversations) {
      const conversation = snapshot.conversations.get(conversationId) ?? null;

      rows.push({
        conversationId,
        title: titleOf(conversation),
        state: stateOf(conversationId, snapshot),
        approvals: badgeOf(conversationId, snapshot).approvals,
        streaming: streamingOf(conversationId, snapshot),
        lastActivityAt: conversation?.lastActivityAt ?? null,
      });
    }

    return rows;
  };

  /**
   * One conversation's subagent forest.
   *
   * The rows arrive as a flat list in engine order and name their parent. Two
   * facts shape the walk:
   *
   * - **Engine order is kept.** A node's children appear in the order the rows
   *   carried them, never sorted.
   * - **A cycle must not recurse forever.** A parent chain that closes on
   *   itself has no root, so a roots-first walk would return nothing at all and
   *   hide rows that are really there. Instead each row is placed at most once,
   *   either under its parent or, when no root reached it, as a root of its own
   *   - and the recursion refuses to enter an id it is already inside. The
   *   visited set bounds the work by the number of rows and makes the walk
   *   terminate on any input.
   */
  const subagentTreeOf = (
    conversationId: string,
    snapshot: SessionSnapshot,
  ): readonly SubagentNode[] => {
    const rows = snapshot.subagents.get(conversationId) ?? [];
    const byId = new Map<string, SubagentEntity>();
    const order: string[] = [];

    for (const row of rows) {
      const id = readId(attempt(() => row.subagentId, null));

      // First occurrence keeps the place, mirroring how a re-sent row is
      // handled everywhere else in this layer.
      if (id !== null && !byId.has(id)) {
        byId.set(id, row);
        order.push(id);
      }
    }

    const childrenOf = new Map<string, string[]>();

    for (const id of order) {
      const parentId = readId(attempt(() => byId.get(id)?.parentAgentId ?? null, null));

      if (parentId === null || parentId === id || !byId.has(parentId)) {
        continue;
      }

      const held = childrenOf.get(parentId);

      if (held === undefined) {
        childrenOf.set(parentId, [id]);
      } else if (!held.includes(id)) {
        held.push(id);
      }
    }

    const placed = new Set<string>();

    const build = (id: string, path: ReadonlySet<string>): SubagentNode | null => {
      // Already on the path: this edge would close a cycle, so it is dropped
      // rather than followed. Already placed elsewhere: a tree, not a graph.
      if (path.has(id) || placed.has(id)) {
        return null;
      }

      const row = byId.get(id);

      if (row === undefined) {
        return null;
      }

      placed.add(id);

      const nextPath = new Set(path);
      nextPath.add(id);

      const children: SubagentNode[] = [];

      for (const childId of childrenOf.get(id) ?? []) {
        const child = build(childId, nextPath);

        if (child !== null) {
          children.push(child);
        }
      }

      return Object.freeze({
        subagentId: id,
        status: readSubagentStatus(attempt(() => row.status, null)) ?? "pending",
        children: Object.freeze(children),
        totalTokens: readCount(attempt(() => row.totalTokens, null)) ?? 0,
        durationMs: readCount(attempt(() => row.durationMs, null)) ?? 0,
        error: readText(attempt(() => row.error, null)),
      });
    };

    const roots: SubagentNode[] = [];

    // Pass one: the honest roots.
    for (const id of order) {
      const parentId = readId(attempt(() => byId.get(id)?.parentAgentId ?? null, null));

      if (parentId === null || parentId === id || !byId.has(parentId)) {
        const node = build(id, new Set());

        if (node !== null) {
          roots.push(node);
        }
      }
    }

    // Pass two: whatever no root reached - a cycle, or a row whose ancestor
    // chain is missing. Its own subtree is still a fact worth returning.
    for (const id of order) {
      if (placed.has(id)) {
        continue;
      }

      const node = build(id, new Set());

      if (node !== null) {
        roots.push(node);
      }
    }

    return Object.freeze(roots);
  };

  /** Every agent's badge totals, in the order the agents first appeared. */
  const agentBadgesOf = (snapshot: SessionSnapshot): readonly AgentBadge[] => {
    const badges: AgentBadge[] = [];

    for (const agent of snapshot.agents.values()) {
      let unread = 0;
      let approvals = 0;

      for (const conversationId of agent.conversations) {
        const figures = badgeOf(conversationId, snapshot);

        unread += figures.unread;
        approvals += figures.approvals;
      }

      badges.push(
        Object.freeze({
          agentId: agent.agentId,
          unread,
          approvals,
          unreadCapped: unread > UNREAD_CAP,
        }),
      );
    }

    return Object.freeze(badges);
  };

  const handlers: Readonly<Record<string, ViewHandler>> = {
    "view.nav": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const agentId = bag === null ? null : readId(bag["agentId"]);
      const pinned = bag === null ? null : readIdList(bag["pinned"]);
      const hasMore = bag === null ? undefined : bag["hasMore"];

      if (agentId === null || pinned === null || typeof hasMore !== "boolean") {
        return BAD_PARAMS;
      }

      const agent = snapshot.agents.get(agentId) ?? null;
      const rows = agent === null ? [] : navRowsOf(agent, snapshot);
      const badge: (conversationId: string) => NavBadgeReading = (conversationId) =>
        badgeOf(conversationId, snapshot);

      // The builder owns the order: pinned first, engine order inside each
      // half. It also carries each row's state alongside the protocol's row, so
      // a page can draw a departed conversation without a second lookup.
      const value: NavView = buildNavView({
        rows: rows.map((row) => ({ ...row })),
        pinned,
        hasMore,
        badgeOf: badge,
        streamingOf: (conversationId) => streamingOf(conversationId, snapshot),
        // A conversation may be missing content; the turn table folded that
        // answer onto the entity, so it is read from there rather than inferred
        // from how many turns happen to be open.
        incompleteOf: (conversationId) =>
          (snapshot.conversations.get(conversationId)?.incompleteTurnRefs.length ?? 0) > 0,
      });

      return { ok: true, value };
    },

    "view.conversationRow": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const conversationId = bag === null ? null : readId(bag["conversationId"]);

      if (conversationId === null) {
        return BAD_PARAMS;
      }

      const conversation = snapshot.conversations.get(conversationId) ?? null;

      const value: ConversationRowView = Object.freeze({
        conversationId,
        title: titleOf(conversation),
        state: stateOf(conversationId, snapshot),
        streaming: streamingOf(conversationId, snapshot),
        approvals: badgeOf(conversationId, snapshot).approvals,
      });

      return { ok: true, value };
    },

    "view.context": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const conversationId = bag === null ? null : readId(bag["conversationId"]);

      if (conversationId === null) {
        return BAD_PARAMS;
      }

      // Published, not recomputed: the denominator rule runs where the usage
      // report is folded in, and a second call to it here would let two
      // percentages disagree about one conversation.
      const conversation = snapshot.conversations.get(conversationId) ?? null;

      return { ok: true, value: conversation?.context ?? null };
    },

    "view.tabActivity": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const instanceId = bag === null ? null : readId(bag["instanceId"]);
      const conversationId = bag === null ? null : readId(bag["conversationId"]);

      if (instanceId === null || conversationId === null) {
        return BAD_PARAMS;
      }

      // The instance is what the subscription is keyed on; the figures are the
      // conversation's, because a tab shows the conversation it was opened on.
      const figures = badgeOf(conversationId, snapshot);

      return {
        ok: true,
        value: Object.freeze({
          streaming: streamingOf(conversationId, snapshot),
          approvals: figures.approvals,
          unread: figures.unread,
        }),
      };
    },

    "view.subagentTree": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const conversationId = bag === null ? null : readId(bag["conversationId"]);

      if (conversationId === null) {
        return BAD_PARAMS;
      }

      return { ok: true, value: subagentTreeOf(conversationId, snapshot) };
    },

    "view.agentBadges": (params): SelectorOutcome => {
      // No parameters are declared for this row, so none are read: a caller
      // that sends some is not refused for it.
      void params;

      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      return { ok: true, value: agentBadgesOf(snapshot) };
    },

    "view.capabilities": (params): SelectorOutcome => {
      const snapshot = snapshotOrNull();

      if (snapshot === null) {
        return UNAVAILABLE;
      }

      const bag = readParams(params);
      const agentId = bag === null ? null : readId(bag["agentId"]);

      if (agentId === null) {
        return BAD_PARAMS;
      }

      const agent = snapshot.agents.get(agentId) ?? null;

      if (agent === null) {
        return { ok: true, value: null };
      }

      const composed: CapabilityTable = Object.freeze({
        ...agent.capabilities,
      }) as CapabilityTable;

      if (Object.keys(composed).length > 0) {
        // The assembled table is the authority once it exists. Nothing is
        // filtered out of it: `unknown` and `unavailable` rows are rows, and
        // which ones a page draws is that page's rule.
        return { ok: true, value: composed };
      }

      // Nothing has been composed for this agent yet. That is "nobody has
      // probed", not "no capabilities": the table builder already answers the
      // question for an unprobed agent, so it is asked rather than a second
      // rule invented here. Every name comes back, gated ones as `unknown`.
      const engineVersion =
        deps.engineVersion === undefined ? "" : attempt(() => deps.engineVersion?.() ?? "", "");

      return {
        ok: true,
        value: capabilityTable({ probe: { state: "unknown" }, engineVersion }),
      };
    },
  };

  return {
    names: VIEW_SELECTOR_NAMES,

    has(selector) {
      return typeof selector === "string" && Object.hasOwn(handlers, selector);
    },

    run(selector, params) {
      const handler =
        typeof selector === "string" && Object.hasOwn(handlers, selector)
          ? handlers[selector]
          : undefined;

      if (handler === undefined) {
        return { ok: false, code: SESSION_UNKNOWN_SELECTOR };
      }

      try {
        return handler(params);
      } catch {
        // A read path must not take the session down. A handler that fails this
        // way is a bug, and reporting "no value" is the smallest failure a page
        // can be shown.
        return UNAVAILABLE;
      }
    },
  };
}
