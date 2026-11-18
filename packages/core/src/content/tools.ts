/**
 * Tool-call assembly: one block per `toolCallId`, fed by every message that
 * mentions the call.
 *
 * A call is spread over several messages -- an approval request, a client-side
 * start, argument fragments, output snapshots, an end marker, a final return --
 * and none of them describes the whole call. This module keeps the small table
 * that folds them into one `tool_call` block and decides which message may change
 * its status.
 *
 * The rule that matters: **the end marker is not a closing edge.** A client-side
 * call reports an end before its final return, and the return seen before that
 * end was only an interim snapshot. Only a return may move a call to
 * `success`/`error`; a call still open when its turn finishes is `incomplete`,
 * never a made-up success.
 *
 * The other rules:
 *
 * - one block per call, id `tool:${toolCallId}`, `messageId` of the first message
 *   that mentioned it, so a later result never moves the card;
 * - arguments arrive as fragments (`tool_call_message`) or as a complete record
 *   (`approval_request_message`, `client_tool_start`); a complete record replaces
 *   the fragments and later fragments are ignored;
 * - results overwrite each other, latest wins, because the engine sends an
 *   interim snapshot and then the final return under a different message id;
 * - a result whose call was never seen becomes an `orphan` block that keeps its
 *   output instead of dropping it;
 * - the per-message cap counts overflows and stops building new blocks; it never
 *   clears the blocks that already exist.
 *
 * Everything here is pure: no clock, no randomness, no I/O, and no throw. A
 * malformed body contributes whatever fields can still be recognised.
 */

import type { ToolCallBlock, ToolStatus } from "@haruyuki/protocol";

import {
  DEFAULT_MAX_TOOLS_PER_MESSAGE,
  makeToolBlockId,
  normalizeLimit,
  type SourceMessage,
  type ToolState,
} from "./types.js";

/** One block a tool message changed, filed under the message that owns the call. */
export type ToolBlockUpdate = {
  readonly messageId: string;
  readonly block: ToolCallBlock;
};

/** Bounds of the tool table. */
export type ToolTableOptions = {
  /** Most calls first seen in one message; further calls are counted, not built. */
  readonly maxToolsPerMessage?: number;
};

/**
 * One tracked call. `ToolState` is the shape shared with the facade; this module
 * adds the pairing facts: a client-side call still owing its final return, the
 * status its end marker reported, which messages already gave a fragment (so
 * replaying a recording cannot append twice), and the last message that mentioned
 * the call (so a release can find a block whose first message is already gone).
 */
export type TrackedTool = ToolState & {
  readonly fragmentMessages: Set<string>;
  awaitingFinal: boolean;
  endStatus: ToolStatus | null;
  lastMessageId: string;
};

/**
 * Mutable state of one content model's tool table. `tools` preserves first-seen
 * order, `byMessage` is both the per-message quota and the release index, and the
 * two counters are cumulative since creation or the last clear.
 */
export type ToolTable = {
  readonly maxToolsPerMessage: number;
  readonly tools: Map<string, TrackedTool>;
  readonly byMessage: Map<string, Set<string>>;
  orphanTools: number;
  truncatedTools: number;
};

/** Read-only counters for the facade's `ContentStats`. */
export type ToolTableStats = {
  readonly totalTools: number;
  readonly inFlightToolCalls: number;
  readonly awaitingApproval: number;
  readonly orphanTools: number;
  readonly truncatedTools: number;
};

/** Create an empty table, with the quota normalised to a positive integer. */
export function createToolTable(options: ToolTableOptions = {}): ToolTable {
  return {
    maxToolsPerMessage: normalizeLimit(options.maxToolsPerMessage, DEFAULT_MAX_TOOLS_PER_MESSAGE),
    tools: new Map<string, TrackedTool>(),
    byMessage: new Map<string, Set<string>>(),
    orphanTools: 0,
    truncatedTools: 0,
  };
}

