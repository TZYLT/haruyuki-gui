/**
 * The session store's vocabulary: the bounds it keeps, what it is built from,
 * what one selector answer looks like, and the readers every part next door
 * shares.
 *
 * No session state lives here, and reading a change is not publishing one: the
 * readers below are the only way a change is ever read - a proxy, a throwing
 * getter or a missing field costs one change, never an exception.
 */

import type { SelectResult, SessionSelectCode, SessionViewBody } from "@haruyuki/protocol";

import { asRecord } from "../merge/envelope.js";
import { readLoop } from "./device.js";

/**
 * How many processed changes are remembered for duplicate suppression.
 *
 * A reconnect re-sends the tail of the stream, and a frame in it must not be
 * folded twice: the turn table would allocate a second ref and the badge would
 * count the turn again. Bounded, because a session that never reconnects would
 * otherwise hold one entry per frame forever.
 */
export const DEDUPE_TURN_LIMIT = 8192;

/** How many usage reports one conversation's trail keeps. */
export const USAGE_HISTORY_LIMIT = 32;

/**
 * What the store is built from.
 *
 * No sink for commands and no reader for files: this module neither sends nor
 * fetches. A frame body is handed back through `onView` and the shell decides
 * how to send it, as the event merger already does.
 */
export type SessionStoreDeps = {
  /**
   * Where a subscription's result goes when the shell routes every frame through
   * one function. A sink passed to `subscribe` is called as well.
   */
  readonly onView?: (body: SessionViewBody) => void;

  /**
   * Reading the clock, for the burst window a subscription keeps per instance.
   *
   * Only consulted when {@link schedule} is given, and only to notice a window
   * whose timer is late. Absent, the wall clock is used.
   */
  readonly now?: () => number;

  /**
   * Defer one call by a number of milliseconds and return its canceller.
   *
   * Absent means no burst window: a change reaches its subscriptions as it
   * arrives, which is what a caller that wants every frame to be synchronous
   * gets. Given, a burst on one instance is answered once, carrying the last
   * value in it, so a fast producer cannot cost a frame per change.
   */
  readonly schedule?: (fn: () => void, ms: number) => () => void;
};

/**
 * One selector answer, plus the refusal code when there was none.
 *
 * The signed result shape has no arm for a failure: a failed run travels back as
 * a `session.result` body with `ok: false` and a code, built by the shell. The
 * code rides on the same object, so no second run or copy of the name is needed.
 */
export type SessionSelection = SelectResult & { readonly code?: SessionSelectCode };

/** One selector run, before it is stamped with the revision and generation. */
type SelectorOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: SessionSelectCode };

/** The three denominator layers one conversation may name. */
type ContextLimits = {
  readonly conversationOverride: number | null;
  readonly agentConfig: number | null;
  readonly modelCatalog: number | null;
};

/** No layer has spoken for a conversation yet. */
const NO_LIMITS: ContextLimits = {
  conversationOverride: null,
  agentConfig: null,
  modelCatalog: null,
};

/** Which layer of {@link ContextLimits} a reported source names. */
const LIMIT_LAYER: Readonly<Record<string, keyof ContextLimits | undefined>> = {
  "conversation-override": "conversationOverride",
  "agent-config": "agentConfig",
  "model-catalog": "modelCatalog",
};

/** A non-empty string, or `null`. */
function readText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A finite arrival time, or `null`. */
function readTime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Two id lists with the same entries in the same order. */
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((id, index) => id === right[index]);
}

/**
 * Whether two maps publish the same rows, by reference - what makes a revision
 * mean "something visible moved". A fold that produced the row it already had
 * hands back the same entity, and republishing it would tell every subscriber
 * the state changed.
 */
function sameMap<V>(candidate: ReadonlyMap<string, V>, published: ReadonlyMap<string, V>): boolean {
  if (candidate.size !== published.size) {
    return false;
  }

  for (const [key, value] of candidate) {
    if (published.get(key) !== value) {
      return false;
    }
  }

  return true;
}

/**
 * The loop state one change carries, if it carries one.
 *
 * It arrives on its own change kind with the engine's payload kept whole, so the
 * recorded frames nest it under `loop_status` and an already-unwrapped caller
 * hands the state itself. Anything else is "no state", never an empty one: the
 * eight statuses are kept verbatim, and a blank would draw a pulse the engine
 * never gave.
 */
function loopStatusOf(value: unknown): string | null {
  const record = asRecord(value);

  if (record === null) {
    return null;
  }

  const nested = asRecord(record["loop_status"]) ?? asRecord(record["delta"]);

  return readLoop(nested?.["status"] ?? record["status"]);
}

// The store composes the denominators and runs the selectors, so it names this
// vocabulary; none of it is part of the package contract.
export {
  LIMIT_LAYER,
  NO_LIMITS,
  loopStatusOf,
  readText,
  readTime,
  sameIds,
  sameMap,
  type ContextLimits,
  type SelectorOutcome,
};
