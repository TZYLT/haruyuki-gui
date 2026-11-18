/**
 * The approval table: one row per request id, however many paths report that
 * request, and every row's state kept.
 *
 * A single approval reaches this layer more than once, and every arrival is a
 * real frame from the engine rather than a duplicate the transport let through:
 *
 * 1. **The decision request itself** - an `approval.requested` change, carrying
 *    its own `requestId` and the request body. Live, ordered, and gone from the
 *    stream once a person answers.
 * 2. **The device snapshot** - `state.device` carries `pending_control_requests`,
 *    the engine's own list of what is waiting. It is a whole snapshot, not a
 *    delta, so it can only ever say what is waiting now.
 * 3. **A replay after a resync** - reconnecting asks the engine to replay the
 *    approvals that are still waiting, and those arrive as `approval.requested`
 *    changes again, with the same request ids and fresh sequence numbers. The
 *    reconnect layer's own answer - the ids it found still waiting - arrives
 *    through {@link ApprovalTable.applyReplay}, which is the authoritative form
 *    of that pass; a resync reply that names the list is applied too when the
 *    engine sends one.
 *
 * Keying on the request id is what makes the badge honest: appended per arrival,
 * one waiting request counts two or three times, which is the exact defect this
 * module exists to prevent. The id is therefore the only key, and every path
 * writes into the same row.
 *
 * ## The row records its state, the badge counts only what waits
 *
 * The contract's entity carries three states, so a row outlives its wait and
 * says how it ended:
 *
 * - **`pending`** - the request is waiting for a person. Only these count.
 * - **`decided`** - a person answered it. The answer is sent by this side, so
 *   the caller tells this table; no frame reports a decision.
 * - **`expired`** - the request stopped waiting without this side answering it:
 *   the device snapshot stopped listing it, or a replay pass no longer reported
 *   it. The engine never says why - it may have timed out, or been answered on
 *   another surface - so this is the only honest name for an absence.
 *
 * A decision is final. The same request id showing up again - the engine has not
 * caught up, or the pass is replayed twice - never turns a resolved row back into
 * a waiting one, because an id is decided once. Keeping the row rather than
 * deleting it is what makes the state readable at all; a table that filed only
 * waiters would implement two of the three states as constants.
 *
 * ## Two rules for the rest
 *
 * - **Nothing throws, and nothing is invented.** A change with no usable
 *   `request_id` has no key and is counted, then skipped - filing it under a
 *   made-up key would make every arrival a new approval. A payload shape this
 *   module cannot read is counted and skipped, and never resolves rows that are
 *   already there: "the engine did not say" is not "nothing is waiting".
 * - **The table is bounded on both halves, and waiting rows go last.** Resolved
 *   rows accumulate for the life of the process, so they have their own bound and
 *   their own eviction order; a waiting approval is never evicted to make room
 *   for a finished one. Every eviction is counted, so a lost resolution shows up
 *   in a diagnostic reading instead of staying invisible.
 */

import type { ApprovalEntity } from "@haruyuki/protocol";

import { asRecord, readString } from "../merge/envelope.js";
import type { MergerChange } from "../merge/types.js";

/** How many waiting rows are kept when the caller names no bound. */
export const APPROVAL_TABLE_LIMIT = 512;

/** How many finished rows are kept when the caller names no bound. */
export const APPROVAL_RESOLVED_LIMIT = 512;

/** Which path an arrival came in on. */
export type ApprovalPath = "control-request" | "device-snapshot" | "replay";

/** How an approval stopped waiting. */
export type ApprovalVerdict = "decided" | "expired";

/** What one arrival did to the table. */
export type ApprovalEffect = {
  /** The path the arrival came in on; `null` when the change was not about approvals. */
  readonly path: ApprovalPath | null;
  /**
   * `added` first sighting, `refreshed` an existing waiting row updated,
   * `resolved` at least one row stopped waiting, `noted` an arrival that named
   * nothing to reconcile, `ignored` a change this module does not read.
   */
  readonly effect: "added" | "refreshed" | "resolved" | "noted" | "ignored";
  /** The request ids this arrival touched, in the order it named them. */
  readonly requestIds: readonly string[];
};