/**
 * Fold one source message into the table.
 *
 * Returns the blocks it changed, in body order, each filed under the message that
 * owns the call. A message type that does not touch tools, a repeated frame, or a
 * call refused by the quota returns an empty list. Never throws.
 */
export function ingestToolMessage(
  table: ToolTable,
  message: SourceMessage,
): readonly ToolBlockUpdate[] {
  const body = bodyOf(message.body);
  if (body === null) {
    return [];
  }

  const messageType = typeof message.messageType === "string" ? message.messageType.trim() : "";

  switch (messageType) {
    case "tool_call_message":
      return applyCallRefs(table, message, callRefsOf(body), "fragment");
    case "approval_request_message":
      return applyCallRefs(table, message, callRefsOf(body), "approval");
    case "client_tool_start":
      return applyCallRefs(table, message, callRefsOf(body), "client-start");
    case "client_tool_end":
      return applyClientEnd(table, message, body);
    case "tool_return_message":
      return applyReturnEntries(table, message, returnEntriesOf(body));
    default:
      return [];
  }
}

/**
 * Mark every still-open call of one run `incomplete`.
 *
 * `turn.finished` is the only signal that no further return is expected. A `null`
 * run id matches calls whose run the source never named (the history path). A
 * call that already reached a terminal state is left alone, and a later return is
 * still allowed to replace the corner mark with real evidence.
 */
export function incompleteForRun(
  table: ToolTable,
  runId: string | null,
): readonly ToolBlockUpdate[] {
  const updates: ToolBlockUpdate[] = [];

  for (const state of table.tools.values()) {
    if (state.runId !== runId || isTerminal(state.status)) {
      continue;
    }
    state.status = "incomplete";
    updates.push(updateFor(state));
  }

  return updates;
}

/**
 * Drop the finished calls one message last touched.
 *
 * A call whose result has not arrived yet is kept: release happens when a message
 * is consumed, and dropping an open call there would lose its eventual result.
 * The block stays owned by its first message, so a result delivered later still
 * finds it; that later message then releases the call once it is terminal. The
 * per-message quota is released with the entry, so the index does not grow.
 */
export function releaseToolMessage(table: ToolTable, messageId: string): void {
  for (const [toolCallId, state] of table.tools) {
    if (state.messageId !== messageId && state.lastMessageId !== messageId) {
      continue;
    }
    if (!isTerminal(state.status)) {
      continue;
    }

    table.tools.delete(toolCallId);
    const owned = table.byMessage.get(state.messageId);
    owned?.delete(toolCallId);
    if (owned !== undefined && owned.size === 0) {
      table.byMessage.delete(state.messageId);
    }
  }
}

/** Clear the table and its cumulative counters at a reset boundary. */
export function clearTools(table: ToolTable): void {
  table.tools.clear();
  table.byMessage.clear();
  table.orphanTools = 0;
  table.truncatedTools = 0;
}

/** Read-only counters, computed from the table so they cannot drift. */
export function toolStats(table: ToolTable): ToolTableStats {
  let inFlight = 0;
  let awaitingApproval = 0;

  for (const state of table.tools.values()) {
    if (!isTerminal(state.status)) {
      inFlight += 1;
    }
    if (state.status === "awaiting_approval") {
      awaitingApproval += 1;
    }
  }

  return {
    totalTools: table.tools.size,
    inFlightToolCalls: inFlight,
    awaitingApproval,
    orphanTools: table.orphanTools,
    truncatedTools: table.truncatedTools,
  };
}

/**
 * How a call message contributes its arguments: a streamed call appends
 * fragments, while an approval request and a client start carry a complete
 * record and replace what was assembled so far.
 */
type CallKind = "fragment" | "approval" | "client-start";

/** One call mentioned by a call-shaped message. */
type CallRef = {
  readonly toolCallId: string;
  readonly name: string | null;
  readonly argumentsText: string | null;
};

/** A table lookup plus whether this message created the entry. */
type Ensured = {
  readonly state: TrackedTool;
  readonly created: boolean;
};

