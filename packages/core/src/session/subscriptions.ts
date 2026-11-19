/**
 * The subscription table: who is watching what, and when they hear back.
 *
 * A renderer never evaluates a selector. It names one, the core runs it, and the
 * answer comes back as a control frame. Three promises make that arrangement
 * usable, and each one is a place where the easy implementation is wrong:
 *
 * 1. **A subscription answers immediately.** The first frame is the current
 *    value, sent during `subscribe` itself. Waiting for the next change would
 *    leave a freshly opened panel blank until something unrelated happened.
 * 2. **One instance is one subscription.** Subscribing the same instance id
 *    again replaces the earlier subscription: the old sink stops receiving
 *    before the new one starts. Keeping both would send every later change
 *    twice, and the page would render a stale copy over the fresh one.
 * 3. **A reconnect is answered, not ignored.** When the connection generation
 *    advances, every live subscription is re-run and its value re-sent carrying
 *    the new generation. A page drops results from an older generation, so
 *    without this a reconnect would look like a freeze.
 *
 * Two more rules live here because this table is where they can be decided:
 *
 * - **Only the watchers of what changed are told.** The assembly layer reports
 *   which entities moved, and a subscription is re-run only when its selector
 *   reads one of them. Telling every subscription would make one message
 *   re-render the whole window, which is exactly the cost this layer exists to
 *   avoid.
 * - **A conversation becoming watched empties its badge, once.** The transition
 *   from "no active view instance" to "at least one" is the only moment the
 *   unread count is cleared. Two instances arriving one after the other must not
 *   clear it twice, and an instance that merely re-reports itself is not a new
 *   arrival. That reading lives here because only this table sees view instances
 *   come and go.
 *
 * Splitting "which entities does this selector read" from "which ids moved" is
 * deliberate: a selector for one conversation's turns is not re-run by another
 * conversation's turn, and a selector that lists everything is re-run by any id
 * of that kind. Both answers are derived from the selector name and its params,
 * so a consumer cannot pick the granularity it prefers.
 *
 * Nothing here throws. The callers are socket callbacks, and a table that throws
 * would cost the session it exists to serve.
 */

import type { SelectRequest, SelectResult } from "@haruyuki/protocol";

/** Where one subscription's results go. */
export type SelectEmit = (result: SelectResult) => void;

/** The two unread-badge calls this table needs; the badge is the other module's. */
export interface UnreadBridge {
  /** Report whether a conversation now has at least one active view instance. */
  setActive(conversationId: string, active: boolean): void;
  /** Empty the badge for a conversation the reader has just entered. */
  clear(conversationId: string): void;
}

/** The nine collections a snapshot holds, as a change is reported against them. */
export const ENTITY_KINDS = [
  "agents",
  "conversations",
  "turns",
  "blocks",
  "queues",
  "subagents",
  "usage",
  "approvals",
  "devices",
] as const;

/** One of the nine entity collections. */
export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * What changed.
 *
 * Either a plain list of kinds - "something in agents moved" - or a record that
 * names the ids as well, which lets a subscription scoped to one conversation
 * stay quiet. An entry whose ids are `null` means every id of that kind; an
 * empty array means nothing of that kind moved and is ignored.
 */
export type ChangedEntities =
  readonly string[] | Readonly<Record<string, readonly string[] | null | undefined>>;

/** What one selector reads, and which request param narrows a kind to one id. */
type SelectorAffinity = {
  readonly kinds: readonly EntityKind[];
  readonly scope: Readonly<Partial<Record<EntityKind, string>>>;
};

/**
 * Which entities each selector reads.
 *
 * A selector missing from this table is treated as reading everything. That is
 * the conservative direction: a row added to the contract later is re-run on any
 * change until someone states its affinity, and a stale row here can only cost
 * frames, never a value that silently stops arriving.
 */
