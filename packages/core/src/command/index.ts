/**
 * The command layer's public surface: the envelope types, the validation
 * predicates and the dispatcher the shell calls.
 *
 * This is deliberately not a pure forwarding module: `COMMAND_LAYER` is a real
 * local declaration, which keeps the barrel gate's ownership question answered
 * here rather than hidden behind a nameless `export *` chain (the same reason
 * `LAYOUT_LAYER` and `MERGE_LAYER` exist).
 */
export const COMMAND_LAYER = "core/command" as const;

export { COMMAND_LAYER_ERROR_CODES } from "./types.js";
export type {
  CommandCall,
  CommandErrorCode,
  CommandLayerErrorCode,
  CommandReply,
} from "./types.js";

export {
  ENVELOPE_BODY_KEYS,
  findEnvelopeBodyKeys,
  isNonEmptyString,
  isPlainRecord,
  isRuntimeScope,
} from "./validate.js";

export { CONTROL_AGENT_ID, createCommandDispatcher } from "./dispatch.js";
export type {
  CommandDispatcher,
  CommandDispatcherOptions,
  CommandSendChannel,
} from "./dispatch.js";