/** One result mentioned by a return message, singular or plural. */
type ReturnEntry = {
  readonly toolCallId: string;
  readonly status: "success" | "error" | null;
  readonly result: unknown;
  readonly hasResult: boolean;
};

/** Apply one call-shaped message: fragments, an approval or a client start. */
function applyCallRefs(
  table: ToolTable,
  message: SourceMessage,
  refs: readonly CallRef[],
  kind: CallKind,
): readonly ToolBlockUpdate[] {
  const updates: ToolBlockUpdate[] = [];
  const wanted: ToolStatus = kind === "approval" ? "awaiting_approval" : "running";

  for (const ref of refs) {
    const ensured = ensure(table, message, ref.toolCallId);
    // An orphan result is sticky: its block was built from the result alone, and
    // the orphan shape keeps `name:null` with empty arguments.
    if (ensured === null || ensured.state.orphan) {
      continue;
    }

    const state = ensured.state;
    state.lastMessageId = message.id;
    let changed = ensured.created;

    if (ref.name !== null && state.name !== ref.name) {
      state.name = ref.name;
      changed = true;
    }

    if (kind === "fragment") {
      changed = appendFragment(state, message.id, ref.argumentsText) || changed;
    } else if (ref.argumentsText !== null) {
      if (state.argumentsText !== ref.argumentsText) {
        state.argumentsText = ref.argumentsText;
        changed = true;
      }
      // A complete record wins: later fragments must not append to it.
      state.argumentsComplete = true;
    }

    if (kind === "client-start") {
      // A client-side call owes a final return after its own end marker.
      state.awaitingFinal = true;
    }

    if (
      !isTerminal(state.status) &&
      state.status !== wanted &&
      (ensured.created || mayApplyStatus(kind, state))
    ) {
      state.status = wanted;
      changed = true;
    }

    if (changed) {
      updates.push(updateFor(state));
    }
  }

  return updates;
}

/** Record a client-side end: remember the status, change nothing visible. */
function applyClientEnd(
  table: ToolTable,
  message: SourceMessage,
  body: Record<string, unknown>,
): readonly ToolBlockUpdate[] {
  const updates: ToolBlockUpdate[] = [];
  const reported = statusOf(body.status);

  for (const ref of callRefsOf(body)) {
    const ensured = ensure(table, message, ref.toolCallId);
    if (ensured === null || ensured.state.orphan) {
      continue;
    }

    const state = ensured.state;
    let changed = ensured.created;

    state.lastMessageId = message.id;
    state.sawEnd = true;
    state.awaitingFinal = true;
    state.endStatus = reported;

    // An end proves the call ran, but it never closes it: the final return still
    // owns the terminal status and the final output.
    if (state.status === "awaiting_approval") {
      state.status = "running";
      changed = true;
    }

    if (changed) {
      updates.push(updateFor(state));
    }
  }

  return updates;
}

/** Apply one return message, singular or plural. */
function applyReturnEntries(
  table: ToolTable,
  message: SourceMessage,
  entries: readonly ReturnEntry[],
): readonly ToolBlockUpdate[] {
  const updates: ToolBlockUpdate[] = [];

  for (const entry of entries) {
    const update = applyReturnEntry(table, message, entry);
    if (update !== null) {
      updates.push(update);
    }
  }

  return updates;
}

/** Apply one result to the call it names, creating an orphan when unseen. */
function applyReturnEntry(
  table: ToolTable,
  message: SourceMessage,
  entry: ReturnEntry,
): ToolBlockUpdate | null {
  const existing = table.tools.get(entry.toolCallId);
  const ensured =
    existing === undefined
      ? ensure(table, message, entry.toolCallId, entry.status)
      : { state: existing, created: false };
  if (ensured === null) {
    return null;
  }

  const state = ensured.state;
  state.lastMessageId = message.id;
  let changed = ensured.created;

  if (entry.hasResult && state.result !== entry.result) {
    // Latest result wins: this is how the interim snapshot is replaced by the
    // final return, whose message id differs.
    state.result = entry.result;
    changed = true;
  }

  if (state.orphan) {
    // A result-only block follows its own results, latest status included.
    if (entry.status !== null && state.status !== entry.status) {
      state.status = entry.status;
      changed = true;
    }
    return changed ? updateFor(state) : null;
  }

  if (state.status === "awaiting_approval") {
    // A result is proof that the call executed, so it leaves the approval gate.
    state.status = "running";
    changed = true;
  }

  const authoritative = entry.status ?? state.endStatus;
  const mayClose = !state.awaitingFinal || state.sawEnd;
  if (authoritative !== null && mayClose && state.status !== authoritative) {
    state.status = authoritative;
    changed = true;
  }

  return changed ? updateFor(state) : null;
}