/**
 * Read-only counters for diagnostics. Nothing here is rendered.
 *
 * `missingId`, `missingList` and `unreadable` are kept apart on purpose: an
 * approval the engine forgot to key, a payload that names no pending list at
 * all, and a payload this module could not read are three different repairs, and
 * rolling them together would make the diagnostic say less than the reading
 * already knows.
 */
export type ApprovalStats = {
  /** Rows that are waiting right now; the badge reads this one. */
  readonly pending: number;
  /** Rows a person answered. */
  readonly decided: number;
  /** Rows that stopped waiting without this side answering them. */
  readonly expired: number;
  /** Rows created at their first sighting. */
  readonly added: number;
  /** Arrivals that updated a waiting row that already existed, on any path. */
  readonly refreshed: number;
  /** Device snapshots applied. */
  readonly deviceSnapshots: number;
  /** Replay passes with a list to reconcile. */
  readonly replayPasses: number;
  /** Rows a replay pass found no longer waiting. */
  readonly replayResolved: number;
  /** Arrivals with no usable `request_id`; counted, then skipped. */
  readonly missingId: number;
  /** Arrivals that named no pending list at all; counted, then skipped. */
  readonly missingList: number;
  /** Arrivals whose payload could not be read at all; counted, then skipped. */
  readonly unreadable: number;
  /** Waiting rows dropped to stay inside the bound. */
  readonly evictedPending: number;
  /** Finished rows dropped to stay inside their own bound. */
  readonly evictedResolved: number;
};

/**
 * The descriptive facts one arrival carries.
 *
 * `toolName` is a string rather than a nullable field because the contract's
 * entity declares it non-nullable; an empty string is this layer's way of saying
 * the payload named no tool, and it is not a tool called "".
 */
type ApprovalFacts = {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly agentId: string;
  readonly conversationId: string;
  readonly requestedAt: number;
};

/** The table a session store keeps for its approvals. */
export interface ApprovalTable {
  /**
   * Take one merged change. Synchronous, never throws, and routes it to the path
   * its kind belongs to.
   */
  ingest(change: MergerChange): ApprovalEffect;
  /**
   * Apply a replay pass: the ids a resync reported as still waiting.
   *
   * This is the authoritative form of a pass: the reconnect layer is where the
   * engine's answer is read, so it hands the list over here rather than making
   * this table wait for a frame that may never carry one. The list is complete
   * for the scope it names, so a waiting row it omits stopped waiting; an empty
   * list is therefore a real answer ("nothing is waiting"), which is why a replay
   * marker with no list is not treated as one.
   *
   * @param requestIds the ids the pass reported, as ids or as whole bodies
   * @param agentId the agent the pass speaks for; `null` or omitted means every row
   */
  applyReplay(requestIds: readonly unknown[], agentId?: string | null): ApprovalEffect;
  /**
   * Record that a person answered one request.
   *
   * The answer is sent by this side, so nothing in the incoming stream reports
   * it; the caller that sent it says so here. Idempotent per id: recording the
   * same answer twice changes nothing, and an unknown id is a no-op rather than
   * an invented row.
   *
   * @param requestId the request that was answered
   * @param verdict how it ended; `decided` by default
   * @returns whether a waiting row was resolved by this call
   */
  resolve(requestId: string, verdict?: ApprovalVerdict): boolean;
  /** One row by its request id, whatever its state, or `null` when a stranger. */
  get(requestId: string): ApprovalEntity | null;
  /** Every waiting row, or one agent's, in the order the requests first appeared. */
  pending(agentId?: string): readonly ApprovalEntity[];
  /** Every finished row, newest resolution last, or one agent's. */
  resolved(agentId?: string): readonly ApprovalEntity[];
  /** How many requests are waiting; one agent's, or all of them. */
  pendingCount(agentId?: string): number;
  /** Rows held, waiting and finished together. */
  readonly size: number;
  /** A copy of the counters; later changes do not alter it. */
  stats(): ApprovalStats;
}

/** A finite arrival time, or `null`. */
function readTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a `request_id` off a record, under either of the two names a producer
 * uses: a wire frame spells it `request_id`, while a caller that already unwrapped
 * a body may hand over `requestId`.
 *
 * @param record the entry to read
 * @returns the id, or `null` when the entry names none
 */
function requestIdOf(record: Record<string, unknown>): string | null {
  return readString(record["request_id"]) ?? readString(record["requestId"]);
}

