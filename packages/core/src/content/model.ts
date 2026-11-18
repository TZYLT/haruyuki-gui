/**
 * The content model facade: one conversation-scoped object that turns the
 * merger's changes into block updates.
 *
 * The facade owns the three in-flight tables -- one assembly state per streamed
 * message, one tool call table per conversation, one reasoning aggregator -- and
 * nothing else. Every returned block is a copy that has already been cleaned to
 * the JSON subset; the consumer stores it and may `release` the message, after
 * which this object keeps no block copies for it.
 *
 * The dispatch rules:
 *
 * - `message.delta` grows a message state (or starts one) and reports only the
 *   blocks that changed, filed under the message they belong to;
 * - `message.final` is a whole message the merger did not assemble: prose goes
 *   through the history parser, reasoning and tools reuse the conversation's
 *   own tables so fragments pair across messages, an error becomes one block,
 *   agent-only thinking produces nothing, and anything unknown is preserved;
 * - `message.complete` flushes a streamed message and marks it complete;
 * - `message.reset` drops the old blocks and reports their ids, so the next
 *   frame rebuilds the same ids from the start;
 * - `turn.finished` marks the run's open tool calls incomplete, then forgets
 *   that run's message states (their blocks are already in the consumer).
 *
 * `ingest` is synchronous and never throws. The in-flight message table is
 * bounded; going over the cap evicts the oldest state and counts the overflow,
 * rather than clearing the table or refusing the change. There is no clock, no
 * randomness, no I/O, no subscription and no output frame here.
 */

import type { Block, BlockId, ContentUpdate, ErrorBlock, UnknownBlock } from "@haruyuki/protocol";

import type { MergerChange } from "../merge/types.js";
import {
  completeMessage,
  createDeltaState,
  ingestDelta,
  resetMessage,
  toSourceDelta,
  toSourceMessage,
  type MessageDeltaChange,
  type MessageFinalChange,
} from "./adapter.js";
import { parseHistoryPage } from "./history.js";
import {
  clearReasoning,
  createReasoningAggregator,
  ingestReasoning,
  type ReasoningAggregator,
} from "./reasoning.js";
import { sanitizeBlock, sanitizeUpdate } from "./sanitize.js";
import {
  clearTools,
  createToolTable,
  incompleteForRun,
  ingestToolMessage,
  releaseToolMessage,
  toolStats,
  type ToolTable,
} from "./tools.js";
import {
  blockIdFor,
  DEFAULT_MAX_IN_FLIGHT_MESSAGES,
  normalizeLimit,
  type ContentModel,
  type ContentModelOptions,
  type ContentStats,
  type MessageState,
  type SourceDelta,
  type SourceMessage,
} from "./types.js";

/**
 * Message types whose payload belongs to the tool state machine.
 *
 * `approval_response_message` is listed even though a response produces no
 * block of its own: consuming it here is what keeps it from surfacing as an
 * unknown block, and it matches the history parser's treatment.
 */
const TOOL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "tool_call_message",
  "tool_return_message",
  "approval_request_message",
  "approval_response_message",
  "client_tool_start",
  "client_tool_end",
]);

/** All mutable state of one model instance. */
type ModelState = {
  readonly messages: Map<string, MessageState>;
  /** Run id to the message states it assembled; `null` is a legitimate key. */
  readonly runMessages: Map<string | null, Set<string>>;
  readonly tools: ToolTable;
  readonly reasoning: ReasoningAggregator;
  readonly maxInFlightMessages: number;
  /** One translated delta per upstream change, so a repeat is recognisable. */
  readonly deltas: WeakMap<MessageDeltaChange, SourceDelta>;
  parsedMessages: number;
  blocksEmitted: number;
  unknownBlocks: number;
  overflows: number;
  lastErrorAt: number | null;
};

/** One message's blocks, kept in first-seen order while duplicates are replaced. */
type BlockGroup = {
  readonly messageId: string;
  readonly blocks: Block[];
  readonly index: Map<BlockId, number>;
};