/** Append one fragment unless the record is complete or this message is a replay. */
function appendFragment(state: TrackedTool, messageId: string, fragment: string | null): boolean {
  if (state.argumentsComplete || fragment === null || fragment.length === 0) {
    return false;
  }
  if (state.fragmentMessages.has(messageId)) {
    return false;
  }
  state.fragmentMessages.add(messageId);
  state.argumentsText += fragment;
  return true;
}

/**
 * Look up a call, creating it on first sight unless the message quota is full.
 *
 * Passing a status creates a result-only entry instead (an orphan): that entry
 * has no name and no arguments, and its status comes from the result.
 */
function ensure(
  table: ToolTable,
  message: SourceMessage,
  toolCallId: string,
  orphanStatus?: "success" | "error" | null,
): Ensured | null {
  const existing = table.tools.get(toolCallId);
  if (existing !== undefined) {
    return { state: existing, created: false };
  }

  if ((table.byMessage.get(message.id)?.size ?? 0) >= table.maxToolsPerMessage) {
    table.truncatedTools += 1;
    return null;
  }

  const state: TrackedTool = {
    blockId: makeToolBlockId(toolCallId),
    messageId: message.id,
    runId: message.runId,
    toolCallId,
    name: null,
    argumentsText: "",
    argumentsComplete: orphanStatus !== undefined,
    result: null,
    status: orphanStatus ?? "running",
    sawEnd: false,
    orphan: orphanStatus !== undefined,
    fragmentMessages: new Set<string>(),
    awaitingFinal: false,
    endStatus: null,
    lastMessageId: message.id,
  };

  table.tools.set(toolCallId, state);
  const seen = table.byMessage.get(message.id);
  if (seen === undefined) {
    table.byMessage.set(message.id, new Set([toolCallId]));
  } else {
    seen.add(toolCallId);
  }

  if (state.orphan) {
    table.orphanTools += 1;
  }

  return { state, created: true };
}

/** Build the public update for a changed state. */
function updateFor(state: TrackedTool): ToolBlockUpdate {
  return {
    messageId: state.messageId,
    block: {
      id: state.blockId,
      messageId: state.messageId,
      runId: state.runId,
      role: "tool",
      type: "tool_call",
      toolCallId: state.toolCallId,
      name: state.name,
      argumentsText: state.argumentsText,
      result: state.result,
      status: state.status,
      orphan: state.orphan,
    },
  };
}

/** `success`, `error` and `incomplete` are the states a call never leaves. */
function isTerminal(status: ToolStatus): boolean {
  return status === "success" || status === "error" || status === "incomplete";
}

/**
 * Whether a call message may move an existing call to the status it implies.
 *
 * The approval gate is sticky in one direction: a fragment message cannot claim
 * the call is running while approval is pending. An approval request may still
 * pull a call that only streamed its arguments back to waiting, but not one a
 * client start already proved executed. A client start is the one signal that
 * legitimately leaves the gate.
 */
function mayApplyStatus(kind: CallKind, state: TrackedTool): boolean {
  if (kind === "approval") {
    return !state.awaitingFinal;
  }
  if (kind === "fragment") {
    return state.status !== "awaiting_approval";
  }
  return true;
}

/**
 * Accept a JSON-object body. A source message normally carries an object, but a
 * payload stringified on the way in still has recognisable fields, so an
 * object-shaped string is parsed once and anything else is refused.
 */
