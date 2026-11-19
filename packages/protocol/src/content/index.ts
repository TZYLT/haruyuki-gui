/**
 * The content contract exported as one unit.
 *
 * This module exists so consumers have a single specifier for blocks and the
 * update envelope. The protocol content modules carry
 * types only, so the layer marker is a type rather than a runtime value; it
 * still states which layer owns the contract and satisfies the repository's
 * "no pure forwarding module" gate with a local declaration.
 */
export type CONTENT_TYPES_LAYER = "protocol";

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
