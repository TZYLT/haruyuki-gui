/**
 * The content model's public surface: the shapes it consumes, the state it keeps
 * while a message streams, and the pure helpers that make its output stable.
 *
 * Nothing here reads a socket, touches a clock or draws anything. The block
 * union itself lives in `@haruyuki/protocol`; this file only adds the core-side
 * wrappers around it, so a replay of the same conversation produces the same
 * block ids and the same content keys.
 *
 * Two rules are load-bearing:
 *
 * 1. **Ids are derived, never random.** A message id, a block type and an
 *    ordinal are enough to rebuild an id, which is what makes replay and
 *    re-parse agree. `blockIdFor` does not validate the ordinal: the caller owns
 *    the counter, and the id is a plain concatenation so that a bad counter is
 *    visible instead of being silently rewritten.
 * 2. **In-flight state is bounded.** `MessageState` and `ToolState` are mutable
 *    because they grow while a delta arrives, but the model that owns them caps
 *    their tables and counts overflows rather than clearing them silently.
 */

import type {
  Block,
  BlockId,
  BlockRole,
  BlockType,
  ContentUpdate,
  ToolStatus,
} from "@haruyuki/protocol";

import type { AssistantPart, MergerChange } from "../merge/types.js";

/** One message handed to the parser, from a live delta or from history. */
export type SourceMessage = {
  readonly id: string;
  readonly messageType: string;
  readonly role: BlockRole;
  /** The original payload; the adapter has already normalised it where needed. */
  readonly body: unknown;
  readonly runId: string | null;
  /** Arrival time in milliseconds; `null` when history had no parseable date. */
  readonly at: number | null;
};

/** One live fragment of an assistant message. */
export type SourceDelta = {
  readonly messageId: string;
  readonly runId: string | null;
  /** The text seen so far, as merged by the upstream assembly. */
  readonly text: string;
  /** Every part of the message seen so far, in source order. */
  readonly parts: readonly AssistantPart[];
  readonly first: boolean;
};

/**
 * Mutable state of the line-oriented fence scanner.
 *
 * `pendingLine` holds the tail that has no newline yet. A fence opener only
 * becomes real once its newline arrives, so the tail stays buffered instead of
 * being emitted as prose and then retracted. `closed` records whether the
 * current code block saw its closing fence; it is separate from a block's
 * `status`, because an unterminated fence is still complete once the message is.
 */
export type FenceState = {
  mode: "text" | "code";
  fenceChar: "`" | "~" | null;
  fenceLength: number;
  info: string;
  closed: boolean;
  pendingLine: string;
};

/** All in-flight state for one source message. */
export type MessageState = {
  messageId: string;
  messageType: string;
  role: BlockRole;
  runId: string | null;
  blocks: Block[];
  /** Block id to position in `blocks`; keeps updates in their first position. */
  blockIndex: Map<BlockId, number>;
  /** Per-type ordinal counter, so ids stay dense per message and per type. */
  ordinals: Map<BlockType, number>;
  fence: FenceState;
};

/** Everything known about one tool call, across every message that mentions it. */
export type ToolState = {
  blockId: BlockId;
  messageId: string;
  runId: string | null;
  toolCallId: string;
  name: string | null;
  /** Raw assembled arguments; not promised to be valid JSON. */
  argumentsText: string;
  /** True once a complete argument record replaced the fragment stream. */
  argumentsComplete: boolean;
  result: unknown;
  status: ToolStatus;
  /** Whether the client-side end marker was seen; it does not close the call. */
  sawEnd: boolean;
  /** True when a result arrived without its call ever being seen. */
  orphan: boolean;
};

/**
 * The conversation-scoped content model.
 *
 * One instance per conversation. `ingest` is synchronous and never throws;
 * `parseMessages` is the history path and keeps no state across calls.
 */
export type ContentModel = {
  /** Ingest one upstream change and return the blocks it changed. */
  ingest(change: MergerChange): readonly ContentUpdate[];
  /** Parse one page of history; tools pair only inside the page. */
  parseMessages(messages: readonly SourceMessage[]): readonly Block[];
  /** Drop a message's assembly buffers once the consumer has its blocks. */
  release(messageId: string): void;
  /** Clear all in-flight state at a connection or conversation boundary. */
  reset(): void;
  /** Read-only counters. */
  stats(): ContentStats;
};