const SELECTOR_AFFINITY: Readonly<Record<string, SelectorAffinity>> = {
  "entity.agents": { kinds: ["agents"], scope: {} },
  "entity.agent": { kinds: ["agents"], scope: { agents: "agentId" } },
  "entity.conversations": { kinds: ["conversations"], scope: {} },
  "entity.conversation": { kinds: ["conversations"], scope: { conversations: "conversationId" } },
  "entity.turns": { kinds: ["turns"], scope: { turns: "conversationId" } },
  "entity.blocks": { kinds: ["blocks"], scope: { blocks: "turnRef" } },
  "entity.queue": { kinds: ["queues"], scope: { queues: "conversationId" } },
  "entity.subagents": { kinds: ["subagents"], scope: { subagents: "conversationId" } },
  "entity.usage": { kinds: ["usage"], scope: { usage: "conversationId" } },
  "entity.approvals": { kinds: ["approvals"], scope: { approvals: "agentId" } },
  "entity.device": { kinds: ["devices"], scope: { devices: "agentId" } },

  // A navigation row carries a conversation's own facts plus its agent's badge,
  // and the request names no single conversation, so any row of either kind is
  // enough. Narrowing it to the agent would require a relation this layer does
  // not hold.
  "view.nav": { kinds: ["agents", "conversations"], scope: {} },
  "view.conversationRow": {
    kinds: ["conversations", "turns", "approvals"],
    scope: { conversations: "conversationId", turns: "conversationId" },
  },
  "view.context": {
    kinds: ["conversations", "usage"],
    scope: { conversations: "conversationId", usage: "conversationId" },
  },
  "view.tabActivity": {
    kinds: ["conversations", "turns", "approvals"],
    scope: { conversations: "conversationId", turns: "conversationId" },
  },
  "view.subagentTree": { kinds: ["subagents"], scope: { subagents: "conversationId" } },
  "view.agentBadges": {
    kinds: ["agents", "conversations", "turns", "approvals"],
    scope: {},
  },
  "view.capabilities": { kinds: ["agents"], scope: { agents: "agentId" } },
};

/** Every kind, as the affinity of a selector nobody has described. */
const ALL_KINDS: readonly EntityKind[] = ENTITY_KINDS;

/** Read-only counters for diagnostics. Nothing here is rendered. */
export type SubscriptionStats = {
  /** Live subscriptions right now. */
  readonly subscriptions: number;
  /** Frames handed to a listener. */
  readonly pushes: number;
  /** Re-runs whose value had not moved, so no frame was sent. */
  readonly unchanged: number;
  /** Subscriptions that replaced an earlier one for the same instance. */
  readonly replaced: number;
  /** Requests this table could not use at all. */
  readonly dropped: number;
  /** Selector runs that failed; the subscription stays live. */
  readonly selectFailed: number;
  /** Listener calls that threw. */
  readonly emitFailed: number;
  /** Connection generation boundary crossings. */
  readonly rebases: number;
  /** The generation the next frame will carry. */
  readonly epoch: number;
  /** Conversations with at least one active view instance. */
  readonly watched: number;
  /**
   * Updates swallowed by a burst window because a newer one arrived for the
   * same instance inside it. Distinct from `unchanged`, which counts re-runs
   * whose value had not moved at all.
   */
  readonly coalesced: number;
};

/** What the table needs from its owner. */
export interface SubscriptionTableOptions {
  /**
   * Where a frame goes when `subscribe` names no sink of its own. The store's
   * `subscribe(request, emit)` form passes one per subscription; the table-wide
   * sink is for a caller that routes every frame through one function.
   */
  readonly emit?: SelectEmit;
  /** Run a selector once, for the current value. */
  readonly select: (request: SelectRequest) => SelectResult;
  /** The unread badge, when it is available. Absent means no badge to clear. */
  readonly unread?: UnreadBridge;
  /** The connection generation to start from. */
  readonly epoch?: number;
  /**
   * Defer a call by a number of milliseconds, handing back its canceller.
   *
   * Absent means no burst window at all: a change reaches its subscriptions the
   * moment it is reported, one frame per change. Present, the frames caused by a
   * burst on one instance are gathered into {@link PUSH_WINDOW_MS} and answered
   * with the last value only, so a producer emitting faster than a page can
   * usefully draw does not cost a frame per change.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Reading the clock, used to notice a window whose timer has not returned.
   *
   * Only consulted when {@link schedule} is given. Absent, the wall clock is
   * used.
   */
  readonly now?: () => number;
}

/**
 * How long one instance's updates are gathered before the last of them is sent.
 *
 * Chosen to sit above a display refresh and below the point where a burst looks
 * like a freeze: at 200 updates a second, one instance is answered about four
 * times a second instead of two hundred.
 */
