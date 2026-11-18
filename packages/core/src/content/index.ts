/**
 * The conversation content model's public surface.
 *
 * One import for the shapes, the pure helpers and the facade that turns the
 * merger's changes into block updates. The layer marker is a local declaration
 * on purpose: this repository refuses pure forwarding modules, because a
 * barrel hides the real dependency edge.
 *
 * What is exported is the contract other items consume: the block update
 * envelope and the model interface. The individual parsers are exported too
 * because the history path and the tests drive them directly, but a consumer
 * that only renders blocks should depend on `createContentModel` and the
 * protocol's `Block` union.
 */
export const CONTENT_LAYER = "core" as const;

export type {
  ContentModel,
  ContentModelOptions,
  ContentStats,
  FenceState,
  MessageState,
  SourceDelta,
  SourceMessage,
  ToolState,
} from "./types.js";
export {
  blockIdFor,
  contentKey,
  DEFAULT_MAX_IN_FLIGHT_MESSAGES,
  DEFAULT_MAX_TOOLS_PER_MESSAGE,
  makeToolBlockId,
  normalizeLimit,
  reasoningBlockId,
} from "./types.js";

export type { FenceSegment } from "./fence.js";
export { createFenceState, feedFence, finishFence, scanFence } from "./fence.js";

export type { MessageIdentity } from "./blocks.js";
export { appendText, createMessageState } from "./blocks.js";

export type { MessageDeltaChange, MessageFinalChange } from "./adapter.js";
export {
  completeMessage,
  createDeltaState,
  createMessageStateFor,
  ingestDelta,
  removedBlockIds,
  resetMessage,
  roleForMessageType,
  toSourceDelta,
  toSourceMessage,
} from "./adapter.js";

export type { PartSlot, PartsCursor } from "./parts.js";
export { appendParts, createPartsCursor } from "./parts.js";

export type {
  ToolBlockUpdate,
  ToolTable,
  ToolTableOptions,
  ToolTableStats,
  TrackedTool,
} from "./tools.js";
export {
  clearTools,
  createToolTable,
  incompleteForRun,
  ingestToolMessage,
  releaseToolMessage,
  toolStats,
} from "./tools.js";

export type { ReasoningAggregator, ReasoningBlockUpdate, ReasoningSegment } from "./reasoning.js";
export { clearReasoning, createReasoningAggregator, ingestReasoning } from "./reasoning.js";

export type { NoticeSpan, TaskNotificationSpan, TextSpan } from "./notice.js";
export { extractNotifications, parseUserContent, stripReminders } from "./notice.js";

export { sanitizeBlock, sanitizeUpdate, toJsonSafe } from "./sanitize.js";

export { parseHistoryPage } from "./history.js";

export { createContentModel } from "./model.js";