/** Bounded counters; the model owns the writable side. */
export type ContentStats = {
  readonly inFlightMessages: number;
  readonly inFlightToolCalls: number;
  readonly parsedMessages: number;
  readonly blocksEmitted: number;
  readonly unknownBlocks: number;
  readonly orphanTools: number;
  readonly overflows: number;
  readonly truncatedTools: number;
  readonly lastErrorAt: number | null;
};

/** Bounds for the in-flight tables. */
export type ContentModelOptions = {
  readonly maxInFlightMessages?: number;
  readonly maxToolsPerMessage?: number;
};

/** Default cap on messages assembled at the same time. */
export const DEFAULT_MAX_IN_FLIGHT_MESSAGES = 256;
/** Default cap on tool calls tracked for one message. */
export const DEFAULT_MAX_TOOLS_PER_MESSAGE = 256;

/**
 * Stable id of a positional block: `${messageId}:${type}:${ordinal}`.
 *
 * The ordinal is interpolated as given. It is not clamped or rounded: the
 * counter is the caller's invariant, and hiding a bad value here would make two
 * different positions share an id.
 */
export function blockIdFor(messageId: string, type: BlockType, ordinal: number): BlockId {
  return `${messageId}:${type}:${ordinal}`;
}

/** Stable id of one reasoning segment under its parent assistant message. */
export function reasoningBlockId(parentMessageId: string, segment: number): BlockId {
  return `${parentMessageId}:reasoning:${segment}`;
}

/** Stable id of a tool call block; one call yields exactly one block. */
export function makeToolBlockId(toolCallId: string): BlockId {
  return `tool:${toolCallId}`;
}

/**
 * Deterministic 32-bit content key: an FNV-1a hash of a canonical serialisation.
 *
 * The serialisation sorts object keys and tags every value by type, so key
 * order never matters and `"1"` cannot collide with `1`. Values that JSON
 * cannot represent get fixed tokens instead of throwing: `undefined`, functions
 * and symbols all collapse to their token, and non-finite numbers get one token
 * each. A cycle is replaced by a marker on re-entry, so a self-referential body
 * still produces a key. The result is eight lowercase hex characters.
 */
export function contentKey(value: unknown): string {
  return fnv1a32(canonicalize(value, new WeakSet<object>()));
}

/**
 * Accept a positive integer limit or fall back.
 *
 * `Number.isInteger` rejects `NaN`, the infinities and fractions; the `> 0`
 * check rejects zero and negatives. The fallback is returned untouched, so the
 * module's own defaults are the only place a bound is invented.
 */
export function normalizeLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

const UNDEFINED_TOKEN = "<undefined>";
const FUNCTION_TOKEN = "<function>";
const SYMBOL_TOKEN = "<symbol>";
const CIRCULAR_TOKEN = "<circular>";

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "undefined":
      return UNDEFINED_TOKEN;
    case "function":
      return FUNCTION_TOKEN;
    case "symbol":
      return SYMBOL_TOKEN;
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return `<bigint:${value.toString()}>`;
    case "number":
      return numberToken(value);
    default:
      return objectToken(value, seen);
  }
}

function numberToken(value: number): string {
  if (Number.isNaN(value)) {
    return "<number:NaN>";
  }
  if (value === Number.POSITIVE_INFINITY) {
    return "<number:Infinity>";
  }
  if (value === Number.NEGATIVE_INFINITY) {
    return "<number:-Infinity>";
  }
  // `String(-0)` already prints "0", matching JSON's treatment of negative zero.
  return String(value);
}

function objectToken(value: object, seen: WeakSet<object>): string {
  if (seen.has(value)) {
    return CIRCULAR_TOKEN;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value as readonly unknown[];
      const parts: string[] = [];
      for (let index = 0; index < items.length; index += 1) {
        parts.push(canonicalize(items[index], seen));
      }
      return `[${parts.join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`);
    return `{${parts.join(",")}}`;
  } finally {
    // Only the current path is "seen"; a shared reference is serialised twice
    // rather than mistaken for a cycle.
    seen.delete(value);
  }
}

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