/**
 * The request body out of one entry.
 *
 * A device snapshot nests the body one level down as each entry's `request`, and
 * a `control_request` frame does the same, so every path reads one shape here.
 *
 * @param record the entry to read
 * @returns the tool and input, an empty string and an empty object when unnamed
 */
function factsOf(record: Record<string, unknown>): {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
} {
  const request = asRecord(record["request"]);

  return {
    toolName: readString(request?.["tool_name"]) ?? "",
    input: Object.freeze(asRecord(request?.["input"]) ?? {}),
  };
}

/**
 * Which agent and conversation an arrival belongs to.
 *
 * The entry's own fields win, then the envelope the merge layer resolved, then
 * the entry's nested `runtime`. An empty string is this layer's spelling of "no
 * identity was named" - the contract declares both non-nullable - so it is
 * skipped rather than used as an id.
 *
 * @param record the entry to read
 * @param change the change it arrived on
 * @returns the two ids, empty when nothing named them
 */
function identityOf(
  record: Record<string, unknown>,
  change: MergerChange,
): { agentId: string; conversationId: string } {
  const runtime = asRecord(record["runtime"]);

  const agentId =
    readString(record["agent_id"]) ??
    readString(runtime?.["agent_id"]) ??
    (change.authorAgentId !== null && change.authorAgentId !== "" ? change.authorAgentId : null) ??
    (change.runtimeAgentId !== "" ? change.runtimeAgentId : null) ??
    "";

  const conversationId =
    readString(record["conversation_id"]) ??
    readString(runtime?.["conversation_id"]) ??
    change.conversationId;

  return { agentId, conversationId };
}

/**
 * The entity one row publishes; frozen so a reader cannot edit published state.
 *
 * @param requestId the row's key
 * @param facts what the row says about the request
 * @param state how the request ended, or that it has not
 */
function entityOf(
  requestId: string,
  facts: ApprovalFacts,
  state: ApprovalEntity["state"],
): ApprovalEntity {
  return Object.freeze({
    requestId,
    agentId: facts.agentId,
    conversationId: facts.conversationId,
    toolName: facts.toolName,
    input: facts.input,
    state,
    requestedAt: facts.requestedAt,
  });
}

