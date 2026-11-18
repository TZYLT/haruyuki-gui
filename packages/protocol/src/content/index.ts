/**
 * The content contract exported as one unit.
 *
 * This module exists so consumers have a single specifier for blocks and the
 * update envelope. It keeps a local declaration of its own: this repository
 * refuses pure forwarding modules, because a barrel hides the real dependency
 * edge. The marker states which layer owns the contract, not a runtime switch.
 */
export const CONTENT_TYPES_LAYER = "protocol" as const;

export type {
  Block,
  BlockBase,
  BlockId,
  BlockRole,
  BlockStatus,
  BlockType,
  CodeBlock,
  ContentUpdate,
  ErrorBlock,
  ImageBlock,
  ImageSource,
  NoticeBlock,
  ReasoningBlock,
  TextBlock,
  ToolCallBlock,
  ToolStatus,
  UnknownBlock,
} from "./types.js";