function bodyOf(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("{")) {
      return null;
    }
    try {
      return recordOf(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return recordOf(value);
}

/** A plain object, or `null` for arrays and primitives. */
function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Every call a call-shaped body mentions. The engine uses a singular `tool_call`
 * for a streamed call, a `tool_calls` array for a batch, and sometimes puts the
 * fields at the top level; all three are accepted, and an id mentioned twice
 * collapses into one entry in body order.
 */
function callRefsOf(body: Record<string, unknown>): readonly CallRef[] {
  const refs = new Map<string, CallRef>();

  const single = recordOf(body.tool_call);
  if (single !== null) {
    addCallRef(refs, single);
  }

  if (Array.isArray(body.tool_calls)) {
    for (const raw of body.tool_calls) {
      const record = recordOf(raw);
      if (record !== null) {
        addCallRef(refs, record);
      }
    }
  }

  if (refs.size === 0) {
    addCallRef(refs, body);
  }

  return [...refs.values()];
}

/** Add one call if it has a usable id; the first mention of an id wins. */
function addCallRef(refs: Map<string, CallRef>, record: Record<string, unknown>): void {
  const toolCallId = firstString(record.tool_call_id, record.id);
  if (toolCallId === null || refs.has(toolCallId)) {
    return;
  }

  const fn = recordOf(record.function);
  refs.set(toolCallId, {
    toolCallId,
    name: firstString(record.name, fn === null ? null : fn.name),
    argumentsText: argumentsTextOf(record.arguments ?? record.tool_args ?? fn?.arguments),
  });
}

/** Coerce one arguments value into the raw text a card shows, verbatim. */
function argumentsTextOf(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "object") {
    try {
      const text = JSON.stringify(value);
      return text === undefined ? null : text;
    } catch {
      return null;
    }
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

/**
 * Every result a return body carries. The plural `tool_returns` array wins when
 * it has at least one usable entry; otherwise the deprecated singular top-level
 * fields are used. Each entry keeps its own call id, status and payload, so one
 * message can close several calls.
 */
function returnEntriesOf(body: Record<string, unknown>): readonly ReturnEntry[] {
  if (Array.isArray(body.tool_returns)) {
    const entries = body.tool_returns
      .map((raw) => returnEntryOf(recordOf(raw)))
      .filter((entry): entry is ReturnEntry => entry !== null);
    if (entries.length > 0) {
      return entries;
    }
  }

  const single = returnEntryOf(body);
  return single === null ? [] : [single];
}

/** One return entry, or `null` when it names no call. */
function returnEntryOf(record: Record<string, unknown> | null): ReturnEntry | null {
  if (record === null) {
    return null;
  }
  const toolCallId = firstString(record.tool_call_id);
  if (toolCallId === null) {
    return null;
  }
  const payload = payloadOf(record);
  return {
    toolCallId,
    status: statusOf(record.status),
    result: payload.value,
    hasResult: payload.present,
  };
}

/** The payload keys an engine result may use when `tool_return` is absent. */
const PAYLOAD_KEYS = ["stdout", "stderr", "error", "output", "return_value"] as const;

/**
 * The result payload of one return entry. `tool_return` is kept verbatim: an
 * array of parts keeps its image parts instead of being flattened into text. A
 * result that only has diagnostic fields keeps the whole entry, so nothing is
 * silently dropped.
 */
function payloadOf(record: Record<string, unknown>): { value: unknown; present: boolean } {
  if ("tool_return" in record) {
    return { value: record.tool_return === undefined ? null : record.tool_return, present: true };
  }
  for (const key of PAYLOAD_KEYS) {
    if (key in record) {
      return { value: record, present: true };
    }
  }
  return { value: null, present: false };
}

/** Only the two statuses a return may close with; anything else is not guessed. */
function statusOf(value: unknown): "success" | "error" | null {
  if (value === "success") {
    return "success";
  }
  if (value === "error") {
    return "error";
  }
  return null;
}

/** The first non-blank string among the candidates, or `null`. */
function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}
