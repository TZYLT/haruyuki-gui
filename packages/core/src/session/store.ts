/**
 * The session store: the assembly of the folds below it, and the members the
 * renderer contract names.
 *
 * Nothing here is a new rule. Every value this module publishes is produced by
 * one of the modules it joins. What the store owns is what none of them can own
 * alone:
 *
 * 1. **Where one change goes.** A merged change is one frame that several folds
 *    read: a message moves a turn, may create a block, may put a row in a queue
 *    and may complete an approval. The dispatch order below answers it once, so
 *    no fold has to know another.
 * 2. **What a revision means.** A snapshot is republished only when something
 *    visible moved, so a replayed or empty change costs no frame. The revision
 *    states what is published, not how many frames arrived - that difference is
 *    what keeps a busy engine from re-rendering at event rate.
 * 3. **The two seams between neighbours.** A turn's close is the only moment the
 *    unread badge may count; a loop state travels on its own change kind and only
 *    the device projector can hold it. Both are collaborations the parts name in
 *    their own documentation and leave to whoever builds them.
 *
 * Nothing throws (everything enters from a socket callback) and every table that
 * grows with traffic is bounded: neither a reconnect nor a long session may grow
 * one without limit.
 */

import type {
  ContextView,
  DeviceEntity,
  SelectRequest,
  SelectResult,
  SessionSnapshot,
  SessionStats,
  SessionStore,
  UsageEntity,
  ViewState,
} from "@haruyuki/protocol";
import { SESSION_UNKNOWN_SELECTOR } from "@haruyuki/protocol";

import { asRecord } from "../merge/envelope.js";
import type { MergerChange } from "../merge/types.js";
import { createApprovalTable } from "./approvals.js";
import { createBlockTable } from "./blocks.js";
import { deriveContextView } from "./context.js";
import { createDeviceProjector } from "./device.js";
import { createAgentTable, createConversationTable } from "./entities.js";
import { createQueueTable, createSubagentTable } from "./queue.js";
import { createEntitySelectors } from "./selectors/entity.js";
import { createViewSelectors } from "./selectors/view.js";
import { createSnapshotBuilder, type SnapshotBuilder, type SnapshotMapField } from "./snapshot.js";
import { createDedupeTable, fingerprintOf } from "./store-dedupe.js";
import { createPublisher } from "./store-publish.js";
import {
  LIMIT_LAYER,
  NO_LIMITS,
  loopStatusOf,
  readText,
  readTime,
  USAGE_HISTORY_LIMIT,
  type ContextLimits,
  type SelectorOutcome,
  type SessionSelection,
  type SessionStoreDeps,
} from "./store-types.js";
import { createSubscriptionTable } from "./subscriptions.js";
import { createTurnTable } from "./turns.js";
import { createUnreadCounter, type UnreadCounter } from "./unread.js";
import { createViewStateStore } from "./view-state.js";

// Every name this module always exported is still exported from here, so a
// consumer keeps one import path. The vocabulary they name lives one file down.
export {
  DEDUPE_TURN_LIMIT,
  USAGE_HISTORY_LIMIT,
  type SessionSelection,
  type SessionStoreDeps,
} from "./store-types.js";

/**
 * Build one session store. The returned object satisfies the renderer contract
 * member by member; the folds behind it are the ones this package ships.
 */