/**
 * Create the content model for one conversation.
 *
 * `maxInFlightMessages` caps the number of messages being assembled at once
 * (default 256). `maxToolsPerMessage` caps the calls tracked for one source
 * message (default 256) and is handed to the tool table unchanged. Invalid
 * values fall back to the defaults instead of disabling a bound.
 */
export function createContentModel(options: ContentModelOptions = {}): ContentModel {
  const state: ModelState = {
    messages: new Map(),
    runMessages: new Map(),
    tools: createToolTable(
      options.maxToolsPerMessage === undefined
        ? {}
        : { maxToolsPerMessage: options.maxToolsPerMessage },
    ),
    reasoning: createReasoningAggregator(),
    maxInFlightMessages: normalizeLimit(
      options.maxInFlightMessages,
      DEFAULT_MAX_IN_FLIGHT_MESSAGES,
    ),
    deltas: new WeakMap(),
    parsedMessages: 0,
    blocksEmitted: 0,
    unknownBlocks: 0,
    overflows: 0,
    lastErrorAt: null,
  };

  return {
    ingest(change) {
      try {
        return ingestChange(state, change);
      } catch {
        // A malformed change must cost only itself. The arrival time is the only
        // clock value available, and it is the change's own, not a reading.
        state.lastErrorAt = timeOfChange(change) ?? state.lastErrorAt;
        return [];
      }
    },

    parseMessages(messages) {
      try {
        const blocks = parseHistoryPage(messages).map(sanitizeBlock);
        state.parsedMessages += messages.length;
        recordBlocks(state, blocks);
        return blocks;
      } catch {
        return [];
      }
    },

    release(messageId) {
      releaseMessage(state, messageId);
    },

    reset() {
      resetState(state);
    },

    stats() {
      return statsOf(state);
    },
  };
}

/** Route one change by kind; unsupported kinds change nothing. */
function ingestChange(state: ModelState, change: MergerChange): readonly ContentUpdate[] {
  switch (change.kind) {
    case "message.delta":
      return ingestDeltaChange(state, change);
    case "message.final":
      return ingestFinalChange(state, change);
    case "message.complete":
      return ingestComplete(state, change);
    case "message.reset":
      return ingestReset(state, change);
    case "turn.finished":
      return ingestTurnFinished(state, change);
    default:
      return [];
  }
}

/** Grow one streamed message and report the blocks this frame changed. */
function ingestDeltaChange(
  state: ModelState,
  change: MessageDeltaChange,
): readonly ContentUpdate[] {
  let message = state.messages.get(change.messageId);
  if (message === undefined) {
    makeRoomForMessage(state);
    message = createDeltaState(toSourceDelta(change));
    state.messages.set(message.messageId, message);
    rememberRunMessage(state, message.runId, message.messageId);
  }

  const delta = sourceDeltaOf(state, change);
  return publish(state, ingestDelta(message, delta));
}

/**
 * Handle one whole message the merger did not build from deltas.
 *
 * Prose is complete on arrival, so it goes through the same page parser the
 * history path uses. Reasoning and tool messages use this conversation's tables
 * instead of a page-local one, because their fragments legitimately pair across
 * upstream changes.
 */
function ingestFinalChange(
  state: ModelState,
  change: MessageFinalChange,
): readonly ContentUpdate[] {
  return publish(state, blocksForFinal(state, toSourceMessage(change)));
}

/** The blocks one final message contributes, by type. */
function blocksForFinal(state: ModelState, message: SourceMessage): readonly Block[] {
  switch (message.messageType) {
    case "user_message":
    case "assistant_message":
      return parseHistoryPage([message]);
    case "reasoning_message": {
      const update = ingestReasoning(state.reasoning, message);
      return update === null ? [] : [update.block];
    }
    case "hidden_reasoning_message":
      // Agent-only thinking: it must never surface as a reasoning block.
      return [];
    case "error_message":
      return [errorBlockOf(message)];
    default:
      if (TOOL_MESSAGE_TYPES.has(message.messageType)) {
        return ingestToolMessage(state.tools, message).map((update) => update.block);
      }
      return [unknownBlockOf(message)];
  }
}

