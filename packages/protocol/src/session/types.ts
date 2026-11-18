/**
 * The domain state a session store publishes to renderers: nine entity types,
 * one immutable snapshot, six derived view types and the machine codes a page
 * maps to its own wording.
 *
 * Everything here is readonly. The store owns the mutable side; a renderer
 * borrows a snapshot and must be able to hand it to another module without
 * wondering whether someone will edit it underneath.
 *
 * Two kinds of type live side by side on purpose:
 *
 * - entities are the folded domain state, one map per kind, keyed by id;
 * - views are the derived values a page actually renders (unread badges,
 *   context pressure, navigation rows). A page never recomputes a derived
 *   value from entities, because then two modules would own the same rule.
 *
 * No user-facing text is declared here: only identifiers and codes. Selecting
 * wording is a page's job.
 */

/**
 * Shapes this module names but does not define.
 *
 * This package is the leaf of the dependency graph: it may not import another
 * workspace package, not even for a type, so a shape whose source of truth sits
 * in a package above it cannot be referenced. The three aliases below are
 * therefore names rather than definitions - they keep the member signatures
 * readable and stay deliberately permissive, so the owning package can supply
 * its own richer type without a cast on the way in.
 *
 * The real definitions live where the values are produced: the merged change
 * and the usage snapshot in the event merger, the capability availability in
 * the capability module. When that code moves into this package instead, each
 * alias is replaced by an import and nothing else changes.
 */
export type MergerChange = Readonly<Record<string, unknown>>;
export type UsageSnapshot = Readonly<Record<string, unknown>>;
export type CapabilityAvailability = Readonly<Record<string, unknown>>;

/** One agent's domain state. Every field is readonly; the whole is immutable. */
export type AgentEntity = {
  readonly agentId: string;
  readonly name: string | null;
  readonly description: string | null;
  /** Per-capability availability; composed upstream, never by a page. */
  readonly capabilities: Readonly<Record<string, CapabilityAvailability>>;
  /** Conversation ids, in engine order. */
  readonly conversations: readonly string[];
};

/** One conversation, plus the row the engine sent and the state folded around it. */
export type ConversationEntity = {
  readonly conversationId: string;
  readonly agentId: string;
  /** The engine's raw list row, unrewritten (`hidden`, `contextMessageCount`, ...). */
  readonly row: Readonly<Record<string, unknown>>;
  /**
   * The engine's own "last activity" timestamp string, already sorted by the
   * engine; null when absent. Taken from one of the row's three timestamps.
   */
  readonly lastActivityAt: string | null;
  /** Turn refs, in chronological order. */
  readonly turns: readonly string[];
  /** Current context pressure; null until a usage report arrives. */
  readonly context: ContextView | null;
  /** Turns flagged as possibly missing content, keyed by turn ref; empty when none. */
  readonly incompleteTurnRefs: readonly string[];
};

/**
 * One turn.
 *
 * The primary key is `turnRef`, not `turnId`: a turn in flight has no
 * `turnId` yet, because only the terminal frame carries it. A turn starts
 * existing at the first change related to it; the terminal frame fills in
 * `turnId` and the closing fields and never creates a second record.
 */
export type TurnEntity = {
  /** Stable key for the whole life of the turn. */
  readonly turnRef: string;
  /** Null while streaming; filled in when the terminal frame arrives. */
  readonly turnId: string | null;
  readonly runId: string | null;
  readonly conversationId: string;
  readonly stopReason: string | null;
  /** Still running, i.e. no terminal signal yet. A page draws its "writing" pulse from this. */
  readonly open: boolean;
  /** Block ids, in render order. */
  readonly blocks: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly incomplete: boolean;
  readonly startedAt: number;
  /** Null until the turn is closed. */
  readonly finishedAt: number | null;
};

/** One block, attached to the turn that owns it. */
export type BlockEntity = {
  readonly blockId: string;
  /** The owning turn's stable key - not its `turnId`. */
  readonly turnRef: string;
  /** Which message and run produced the block. */
  readonly messageId: string | null;
  readonly runId: string | null;
  /** The producer's plain data block; never rewritten here. */
  readonly block: Readonly<Record<string, unknown>>;
};

/** The queue of one conversation after its removals have been applied. */
export type QueueEntity = {
  readonly conversationId: string;
  /** Engine payload as sent, with the removal list already applied. */
  readonly items: readonly Readonly<Record<string, unknown>>[];
  readonly count: number;
};

/** One subagent run attached to a conversation. */
export type SubagentEntity = {
  readonly subagentId: string;
  readonly parentAgentId: string | null;
  readonly conversationId: string | null;
  readonly status: "pending" | "running" | "completed" | "error";
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly error: string | null;
};

/** Usage for one conversation: the latest report plus the per-turn trail. */
export type UsageEntity = {
  readonly conversationId: string;
  /** The most recent report, not an accumulation. */
  readonly latest: UsageSnapshot;
  readonly history: readonly { turnRef: string; at: number; usage: UsageSnapshot }[];
};

/** One approval request, deduplicated across every path that reports it. */
export type ApprovalEntity = {
  readonly requestId: string;
  readonly agentId: string;
  readonly conversationId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** Three states: awaiting a decision, decided, or expired/superseded. Idempotent per id. */
  readonly state: "pending" | "decided" | "expired";
  readonly requestedAt: number;
};