export function createSessionStore(deps: SessionStoreDeps = {}): SessionStore {
  const onView = deps.onView;

  const builder: SnapshotBuilder = createSnapshotBuilder();

  const agents = createAgentTable();
  const conversations = createConversationTable({ agents });
  const turns = createTurnTable();
  const blocks = createBlockTable({ turns });
  const queues = createQueueTable();
  const subagents = createSubagentTable();
  const approvals = createApprovalTable();
  const device = createDeviceProjector();

  const unread: UnreadCounter = createUnreadCounter({
    // The badge's second half belongs to the approval table, which is the only
    // place one request reported by three paths is merged. Asked per conversation.
    countApprovals: (conversationId) =>
      approvals.pending().filter((row) => row.conversationId === conversationId).length,
  });

  const viewStates = createViewStateStore();

  /** The maps this store composes itself, because no fold publishes them. */
  const usageEntities = new Map<string, UsageEntity>();
  const contextViews = new Map<string, ContextView>();
  const contextLimits = new Map<string, ContextLimits>();
  const devices = new Map<string, DeviceEntity>();
  /**
   * Which conversations hold a subagent list: the subagent table answers by
   * conversation, so the map keys are kept here; a keys() accessor there would
   * let this go. A known seam, not an oversight.
   */
  const subagentKeys = new Set<string>();

  /** Which snapshot fields the next publication carries. */
  const dirty = new Set<SnapshotMapField>();

  const counts = {
    ingests: 0,
    applied: 0,
    ignored: 0,
    coalesced: 0,
    lastPushAt: null as number | null,
  };

  /** Mark the fields a change touched. */
  const markDirty = (...fields: SnapshotMapField[]): void => {
    for (const field of fields) {
      dirty.add(field);
    }
  };

  // The suppression table: a replayed frame must not be folded twice. The table
  // itself, with the bound that keeps it finite, lives in store-dedupe.ts.
  const dedupe = createDedupeTable();
  const { isDuplicate } = dedupe;

  /** The limits one conversation has been given, in the contract's layer order. */
  const candidatesOf = (conversationId: string): ContextLimits =>
    contextLimits.get(conversationId) ?? NO_LIMITS;

  /** Recompute a conversation's pressure from its latest report and its layers. */
  const refreshContext = (conversationId: string): void => {
    const latest = usageEntities.get(conversationId)?.latest ?? null;
    const limits = candidatesOf(conversationId);
    const named =
      limits.conversationOverride !== null ||
      limits.agentConfig !== null ||
      limits.modelCatalog !== null;

    if (latest === null && !named) {
      contextViews.delete(conversationId);

      return;
    }

    contextViews.set(conversationId, deriveContextView(latest, limits));
  };

  /**
   * File one usage report: the latest, plus a bounded trail keyed by turn and
   * arrival time, so a replayed report replaces its own entry.
   */
  const recordUsage = (
    conversationId: string,
    usage: Readonly<Record<string, unknown>>,
    turnRef: string | null,
    at: number,
  ): void => {
    const previous = usageEntities.get(conversationId);
    const entry = { turnRef: turnRef ?? "", at, usage };
    const trail = (previous?.history ?? []).filter(
      (held) => held.turnRef !== entry.turnRef || held.at !== entry.at,
    );
    const history = [...trail, entry].slice(-USAGE_HISTORY_LIMIT);

    usageEntities.set(
      conversationId,
      Object.freeze({
        conversationId,
        latest: usage,
        history: Object.freeze(history.map((held) => Object.freeze(held))),
      }),
    );

    refreshContext(conversationId);
  };

  /**
   * Feed one change to every fold that reads it. The order is not arbitrary: the
   * turn table sees a message before the block and queue folds can attribute
   * anything to it, and the badge reads the record only once it is closed.
   */
  const foldChange = (change: MergerChange): void => {
    const record = change as unknown as Readonly<Record<string, unknown>>;
    const conversationId = readText(record["conversationId"]);
    const kind = readText(record["kind"]);
    const at = readTime(record["at"]) ?? 0;

    // The turn table decides what this change is for the two folds that ask it;
    // every other fold refuses what it does not read, so all of them are fed.
    const signal = turns.ingest(change);

    if (signal.effect !== "ignored") {
      markDirty("turns");
    }

    if (signal.effect === "closed" && signal.turnRef !== null) {
      const closed = turns.get(signal.turnRef);

      // The count is asked of the closed record, not of the terminal frame: the
      // engine closes a turn with `end_turn` and may lose `turn.finished`, and
      // the badge counts closed turns. The badge decides which line counts.
      if (closed !== null) {
        unread.observe(closed);
      }
    }

    if (kind === "state.loop") {
      // The loop state is not in the device payload, so it is handed to the
      // projector that owns the row. Its eight statuses travel verbatim.
      const loop = loopStatusOf(record["value"]);

      if (loop !== null) {
        device.setLoop(loop);
      }
    }

    const reading = device.apply(change);

    if (reading.entity !== null) {
      devices.set(reading.entity.agentId, reading.entity);
      markDirty("devices");
    }

    if (queues.apply(change).effect === "applied") {
      markDirty("queues");
    }

    const runs = subagents.apply(change);

    if (runs.effect === "applied" && runs.conversationId !== null) {
      subagentKeys.add(runs.conversationId);
      markDirty("subagents");
    }

    if (approvals.ingest(change).effect !== "ignored") {
      markDirty("approvals");
    }

    if (conversations.apply(change).effect !== "ignored") {
      markDirty("conversations");
    }

    if (kind === "usage.reported" && conversationId !== null) {
      const reported = asRecord(record["usage"]);

      if (reported !== null) {
        recordUsage(conversationId, reported, signal.turnRef, at);
        markDirty("usage", "conversations");
      }
    }
  };

  /** The entity table, read over the snapshot this store publishes. */
  const entitySelectors = createEntitySelectors({
    snapshot: () => builder.get(),
  });

  /** The view table, with the values whose owners live outside the snapshot. */
  const viewSelectors = createViewSelectors({
    snapshot: () => builder.get(),
    badgeOf: (conversationId) => unread.badgeOf(conversationId),
    conversationStateOf: (conversationId) => conversations.stateOf(conversationId),
  });

  /**
   * Run one selector through both tables, entity first. Only "nobody implements
   * that name" moves on to the second: a bad request shape or an offline source
   * is the same answer from either table, and running the other one would only
   * buy a second refusal.
   */
  const runSelector = (
    selector: string,
    params: Readonly<Record<string, unknown>>,
  ): SelectorOutcome => {
    const entity = entitySelectors.run(selector, params);

    if (entity.ok) {
      return { ok: true, value: entity.value };
    }

    if (entity.code !== SESSION_UNKNOWN_SELECTOR) {
      return { ok: false, code: entity.code };
    }

    const view = viewSelectors.run(selector, params);

    return view.ok ? { ok: true, value: view.value } : { ok: false, code: view.code };
  };

  /**
   * One selector answer stamped with the revision and generation it was read at.
   *
   * `code` is present only when the run failed; on a success it is `undefined`
   * and the caller reads nothing into it. The page maps a code to its own
   * wording, so a refusal is still an answer rather than a thrown error.
   */
  const select = (request: SelectRequest): SessionSelection => {
    const selector = readText(request?.selector) ?? "";
    const params = asRecord(request?.params) ?? {};
    let outcome: SelectorOutcome;

    try {
      outcome = runSelector(selector, params);
    } catch {
      // Both tables answer without throwing; this keeps a hostile request from
      // costing the caller its frame.
      outcome = { ok: false, code: SESSION_UNKNOWN_SELECTOR };
    }

    const result: SelectResult = Object.freeze({
      selector,
      params,
      revision: builder.revision,
      epoch: subscriptions.epoch,
      value: outcome.ok ? outcome.value : null,
    });

    return outcome.ok ? result : Object.freeze({ ...result, code: outcome.code });
  };

  const subscriptions = createSubscriptionTable({
    select,
    // The subscription table is the only place that sees view instances come and
    // go, so it is the one that reports a conversation becoming watched, and
    // therefore empties the badge at that moment.
    unread: {
      setActive: (conversationId, active) => unread.setActive(conversationId, active),
      clear: (conversationId) => unread.clear(conversationId),
    },
  });

  // The publication half: the caches it holds are what make a row nobody touched
  // stay the same object, which is what a revision is allowed to mean anything by.
  const { publish } = createPublisher({
    builder,
    dirty,
    turns,
    blocks,
    conversations,
    agents,
    queues,
    subagents,
    approvals,
    usageEntities,
    devices,
    subagentKeys,
    contextViews,
    subscriptions,
    counts,
  });

  const store: SessionStore = {
    getSnapshot(): SessionSnapshot {
      return builder.get();
    },

    ingest(change: MergerChange): boolean {
      counts.ingests += 1;

      let key: string | null;

      try {
        const record = asRecord(change);

        key = record === null ? null : fingerprintOf(record);
      } catch {
        // A payload can be a proxy or a throwing getter; reading it is the one
        // step a hostile change could still fail at.
        key = null;
      }

      if (key === null) {
        counts.ignored += 1;

        return false;
      }

      // A replayed frame must not be folded twice: the folds allocate new turn
      // refs and would count the same turn again, so the answer is given here,
      // before any of them sees it.
      if (isDuplicate(key)) {
        counts.ignored += 1;

        return false;
      }

      try {
        foldChange(change);
      } catch {
        // Every fold answers without throwing; this guards the session against
        // one unexpected payload. The change is remembered above, so it cannot be
        // folded a second time either.
        counts.ignored += 1;

        return false;
      }

      const moved = publish();

      // A partition of `ingestCount`: a change either moved the published state or
      // it did not. A third bucket would be one nobody could name.
      counts[moved ? "applied" : "ignored"] += 1;

      return moved;
    },

    ingestAgents(rows) {
      try {
        agents.ingest(rows);
        markDirty("agents", "conversations");
        publish();
      } catch {
        // A page that hands in an unreadable list costs the store nothing.
      }
    },

    ingestConversations(rows, opts) {
      try {
        conversations.ingest(rows, opts);
        // Direction matters: a conversation page arriving may move an agent's
        // conversation list, because the row names its agent. The reverse does
        // not hold - an agent row carries no conversation list - so this marks
        // agents dirty and an agent page never marks conversations.
        markDirty("conversations", "agents");
        publish();
      } catch {
        // Same standing as the agent page.
      }
    },

    ingestContent(conversationId, update) {
      try {
        // The turn table keeps the block ids of the turn the message belongs to;
        // the block table keeps the blocks. Two owners, two calls.
        if (turns.ingestContent(conversationId, update).effect !== "ignored") {
          markDirty("turns");
        }

        blocks.ingestContent(conversationId, update);
        markDirty("blocks");
        publish();
      } catch {
        // A malformed update costs the frames it carried, not the session.
      }
    },

    ingestUsage(conversationId, usage, turnRef) {
      try {
        const id = readText(conversationId);

        if (id === null) {
          return;
        }

        recordUsage(id, usage, turnRef, Date.now());
        markDirty("usage", "conversations");
        publish();
      } catch {
        // Same standing.
      }
    },

    setContextLimit(conversationId, limit, source) {
      try {
        const id = readText(conversationId);

        if (id === null) {
          return;
        }

        const current = candidatesOf(id);
        const value =
          typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : null;

        // A later call overwrites an earlier one: the three layers are three
        // answers to one question, and the newest answer for a layer wins. A
        // source this layer does not know clears all three rather than guessing.
        const chosen = LIMIT_LAYER[source];
        const next: ContextLimits =
          chosen === undefined ? NO_LIMITS : { ...current, [chosen]: value };

        contextLimits.set(id, next);
        refreshContext(id);
        markDirty("conversations");
        publish();
      } catch {
        // Same standing.
      }
    },

    subscribe(request, emit) {
      return subscriptions.subscribe(request, (result) => {
        counts.lastPushAt = Date.now();

        try {
          emit(result);
        } finally {
          // The shell's own sink is told too, so a shell routing every frame
          // through one function need not pass a sink per call.
          onView?.({ ...result, instanceId: request.instanceId });
        }
      });
    },

    select,

    viewState(instanceId): ViewState | null {
      return viewStates.get(instanceId);
    },

    setViewState(instanceId, state) {
      viewStates.set(instanceId, state);
    },

    releaseViewState(instanceId) {
      viewStates.release(instanceId);
    },

    rebase() {
      try {
        // Crossing a connection boundary: the generation advances and every live
        // subscription is answered again carrying it, so a page can tell a
        // reconnect from a freeze. The snapshot crosses first, so the frames sent
        // below already carry the revision they would read. The suppression table
        // is deliberately kept - the tail of the stream is about to be re-sent.
        const next = subscriptions.epoch + 1;

        builder.next({ epoch: next });
        subscriptions.rebaseEpoch(next);
      } catch {
        // A rebase that cannot run leaves the store exactly as it was.
      }
    },

    stats(): SessionStats {
      const pushed = subscriptions.stats();

      return Object.freeze({
        revision: builder.revision,
        epoch: subscriptions.epoch,
        ingestCount: counts.ingests,
        changesApplied: counts.applied,
        changesIgnored: counts.ignored,
        pushesSent: pushed.pushes,
        // Frames this layer did not send because nothing the subscription reads
        // had moved, plus the live subscriptions a publication did not have to
        // answer at all. This is where a burst is absorbed, and the honest name
        // for it is the number of pushes that would have been sent without the
        // structure-sharing snapshot underneath.
        pushesCoalesced: pushed.unchanged + counts.coalesced,
        subscriptions: pushed.subscriptions,
        dedupeTurns: dedupe.size,
        viewStates: viewStates.size,
        lastPushAt: counts.lastPushAt,
      });
    },
  };

  return store;
}
