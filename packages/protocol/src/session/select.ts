/**
 * The wire side of the session layer: what a renderer asks for, what comes
 * back, and the members a session store offers.
 *
 * Types only. The store, the selectors and the push planning live in the core
 * package; this file exists so a renderer can name the request it sends and the
 * result it receives without reaching into the implementation.
 *
 * A renderer never evaluates a selector. It asks for one by name, the core runs
 * it, and the answer arrives as a control frame body. That keeps the derived
 * values in one place and keeps a page from holding business state.
 */

import type {
  ContextView,
  MergerChange,
  SessionSelectCode,
  SessionSnapshot,
  UsageSnapshot,
  ViewState,
} from "./types.js";

/**
 * One selector request.
 *
 * `params` stays an open record: the selector table is the contract for which
 * keys a given selector reads, and this module does not restate it in a union
 * that would have to be edited twice.
 */
export type SelectRequest = {
  /** Required for subscribe/unsubscribe; optional for a one-shot select. */
  readonly instanceId: string;
  readonly selector: string;
  readonly params: Readonly<Record<string, unknown>>;
  /**
   * Subscription only: whether the tab holding this instance is the active one.
   * The store uses it to decide when a conversation stopped being "somewhere
   * else", which is the only moment unread counts are cleared.
   */
  readonly active?: boolean;
};

/** One selector result, as it travels back to a renderer. */
export type SelectResult = {
  readonly selector: string;
  readonly params: Readonly<Record<string, unknown>>;
  /** Monotonic; two results with the same revision carry the same value. */
  readonly revision: number;
  /** Connection generation; a result from an older generation must be dropped. */
  readonly epoch: number;
  /** The selector's return shape, as the selector table declares it. */
  readonly value: unknown;
};

/** The body of a `session.view` frame: one selector result for one subscription. */
export type SessionViewBody = SelectResult & { readonly instanceId: string };

/** The body of a `session.result` frame, both arms. */
export type SessionResultBody =
  | ({ readonly ok: true } & SelectResult)
  | { readonly ok: false; readonly selector: string; readonly code: SessionSelectCode };

/**
 * The store's outward members.
 *
 * Signature only: this package declares the shape and never implements it. The
 * store holds no channel and does no I/O - everything comes in through an
 * `ingest*` member and goes out through `subscribe`/`select`, and emitting a
 * frame is the shell's job.
 */
export interface SessionStore {
  /** The current snapshot; stable within one revision and immutable as a whole. */
  getSnapshot(): SessionSnapshot;

  /** Take one merged change; synchronous and never throws. Reports whether the revision advanced. */
  ingest(change: MergerChange): boolean;

  /** Take one page of agents, already fetched by the caller. */
  ingestAgents(rows: readonly Readonly<Record<string, unknown>>[]): void;

  /** Take one page of conversations, already fetched by the caller. */
  ingestConversations(
    rows: readonly Readonly<Record<string, unknown>>[],
    opts: { hasMore: boolean },
  ): void;

  /**
   * Take one content update from the block parser: which message it belongs to,
   * the blocks to insert or replace, and the block ids to drop.
   *
   * The update shape is written inline rather than named, because the canonical
   * definition of a content update belongs to the block layer that is still
   * being lifted into this package. Naming a second one here would let "what a
   * block is" have two sources of truth. Once that definition lands, this
   * parameter becomes a type import and nothing else about the signature moves.
   *
   * A block is never rewritten: it is attached to the in-flight turn of its
   * message, and an upsert for an existing block id replaces the object while
   * keeping its first position.
   */
  ingestContent(
    conversationId: string,
    update: {
      readonly messageId: string;
      readonly upserts: readonly Readonly<Record<string, unknown>>[];
      readonly removes: readonly string[];
    },
  ): void;

  /** Take one usage report and the turn it belongs to. */
  ingestUsage(conversationId: string, usage: UsageSnapshot, turnRef: string | null): void;

  /** One source of the context denominator; a later call may overwrite an earlier one. */
  setContextLimit(
    conversationId: string,
    limit: number | null,
    source: ContextView["source"],
  ): void;

  /** Subscribe one selector instance; returns the unsubscribe handle. Re-subscribing an instance replaces. */
  subscribe(request: SelectRequest, emit: (result: SelectResult) => void): () => void;

  /** Run one selector once, without subscribing. */
  select(request: SelectRequest): SelectResult;

  /** Per-tab view state, isolated by instance and not shared across processes. */
  viewState(instanceId: string): ViewState | null;
  setViewState(instanceId: string, state: ViewState): void;
  releaseViewState(instanceId: string): void;

  /** The connection boundary: advance the epoch, re-emit to live subscriptions, keep the dedupe table. */
  rebase(): void;

  /** Read-only counters for diagnostics, never rendered. */
  stats(): SessionStats;
}

/**
 * Read-only, bounded, resettable diagnostic counters. Never rendered.
 */
export type SessionStats = {
  readonly revision: number;
  readonly epoch: number;
  readonly ingestCount: number;
  readonly changesApplied: number;
  readonly changesIgnored: number;
  readonly pushesSent: number;
  readonly pushesCoalesced: number;
  readonly subscriptions: number;
  readonly dedupeTurns: number;
  readonly viewStates: number;
  readonly lastPushAt: number | null;
};