/** Close one streamed message: flush the tail and mark its blocks complete. */
function ingestComplete(
  state: ModelState,
  change: Extract<MergerChange, { kind: "message.complete" }>,
): readonly ContentUpdate[] {
  const message = state.messages.get(change.messageId);
  if (message === undefined) {
    return [];
  }
  return publish(state, completeMessage(message));
}

/**
 * Drop one message's assembly state and report the block ids to remove.
 *
 * The next delta for the same id starts over with fresh counters, which is why
 * identical content rebuilds identical ids after a resend.
 */
function ingestReset(
  state: ModelState,
  change: Extract<MergerChange, { kind: "message.reset" }>,
): readonly ContentUpdate[] {
  const message = state.messages.get(change.messageId);
  if (message === undefined) {
    return [];
  }

  const removed = resetMessage(message);
  state.messages.delete(change.messageId);
  forgetRunMessage(state, message.runId, change.messageId);

  if (removed.length === 0) {
    return [];
  }
  return [sanitizeUpdate({ messageId: change.messageId, upserts: [], removes: removed })];
}

/**
 * Finish one turn: mark its open calls incomplete and forget its messages.
 *
 * The tool states stay: a late return is still allowed to replace the corner
 * mark with real evidence. Message states are dropped because their blocks are
 * already in the consumer, so keeping them would only duplicate memory.
 */
function ingestTurnFinished(
  state: ModelState,
  change: Extract<MergerChange, { kind: "turn.finished" }>,
): readonly ContentUpdate[] {
  const blocks = incompleteForRun(state.tools, change.runId).map((update) => update.block);
  forgetRun(state, change.runId);
  return publish(state, blocks);
}

/** Clean and group blocks into one update per owning source message. */
function publish(state: ModelState, blocks: readonly Block[]): readonly ContentUpdate[] {
  if (blocks.length === 0) {
    return [];
  }

  const updates = updatesOf(blocks.map(sanitizeBlock));
  for (const update of updates) {
    recordBlocks(state, update.upserts);
  }
  return updates;
}

/**
 * Group blocks by their `messageId`, replacing a repeated id in place.
 *
 * The group order follows the first block seen for each message, and a block
 * keeps its first position inside its group. That is what lets a tool result
 * update a card without moving it to the end.
 */
function updatesOf(blocks: readonly Block[]): readonly ContentUpdate[] {
  const groups = new Map<string, BlockGroup>();

  for (const block of blocks) {
    let group = groups.get(block.messageId);
    if (group === undefined) {
      group = { messageId: block.messageId, blocks: [], index: new Map() };
      groups.set(block.messageId, group);
    }

    const position = group.index.get(block.id);
    if (position === undefined) {
      group.index.set(block.id, group.blocks.length);
      group.blocks.push(block);
    } else {
      group.blocks[position] = block;
    }
  }

  return [...groups.values()].map((group) =>
    sanitizeUpdate({ messageId: group.messageId, upserts: group.blocks, removes: [] }),
  );
}

/** Translate one upstream delta once, so the assembler can spot a repeat. */
function sourceDeltaOf(state: ModelState, change: MessageDeltaChange): SourceDelta {
  const held = state.deltas.get(change);
  if (held !== undefined) {
    return held;
  }
  const delta = toSourceDelta(change);
  state.deltas.set(change, delta);
  return delta;
}

/** Evict the oldest message state while the table is at its cap. */
function makeRoomForMessage(state: ModelState): void {
  while (state.messages.size >= state.maxInFlightMessages) {
    const oldest = state.messages.keys().next();
    if (oldest.done === true) {
      return;
    }
    forgetMessage(state, oldest.value);
    state.overflows += 1;
  }
}

/** Forget one message state and its run index entry, without emitting removes. */
function forgetMessage(state: ModelState, messageId: string): void {
  const message = state.messages.get(messageId);
  if (message === undefined) {
    return;
  }
  state.messages.delete(messageId);
  forgetRunMessage(state, message.runId, messageId);
}