/** The device facts a renderer needs, projected rather than forwarded whole. */
export type DeviceEntity = {
  readonly agentId: string;
  readonly view: {
    readonly isOnline: boolean;
    readonly isProcessing: boolean;
    readonly permissionMode: string | null;
    readonly cwd: string | null;
    readonly toolsetPreference: string | null;
    readonly pendingApprovals: number;
    readonly backgroundProcesses: number;
    /** The engine's loop status; every state is kept, not collapsed. */
    readonly loop: string | null;
  };
};

/** One immutable snapshot. References are stable within one revision. */
export type SessionSnapshot = {
  readonly revision: number;
  /** Connection generation: increments on reconnect, and older values are dropped. */
  readonly epoch: number;
  readonly agents: ReadonlyMap<string, AgentEntity>;
  readonly conversations: ReadonlyMap<string, ConversationEntity>;
  readonly turns: ReadonlyMap<string, TurnEntity>;
  readonly blocks: ReadonlyMap<string, BlockEntity>;
  readonly queues: ReadonlyMap<string, QueueEntity>;
  readonly subagents: ReadonlyMap<string, readonly SubagentEntity[]>;
  readonly usage: ReadonlyMap<string, UsageEntity>;
  readonly approvals: ReadonlyMap<string, readonly ApprovalEntity[]>;
  readonly devices: ReadonlyMap<string, DeviceEntity>;
};

/** One row of the navigation list. The order is decided here: pinned first, engine order after. */
export type NavRow = {
  readonly conversationId: string;
  readonly title: string | null;
  /** Unread turns plus pending approvals; a page displays it and never adds. */
  readonly badge: number;
  /** True when the badge exceeded its cap, so a page renders the capped form. */
  readonly badgeCapped: boolean;
  readonly streaming: boolean;
  readonly incomplete: boolean;
  readonly pinned: boolean;
  readonly lastActivityAt: string | null;
  /** A code from the problem table when the row could not be read; null when fine. */
  readonly problem: string | null;
};

/** The navigation list: rows plus whether the caller has more pages to fetch. */
export type NavView = {
  readonly rows: readonly NavRow[];
  /** Reported by the caller; this layer does not guess it. */
  readonly hasMore: boolean;
};

/** Derived context pressure for one conversation. */
export type ContextView = {
  /** Provider-reported usage; null when not reported. */
  readonly tokens: number | null;
  /** The denominator, after the three-step fallback; null when none could be found. */
  readonly limit: number | null;
  readonly source: "conversation-override" | "agent-config" | "model-catalog" | "none";
  /** Null when `limit` is null: with no ceiling a page shows the raw figure, not a ratio. */
  readonly percentage: number | null;
  /** Three-way estimate; `system` includes memory. */
  readonly parts: { system: number; tools: number; messages: number } | null;
  /** True when the figures are estimates rather than measured. */
  readonly estimated: boolean;
};

/** One conversation row as a page header renders it. */
export type ConversationRowView = {
  readonly conversationId: string;
  readonly title: string | null;
  readonly state: "ok" | "gone" | "unreadable";
  readonly streaming: boolean;
  readonly approvals: number;
};

/** One node of a conversation's subagent tree. */
export type SubagentNode = {
  readonly subagentId: string;
  readonly status: SubagentEntity["status"];
  readonly children: readonly SubagentNode[];
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly error: string | null;
};

/** Aggregate badges for one agent, shown in the agent switcher. */
export type AgentBadge = {
  readonly agentId: string;
  readonly unread: number;
  readonly approvals: number;
  readonly unreadCapped: boolean;
};

/**
 * Per-tab view state: scroll anchor and collapsed groups.
 *
 * Keyed by the tab instance, not by conversation, so two tabs on one
 * conversation remember their own positions. It lives for this run only and is
 * released when the tab closes.
 */
export type ViewState = {
  /** The anchored message or block id plus its offset inside the viewport. */
  readonly anchor: { readonly id: string; readonly offset: number } | null;
  /** Collapsed group ids, as the collapsing rule produced them. */
  readonly collapsed: readonly string[];
};

/**
 * The selector failure codes.
 *
 * Codes only. A page maps them to its own wording, so this layer never needs a
 * translation key.
 */
export const SESSION_UNKNOWN_SELECTOR = "SESSION_UNKNOWN_SELECTOR" as const;
export const SESSION_BAD_PARAMS = "SESSION_BAD_PARAMS" as const;
export const SESSION_UNAVAILABLE = "SESSION_UNAVAILABLE" as const;

/** Why a navigation row could not be read. */
export const SESSION_ROW_UNREADABLE = "row-unreadable" as const;

/** Why a conversation no longer exists in the latest list. */
export const SESSION_CONVERSATION_GONE = "conversation-gone" as const;

/** The closed set of selector failure codes, for a reply body and for exhaustive handling. */
export type SessionSelectCode =
  typeof SESSION_UNKNOWN_SELECTOR | typeof SESSION_BAD_PARAMS | typeof SESSION_UNAVAILABLE;

/** The closed set of row problems, for diagnostics and for row rendering. */
export type SessionRowProblemCode =
  typeof SESSION_ROW_UNREADABLE | typeof SESSION_CONVERSATION_GONE;