/** A bound that a caller may pass: a positive integer, or the default. */
function readBound(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Build an approval table.
 *
 * @param options bounds for the waiting rows and for the finished ones; a value
 *   that is not a positive integer is corrected to its own default rather than
 *   carried into every write
 */
export function createApprovalTable(
  options: { readonly limit?: number; readonly resolvedLimit?: number } = {},
): ApprovalTable {
  const pendingBound = readBound(options.limit, APPROVAL_TABLE_LIMIT);
  const resolvedBound = readBound(options.resolvedLimit, APPROVAL_RESOLVED_LIMIT);

  /**
   * Waiting rows by request id, in the order the requests first appeared.
   *
   * Two maps rather than one with a state field, because the two halves need
   * different eviction orders and a lookup almost always wants a waiter: `get`
   * checks this one first, and `pending()` is a plain iteration.
   */
  const waiting = new Map<string, ApprovalEntity>();

  /** Finished rows by request id, in the order they were resolved. */
  const finished = new Map<string, ApprovalEntity>();

  /**
   * Per agent, the ids the latest device snapshot listed.
   *
   * Kept apart from the rows because absence is only evidence for the path that
   * publishes a whole set: a live decision request that stops arriving has said
   * nothing about itself, while an id the device listed a moment ago and lists no
   * longer has plainly stopped waiting. A snapshot speaks for one connection, so
   * it may only expire the ids that same connection listed.
   */
  const listedByDevice = new Map<string, ReadonlySet<string>>();

  const counts = {
    added: 0,
    refreshed: 0,
    decided: 0,
    expired: 0,
    deviceSnapshots: 0,
    replayPasses: 0,
    replayResolved: 0,
    missingId: 0,
    missingList: 0,
    unreadable: 0,
    evictedPending: 0,
    evictedResolved: 0,
  };

  /** Drop the oldest waiting row when a new one would exceed the bound. */
  function enforcePendingBound(): void {
    while (waiting.size > pendingBound) {
      const oldest = waiting.keys().next();

      if (oldest.done === true) {
        break;
      }

      waiting.delete(oldest.value);
      counts.evictedPending += 1;
    }
  }

  /**
   * Drop the oldest finished row when the history would exceed its bound.
   *
   * Separate from the waiting bound on purpose: a busy session would otherwise
   * push a request somebody still has to answer out of the table to remember one
   * that is already over.
   */
  function enforceResolvedBound(): void {
    while (finished.size > resolvedBound) {
      const oldest = finished.keys().next();

      if (oldest.done === true) {
        break;
      }

      finished.delete(oldest.value);
      counts.evictedResolved += 1;
    }
  }

  /**
   * File one arrival under its id: a new waiting row, or an update of the
   * existing one.
   *
   * An id that has already finished is left alone: a decision is final, and a
   * re-push of a resolved id is the engine being late rather than the request
   * coming back.
   *
   * @param requestId the key the arrival named
   * @param facts what this arrival knows about the request
   * @returns whether a new waiting row was created
   */
  function note(requestId: string, facts: ApprovalFacts): boolean {
    if (finished.has(requestId)) {
      counts.refreshed += 1;

      return false;
    }

    const existing = waiting.get(requestId);

    if (existing === undefined) {
      waiting.set(requestId, entityOf(requestId, facts, "pending"));
      counts.added += 1;
      enforcePendingBound();

      return true;
    }

    // The first sighting keeps what identifies the request - who it belongs to
    // and when it appeared - because a later path describing the same request
    // does not move either fact, and a badge grouped per agent must not have the
    // request jump between agents. The descriptive fields take the newest
    // reading, because a snapshot or a replay can carry a fuller body than the
    // first frame.
    waiting.set(
      requestId,
      entityOf(
        requestId,
        {
          toolName: facts.toolName === "" ? existing.toolName : facts.toolName,
          input: Object.keys(facts.input).length === 0 ? existing.input : facts.input,
          agentId: existing.agentId === "" ? facts.agentId : existing.agentId,
          conversationId:
            existing.conversationId === "" ? facts.conversationId : existing.conversationId,
          requestedAt: existing.requestedAt,
        },
        "pending",
      ),
    );
    counts.refreshed += 1;

    return false;
  }

  /**
   * Move one waiting row to the finished half, keeping everything it says.
   *
   * @param requestId the row to resolve
   * @param verdict how it ended
   * @returns whether a waiting row was resolved by this call
   */
  function settle(requestId: string, verdict: ApprovalVerdict): boolean {
    const row = waiting.get(requestId);

    if (row === undefined) {
      return false;
    }

    waiting.delete(requestId);

    // Delete before set is not needed on an absent key, but the finished map has
    // to hold the newest resolution last: it is the eviction order, and a row
    // resolved twice must not keep an old position.
    finished.delete(requestId);
    finished.set(requestId, entityOf(requestId, row, verdict));
    enforceResolvedBound();

    if (verdict === "decided") {
      counts.decided += 1;
    } else {
      counts.expired += 1;
    }

    return true;
  }

  /**
   * The decision request path: one `approval.requested` change.
   *
   * @param change the change to file
   * @returns what it did
   */
  function onControlRequest(change: MergerChange): ApprovalEffect {
    const requestId = readString((change as { readonly requestId?: unknown }).requestId);

    if (requestId === null) {
      // No key means no deduplication: filing it would make every arrival a new
      // approval, which is worse than not showing it.
      counts.missingId += 1;

      return { path: "control-request", effect: "ignored", requestIds: [] };
    }

    const body = asRecord((change as { readonly body?: unknown }).body) ?? {};
    const added = note(requestId, {
      ...factsOf(body),
      ...identityOf(body, change),
      requestedAt: readTime((change as { readonly at?: unknown }).at) ?? 0,
    });

    return {
      path: "control-request",
      effect: added ? "added" : "refreshed",
      requestIds: [requestId],
    };
  }

  /**
   * The pending list out of a device payload.
   *
   * The engine nests the state under its own key in the recorded frames; a
   * caller that already unwrapped it passes the state itself and reads the same.
   *
   * @param value the change's value
   * @returns the entries, or `null` when the payload does not name a list
   */
  function pendingOf(value: unknown): readonly Record<string, unknown>[] | null {
    const record = asRecord(value);

    if (record === null) {
      return null;
    }

    const state = asRecord(record["device_status"]) ?? record;
    const list = state["pending_control_requests"];

    if (!Array.isArray(list)) {
      return null;
    }

    const entries: Record<string, unknown>[] = [];

    for (const entry of list) {
      const record = asRecord(entry);

      if (record === null) {
        counts.unreadable += 1;
        continue;
      }

      entries.push(record);
    }

    return entries;
  }

  /**
   * The device snapshot path: the ids it lists are waiting, and an id it listed
   * before and lists no longer stopped waiting - without this side answering it,
   * so it expired.
   *
   * @param change the `state.device` change
   * @returns what it did
   */
  function onDeviceSnapshot(change: MergerChange): ApprovalEffect {
    const list = pendingOf((change as { readonly value?: unknown }).value);

    if (list === null) {
      // The payload names no pending list at all: that is not a statement that
      // nothing is waiting, so no row is resolved on the strength of it.
      counts.missingList += 1;

      return { path: "device-snapshot", effect: "ignored", requestIds: [] };
    }

    counts.deviceSnapshots += 1;

    const touched: string[] = [];
    const listed = new Set<string>();
    const { agentId } = identityOf({}, change);
    const stamp = readTime((change as { readonly at?: unknown }).at) ?? 0;

    for (const entry of list) {
      const requestId = requestIdOf(entry);

      if (requestId === null) {
        counts.missingId += 1;
        continue;
      }

      listed.add(requestId);
      note(requestId, {
        ...factsOf(entry),
        ...identityOf(entry, change),
        requestedAt: readTime(entry["requested_at"]) ?? stamp,
      });
      touched.push(requestId);
    }

    // Only this connection's own previous list may be expired: another agent's
    // approvals are still waiting on another connection, and its device frame
    // says nothing about them.
    let resolved = 0;

    for (const requestId of listedByDevice.get(agentId) ?? []) {
      if (listed.has(requestId)) {
        continue;
      }

      if (settle(requestId, "expired")) {
        resolved += 1;
        touched.push(requestId);
      }
    }

    listedByDevice.set(agentId, listed);

    if (resolved > 0) {
      return { path: "device-snapshot", effect: "resolved", requestIds: touched };
    }

    return {
      path: "device-snapshot",
      effect: touched.length === 0 ? "noted" : "refreshed",
      requestIds: touched,
    };
  }

  /**
   * A replay pass with the ids it reported.
   *
   * The list is the engine's answer to "which approvals are still waiting", so an
   * id on it is a waiting approval even when the live frame for it was missed -
   * a replay can be older than this subscription. Those are filed with what the
   * entry names and nothing else invented; a bare id is filed as an unnamed
   * request, which is the honest reading of an id and nothing else.
   *
   * @param requestIds the ids the engine replayed, as ids or as whole bodies
   * @param scope the agent the pass speaks for; `null` means every row
   * @param change the change the pass arrived on, for an arrival stamp
   * @returns what it did
   */
  function applyReplay(
    requestIds: readonly unknown[],
    scope?: string | null,
    change?: MergerChange,
  ): ApprovalEffect {
    counts.replayPasses += 1;

    const stamp = readTime((change as { readonly at?: unknown } | undefined)?.at) ?? 0;
    const replayed = new Set<string>();
    const touched: string[] = [];
    let resolved = 0;
    let added = 0;

    for (const value of requestIds) {
      // A replayed entry may be the id itself or the whole body, as the wire
      // frame spells it; reading both keeps one caller's shape from deciding
      // whether the pass can be applied.
      const record = asRecord(value);
      const requestId = typeof value === "string" ? readString(value) : requestIdOf(record ?? {});

      if (requestId === null) {
        counts.missingId += 1;
        continue;
      }

      replayed.add(requestId);

      if (waiting.has(requestId) || finished.has(requestId)) {
        // A finished id is left finished: the pass is a snapshot of what waits,
        // and an id that has already been decided does not start waiting again.
        if (waiting.has(requestId)) {
          touched.push(requestId);
        }

        continue;
      }

      note(requestId, {
        ...(record === null ? { toolName: "", input: Object.freeze({}) } : factsOf(record)),
        ...(record === null || change === undefined
          ? { agentId: scope ?? "", conversationId: "" }
          : identityOf(record, change)),
        requestedAt: record === null ? stamp : (readTime(record["requested_at"]) ?? stamp),
      });
      added += 1;
      touched.push(requestId);
    }

    for (const [requestId, row] of [...waiting]) {
      if (replayed.has(requestId)) {
        continue;
      }

      if (scope !== undefined && scope !== null && row.agentId !== scope) {
        continue;
      }

      if (settle(requestId, "expired")) {
        counts.replayResolved += 1;
        resolved += 1;
        touched.push(requestId);
      }
    }

    if (resolved > 0) {
      return { path: "replay", effect: "resolved", requestIds: touched };
    }

    if (added > 0) {
      return { path: "replay", effect: "added", requestIds: touched };
    }

    return {
      path: "replay",
      effect: touched.length === 0 ? "noted" : "refreshed",
      requestIds: touched,
    };
  }

  return {
    ingest(change): ApprovalEffect {
      try {
        switch (change.kind) {
          case "approval.requested":
            return onControlRequest(change);

          case "state.device":
            return onDeviceSnapshot(change);

          case "passthrough": {
            // The replay's approvals arrive as `approval.requested` changes; the
            // resync reply itself only marks that a pass just ran. Its body
            // normally names no list, and when it does, that list is applied
            // here - a bonus input, never the authoritative one, which is the
            // reconnect layer's own answer handed to `applyReplay`.
            if ((change as { readonly type?: unknown }).type !== "sync_response") {
              return { path: null, effect: "ignored", requestIds: [] };
            }

            const raw = asRecord((change as { readonly raw?: unknown }).raw);
            const list = raw === null ? undefined : raw["pending_control_requests"];

            if (!Array.isArray(list)) {
              counts.missingList += 1;

              return { path: "replay", effect: "noted", requestIds: [] };
            }

            return applyReplay(list, null, change);
          }

          default:
            return { path: null, effect: "ignored", requestIds: [] };
        }
      } catch {
        // A change can be a proxy, a throwing getter or a revoked object. The
        // caller is a socket callback: one unreadable arrival is a counter, and
        // the next frame still flows.
        counts.unreadable += 1;

        return { path: null, effect: "ignored", requestIds: [] };
      }
    },

    applyReplay(requestIds, agentId): ApprovalEffect {
      try {
        return applyReplay(requestIds, agentId);
      } catch {
        counts.unreadable += 1;

        return { path: "replay", effect: "ignored", requestIds: [] };
      }
    },

    resolve(requestId, verdict = "decided"): boolean {
      try {
        return settle(readString(requestId) ?? "", verdict === "expired" ? "expired" : "decided");
      } catch {
        counts.unreadable += 1;

        return false;
      }
    },

    get(requestId: string): ApprovalEntity | null {
      return waiting.get(requestId) ?? finished.get(requestId) ?? null;
    },

    pending(agentId?: string): readonly ApprovalEntity[] {
      const out: ApprovalEntity[] = [];

      for (const row of waiting.values()) {
        if (agentId !== undefined && row.agentId !== agentId) {
          continue;
        }

        out.push(row);
      }

      return Object.freeze(out);
    },

    resolved(agentId?: string): readonly ApprovalEntity[] {
      const out: ApprovalEntity[] = [];

      for (const row of finished.values()) {
        if (agentId !== undefined && row.agentId !== agentId) {
          continue;
        }

        out.push(row);
      }

      return Object.freeze(out);
    },

    pendingCount(agentId?: string): number {
      if (agentId === undefined) {
        return waiting.size;
      }

      let total = 0;

      for (const row of waiting.values()) {
        if (row.agentId === agentId) {
          total += 1;
        }
      }

      return total;
    },

    get size(): number {
      return waiting.size + finished.size;
    },

    stats(): ApprovalStats {
      return {
        pending: waiting.size,
        decided: counts.decided,
        expired: counts.expired,
        added: counts.added,
        refreshed: counts.refreshed,
        deviceSnapshots: counts.deviceSnapshots,
        replayPasses: counts.replayPasses,
        replayResolved: counts.replayResolved,
        missingId: counts.missingId,
        missingList: counts.missingList,
        unreadable: counts.unreadable,
        evictedPending: counts.evictedPending,
        evictedResolved: counts.evictedResolved,
      };
    },
  };
}