/** Remember that a run assembled this message. */
function rememberRunMessage(state: ModelState, runId: string | null, messageId: string): void {
  const owned = state.runMessages.get(runId);
  if (owned === undefined) {
    state.runMessages.set(runId, new Set([messageId]));
    return;
  }
  owned.add(messageId);
}

/** Drop one message from its run's index, removing an empty index. */
function forgetRunMessage(state: ModelState, runId: string | null, messageId: string): void {
  const owned = state.runMessages.get(runId);
  if (owned === undefined) {
    return;
  }
  owned.delete(messageId);
  if (owned.size === 0) {
    state.runMessages.delete(runId);
  }
}

/** Forget every message assembled by one finished run. */
function forgetRun(state: ModelState, runId: string | null): void {
  const owned = state.runMessages.get(runId);
  if (owned === undefined) {
    return;
  }
  for (const messageId of owned) {
    state.messages.delete(messageId);
  }
  state.runMessages.delete(runId);
}

/** Drop a consumed message and the finished calls it last touched. */
function releaseMessage(state: ModelState, messageId: string): void {
  forgetMessage(state, messageId);
  // A call whose result has not arrived is kept on purpose: releasing a
  // message must not lose an output that a later message will deliver.
  releaseToolMessage(state.tools, messageId);
}

/** Clear every in-flight table and start a new diagnostics window. */
function resetState(state: ModelState): void {
  state.messages.clear();
  state.runMessages.clear();
  clearTools(state.tools);
  clearReasoning(state.reasoning);
  state.parsedMessages = 0;
  state.blocksEmitted = 0;
  state.unknownBlocks = 0;
  state.overflows = 0;
  state.lastErrorAt = null;
}

/** Read-only counters, computed so they cannot drift from the tables. */
function statsOf(state: ModelState): ContentStats {
  const tools = toolStats(state.tools);
  return {
    inFlightMessages: state.messages.size,
    inFlightToolCalls: tools.inFlightToolCalls,
    parsedMessages: state.parsedMessages,
    blocksEmitted: state.blocksEmitted,
    unknownBlocks: state.unknownBlocks,
    orphanTools: tools.orphanTools,
    overflows: state.overflows,
    truncatedTools: tools.truncatedTools,
    lastErrorAt: state.lastErrorAt,
  };
}

/** Count the blocks actually handed out by one update batch. */
function recordBlocks(state: ModelState, blocks: readonly Block[]): void {
  state.blocksEmitted += blocks.length;
  for (const block of blocks) {
    if (block.type === "unknown") {
      state.unknownBlocks += 1;
    }
  }
}

/** The block for a message type this version does not understand. */
function unknownBlockOf(message: SourceMessage): UnknownBlock {
  return {
    id: blockIdFor(message.id, "unknown", 0),
    messageId: message.id,
    runId: message.runId,
    role: message.role,
    type: "unknown",
    rawType: message.messageType,
    raw: message.body,
  };
}

/** The block for an error message; absent fields stay empty rather than invented. */
function errorBlockOf(message: SourceMessage): ErrorBlock {
  const body = recordOf(message.body) ?? {};
  const nested = recordOf(body.error) ?? {};

  return {
    id: blockIdFor(message.id, "error", 0),
    messageId: message.id,
    runId: message.runId,
    role: message.role,
    type: "error",
    message: textOf(body.message) ?? textOf(nested.message) ?? "",
    errorType: textOf(body.error_type) ?? textOf(body.errorType) ?? textOf(nested.type),
    detail:
      textOf(body.detail) ??
      textOf(body.description) ??
      textOf(nested.detail) ??
      textOf(body.stack),
  };
}

/** The arrival time a change carries, or `null` when it is not readable. */
function timeOfChange(change: unknown): number | null {
  if (change === null || typeof change !== "object") {
    return null;
  }
  const at = (change as { readonly at?: unknown }).at;
  return typeof at === "number" && Number.isFinite(at) ? at : null;
}

/** A non-empty string, or `null`. */
function textOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A plain object, or `null` for arrays and primitives. */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