export const PUSH_WINDOW_MS = 250;

/** One instance's open window: the newest value waiting, and its timer. */
type BurstBucket = {
  /** The entry whose newest value the window will send. */
  entry: Entry;
  /** When the window opened, on the clock the table was given. */
  readonly openedAt: number;
  /** Cancels the timer that would close this window, while one is armed. */
  cancel: (() => void) | null;
  /** Which timer owns this window; a stale one may not close it. */
  ticket: number;
};

/** The subscription table a session store keeps. */
export interface SubscriptionTable {
  /**
   * Subscribe one selector instance.
   *
   * Emits the current value before returning. A second subscription for the same
   * instance id replaces the first one, so exactly one sink hears about each
   * later change.
   *
   * @param request the instance, its selector and its params
   * @param emit where to send results; defaults to the table-wide sink
   * @returns the unsubscribe handle, which is safe to call more than once
   */
  subscribe(request: SelectRequest, emit?: SelectEmit): () => void;

  /**
   * Report entities that moved, and re-run only the subscriptions that read
   * them. A subscription whose value did not change sends nothing.
   *
   * @param changed the kinds, optionally narrowed to ids
   * @returns how many frames were sent
   */
  notify(changed: ChangedEntities): number;

  /**
   * Cross a connection boundary: every live subscription is re-run and re-sent
   * with the new generation, so a page can tell a reconnect from a freeze.
   *
   * @param epoch the generation to adopt; omitted means one past the current one
   * @returns how many frames were sent
   */
  rebaseEpoch(epoch?: number): number;

  /** The generation the next frame will carry. */
  readonly epoch: number;

  /** A copy of the counters; later changes do not alter it. */
  stats(): SubscriptionStats;
}

/** One live subscription. */
type Entry = {
  readonly instanceId: string;
  readonly request: SelectRequest;
  readonly emit: SelectEmit;
  readonly kinds: readonly EntityKind[];
  /** The id this subscription is narrowed to, per kind; absent means any id. */
  readonly scope: ReadonlyMap<EntityKind, string>;
  /** Revision of the last frame sent, or `null` while none has been. */
  lastRevision: number | null;
  /** Generation of the last frame sent, or `null` while none has been. */
  lastEpoch: number | null;
  /** The conversation this instance claims to be active on, or `null`. */
  readonly watchedConversation: string | null;
};

/** A usable non-empty string, or `null`. */
function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A readable record, or an empty one. */
function readRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

/** A generation, or `null` when the value is not one. */
function readEpoch(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * The conversation one subscription claims to be watching.
 *
 * Only a subscription that reports itself as active is a claim, and only a
 * request that names one conversation can be one: a list selector has no single
 * conversation to enter.
 *
 * @param request the subscription request
 * @returns the conversation id, or `null`
 */
function watchedConversationOf(request: SelectRequest): string | null {
  if (request.active !== true) {
    return null;
  }

  return readString(readRecord(request.params)["conversationId"]);
}

/** Whether a value names one of the nine collections. */
function isKind(value: unknown): value is EntityKind {
  return typeof value === "string" && (ENTITY_KINDS as readonly string[]).includes(value);
}

/**
 * Build a subscription table.
 *
 * @param options the selector run, the default sink and the unread badge
 */
export function createSubscriptionTable(options: SubscriptionTableOptions): SubscriptionTable {
  const select = options.select;
  const unread = options.unread;
  const defaultEmit = options.emit ?? null;

  const entries = new Map<string, Entry>();

  // Which instances are active on which conversation. A conversation is watched
  // while this set is non-empty; the badge is told when that answer flips.
  const watchers = new Map<string, Set<string>>();

  let epoch = readEpoch(options.epoch) ?? 0;

  const counts = {
    pushes: 0,
    unchanged: 0,
    replaced: 0,
    dropped: 0,
    selectFailed: 0,
    emitFailed: 0,
    rebases: 0,
    coalesced: 0,
  };

  /** Deferring a call and cancelling it, or nothing when no window is wanted. */
  const schedule = options.schedule ?? null;
  const clock = options.now ?? Date.now;

  /** How many timers have been armed, so a stale callback can tell it is stale. */
  let tickets = 0;

  /** Tell the badge whether a conversation is watched; a broken badge is not fatal. */
  const reportWatched = (conversationId: string, active: boolean): void => {
    if (unread === undefined) {
      return;
    }

    try {
      unread.setActive(conversationId, active);
    } catch {
      // A neighbour still being written must not cost the subscription.
    }
  };

  /** Empty the badge for one conversation; the same guard as above. */
  const clearBadge = (conversationId: string): void => {
    if (unread === undefined) {
      return;
    }

    try {
      unread.clear(conversationId);
    } catch {
      // Same reasoning: the reader is at the conversation either way.
    }
  };

  /** Drop one instance's claim; the conversation stops being watched when it was the last. */
  const unwatch = (instanceId: string, conversationId: string | null): void => {
    if (conversationId === null) {
      return;
    }

    const holders = watchers.get(conversationId);

    if (holders === undefined) {
      return;
    }

    holders.delete(instanceId);

    if (holders.size > 0) {
      return;
    }

    watchers.delete(conversationId);
    reportWatched(conversationId, false);
  };

  /**
   * Add one instance's claim.
   *
   * The badge is emptied only on the way from nothing to something: a second tab
   * opening on the conversation the reader is already in is not an arrival.
   */
  const watch = (instanceId: string, conversationId: string | null): void => {
    if (conversationId === null) {
      return;
    }

    const holders = watchers.get(conversationId);
    const wasWatched = holders !== undefined && holders.size > 0;

    if (holders === undefined) {
      watchers.set(conversationId, new Set([instanceId]));
    } else {
      holders.add(instanceId);
    }

    if (wasWatched) {
      return;
    }

    // Reported before the clear, so the badge knows the conversation is watched
    // by the time its count goes to zero, and any close racing this moment is
    // suppressed rather than counted.
    reportWatched(conversationId, true);
    clearBadge(conversationId);
  };

  /** The affinity a selector reads, derived once per subscription. */
  const affinityOf = (selector: string | null): SelectorAffinity => {
    if (selector === null) {
      return { kinds: ALL_KINDS, scope: {} };
    }

    return SELECTOR_AFFINITY[selector] ?? { kinds: ALL_KINDS, scope: {} };
  };

  /** Which params narrow each kind to a single id, for this request. */
  const scopeOf = (
    params: Readonly<Record<string, unknown>>,
    affinity: SelectorAffinity,
  ): ReadonlyMap<EntityKind, string> => {
    const scope = new Map<EntityKind, string>();

    for (const [kind, param] of Object.entries(affinity.scope)) {
      if (param === undefined) {
        continue;
      }

      const id = readString(params[param]);

      if (id !== null) {
        scope.set(kind as EntityKind, id);
      }
    }

    return scope;
  };

  /**
   * Run one subscription and send the answer unless it repeats the last frame.
   *
   * The generation is stamped here rather than taken from the selector run: a
   * reconnect is this table's event, and a selector has no way to know it
   * happened.
   */
  const push = (entry: Entry): boolean => {
    let produced: unknown;

    try {
      produced = select(entry.request);
    } catch {
      counts.selectFailed += 1;

      return false;
    }

    if (typeof produced !== "object" || produced === null) {
      counts.selectFailed += 1;

      return false;
    }

    const result = produced as SelectResult;
    const revision = readEpoch(result.revision) ?? 0;

    if (entry.lastRevision === revision && entry.lastEpoch === epoch) {
      counts.unchanged += 1;

      return false;
    }

    const frame: SelectResult = {
      selector: entry.request.selector,
      params: entry.request.params,
      revision,
      epoch,
      value: result.value,
    };

    entry.lastRevision = revision;
    entry.lastEpoch = epoch;

    try {
      entry.emit(frame);
    } catch {
      counts.emitFailed += 1;

      // The value was produced, so the frame counts as attempted; the listener
      // is a page handler and its failure is not this table's to escalate.
    }

    counts.pushes += 1;

    return true;
  };

  /**
   * Instances with a window open, oldest window first.
   *
   * One instance is one bucket: a second report inside the same window replaces
   * the entry the bucket will answer for, so the window sends the newest value
   * and never a queue of stale ones.
   */
  const pending = new Map<string, BurstBucket>();

  /** Cancel one bucket's timer and forget it; the caller decides who hears what. */
  const closeBucket = (bucket: BurstBucket): void => {
    const cancel = bucket.cancel;

    bucket.cancel = null;

    if (cancel === null) {
      return;
    }

    try {
      cancel();
    } catch {
      // A canceller that throws leaves its callback to notice the stale ticket,
      // which is why the ticket exists rather than trusting the cancellation.
    }
  };

  /** Send the newest value one window gathered, unless a newer window owns it. */
  const expire = (instanceId: string, ticket: number): void => {
    const bucket = pending.get(instanceId);

    if (bucket === undefined || bucket.ticket !== ticket) {
      return;
    }

    bucket.cancel = null;

    // A timer may return before its window has actually run out - a coarse or
    // impatient scheduler. Sending then would answer twice inside one window,
    // so the window is re-armed for the time it has left instead.
    const remaining = PUSH_WINDOW_MS - (clock() - bucket.openedAt);

    if (remaining > 0) {
      const next = ticket + 1;

      tickets = next;
      bucket.ticket = next;
      bucket.cancel =
        schedule?.(() => {
          expire(instanceId, next);
        }, remaining) ?? null;

      return;
    }

    pending.delete(instanceId);
    push(bucket.entry);
  };

  /** Close every open window without sending what it gathered. */
  const discardPending = (): void => {
    for (const [instanceId, bucket] of pending) {
      pending.delete(instanceId);
      closeBucket(bucket);
    }
  };

  /**
   * Ask for one entry to be answered, through a window when one is wanted.
   *
   * With no window this is `push`, unchanged: a change is one frame. With a
   * window, the first report opens it and every later report for the same
   * instance folds into the one frame it will send.
   */
  const requestPush = (entry: Entry): boolean => {
    if (schedule === null) {
      return push(entry);
    }

    const open = pending.get(entry.instanceId);

    if (open !== undefined) {
      // Folding a report into a window that has not sent yet: the value this
      // report replaced will never be drawn, which is the cost the window buys
      // its lower frame rate with. The newest value is the one worth sending.
      counts.coalesced += 1;
      open.entry = entry;

      return true;
    }

    const ticket = tickets + 1;

    tickets = ticket;

    const bucket: BurstBucket = {
      entry,
      openedAt: clock(),
      cancel: null,
      ticket,
    };

    pending.set(entry.instanceId, bucket);

    bucket.cancel = schedule(() => {
      expire(entry.instanceId, ticket);
    }, PUSH_WINDOW_MS);

    return true;
  };

  /** Drop one instance's open window, without sending it. */
  const abandon = (instanceId: string): void => {
    const bucket = pending.get(instanceId);

    if (bucket === undefined) {
      return;
    }

    pending.delete(instanceId);
    closeBucket(bucket);
  };

  /**
   * Whether a subscription reads any of the entities that moved.
   *
   * A kind with no ids means "somewhere in this kind", which reaches every
   * subscription reading it. A kind with ids reaches a subscription narrowed to
   * one of them, and always reaches a subscription narrowed to nothing - a
   * selector that lists a whole collection cannot be told which of its rows the
   * caller cares about.
   */
  const affected = (
    entry: Entry,
    changed: ReadonlyMap<EntityKind, readonly string[] | null>,
  ): boolean => {
    for (const kind of entry.kinds) {
      if (!changed.has(kind)) {
        continue;
      }

      const ids = changed.get(kind);
      const scope = entry.scope.get(kind);

      if (ids === null || ids === undefined || scope === undefined) {
        return true;
      }

      if (ids.includes(scope)) {
        return true;
      }
    }

    return false;
  };

  /** Read a change report into kinds, and the ids that moved within each. */
  const readChanged = (changed: ChangedEntities): Map<EntityKind, readonly string[] | null> => {
    const result = new Map<EntityKind, readonly string[] | null>();

    if (Array.isArray(changed)) {
      for (const kind of changed) {
        if (isKind(kind)) {
          // An unnamed id list: every id of this kind counts as moved.
          result.set(kind, null);
        }
      }

      return result;
    }

    for (const [kind, ids] of Object.entries(readRecord(changed))) {
      if (!isKind(kind)) {
        continue;
      }

      if (ids === null || ids === undefined) {
        result.set(kind, null);

        continue;
      }

      if (!Array.isArray(ids)) {
        // An unreadable id list is loosened, not tightened: dropping the entry
        // would leave a subscription showing a value nobody updates.
        result.set(kind, null);

        continue;
      }

      const usable = ids.filter((id): id is string => typeof id === "string" && id !== "");

      if (usable.length === 0) {
        // Nothing of this kind moved; naming the kind anyway is not a change.
        continue;
      }

      result.set(kind, usable);
    }

    return result;
  };

  return {
    subscribe(request, emit) {
      const seen = readString(request.instanceId);

      if (seen === null) {
        counts.dropped += 1;

        return () => {};
      }

      const sink: SelectEmit | null = emit ?? defaultEmit;

      if (sink === null) {
        counts.dropped += 1;

        return () => {};
      }

      const selector = readString(request.selector);

      // A request that names no selector has nothing to run, so there is no
      // value to send and nothing worth keeping. Refused like a missing
      // instance, rather than filed under an empty name.
      if (selector === null) {
        counts.dropped += 1;

        return () => {};
      }

      const params = readRecord(request.params);
      const affinity = affinityOf(selector);
      const nextConversation = watchedConversationOf(request);
      const previous = entries.get(seen);
      const previousConversation = previous?.watchedConversation ?? null;

      if (previous !== undefined) {
        entries.delete(seen);
        counts.replaced += 1;

        // A window opened for the subscription being replaced would send its
        // entry to the retired sink; the replacement sends its own first frame.
        abandon(seen);
      }

      // A replacement that keeps the same conversation and the same claim is not
      // an arrival or a departure: the instance was already counted there.
      if (previousConversation !== nextConversation) {
        unwatch(seen, previousConversation);
        watch(seen, nextConversation);
      }

      const entry: Entry = {
        instanceId: seen,
        request,
        emit: sink,
        kinds: affinity.kinds,
        scope: scopeOf(params, affinity),
        lastRevision: null,
        lastEpoch: null,
        watchedConversation: nextConversation,
      };

      entries.set(seen, entry);

      // The very first frame, sent before `subscribe` returns. Waiting for a
      // change would leave a page that just mounted showing nothing, and a
      // window would leave it showing nothing for a quarter of a second.
      push(entry);

      let released = false;

      return () => {
        if (released) {
          return;
        }

        released = true;

        const current = entries.get(seen);

        // Identity, not the instance id: the handle of a replaced subscription
        // must not remove the entry that replaced it. Releasing the handle the
        // caller still holds is a no-op, which is what "already unsubscribed"
        // has to mean for a page that unmounts a tab twice.
        if (current !== entry) {
          return;
        }

        entries.delete(seen);
        abandon(seen);
        unwatch(seen, current.watchedConversation);
      };
    },

    notify(changed) {
      const moved = readChanged(changed);

      if (moved.size === 0) {
        return 0;
      }

      let sent = 0;

      for (const entry of entries.values()) {
        if (!affected(entry, moved)) {
          continue;
        }

        if (requestPush(entry)) {
          sent += 1;
        }
      }

      return sent;
    },

    rebaseEpoch(next) {
      const wanted = readEpoch(next);

      // A reconnect is not a burst. Whatever a window had gathered is dropped
      // rather than sent: the loop below re-answers every live subscription from
      // the value it holds now, so sending the gathered value first would send
      // the same frame twice, the first of them carrying a generation the page
      // has already stopped waiting for.
      discardPending();

      epoch = wanted ?? epoch + 1;
      counts.rebases += 1;

      let sent = 0;

      // Every live subscription, whatever entity moved: a page has to be able to
      // tell a reconnect from a freeze, and only a re-sent value can say so.
      for (const entry of entries.values()) {
        if (push(entry)) {
          sent += 1;
        }
      }

      return sent;
    },

    get epoch() {
      return epoch;
    },

    stats() {
      return {
        subscriptions: entries.size,
        pushes: counts.pushes,
        unchanged: counts.unchanged,
        replaced: counts.replaced,
        dropped: counts.dropped,
        selectFailed: counts.selectFailed,
        emitFailed: counts.emitFailed,
        rebases: counts.rebases,
        epoch,
        watched: watchers.size,
        coalesced: counts.coalesced,
      };
    },
  };
}
