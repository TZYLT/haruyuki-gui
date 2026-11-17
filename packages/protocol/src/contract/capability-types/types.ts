/**
 * The typed side of the capability layer.
 *
 * One row per capability name, shaped `{ input; output }`. The rows live in the
 * per-domain modules next to this file so that a domain work package owns its
 * own file; this module only composes them and derives the two public aliases
 * `CommandCall`/`CommandReply` need.
 *
 * Why the rows are `unknown` until a domain lands: the composition is additive
 * while the item is under construction. `RowOf` falls back to `unknown` for a
 * capability whose domain has not been typed yet, so the package keeps
 * compiling between work packages. The exhaustive check that turns "a capability
 * with no row" into a compile error lands with the gates work package
 * (`capability-types.test-d.ts`), not here — a permanent red typecheck would
 * make every intermediate wave look broken.
 */

import type { CapabilityName } from "../command-map.generated.js";

import type { AgentIo } from "./agent.js";
import type { CompactionIo } from "./compaction.js";
import type { ConversationIo } from "./conversation.js";
import type { DeviceIo } from "./device.js";
import type { FileIo } from "./file.js";
import type { GitIo } from "./git.js";
import type { MemoryIo } from "./memory.js";
import type { MessageIo } from "./message.js";
import type { ModelIo } from "./model.js";
import type { ProviderIo } from "./provider.js";
import type { QueueIo } from "./queue.js";
import type { SettingsIo } from "./settings.js";
import type { SlashIo } from "./slash.js";
import type { SubagentIo } from "./subagent.js";
import type { TerminalIo } from "./terminal.js";
import type { ToolsetIo } from "./toolset.js";
import type { UsageIo } from "./usage.js";
import type { WorkspaceIo } from "./workspace.js";

/**
 * One capability's IO. `R` is what a domain module puts in its row; the two
 * aliases below read it back.
 */
export interface CapabilityIo<Input, Output> {
  readonly input: Input;
  readonly output: Output;
}

/**
 * Every typed row, composed by intersection. Adding a domain file adds its rows
 * without touching any other file; `capability-types.test-d.ts` proves the
 * result covers `CapabilityName`.
 */
export type CapabilityIoTypes = AgentIo &
  CompactionIo &
  ConversationIo &
  DeviceIo &
  FileIo &
  GitIo &
  MemoryIo &
  MessageIo &
  ModelIo &
  ProviderIo &
  QueueIo &
  SettingsIo &
  SlashIo &
  SubagentIo &
  TerminalIo &
  ToolsetIo &
  UsageIo &
  WorkspaceIo;

/**
 * The row for one capability, or the `unknown` placeholder while its domain is
 * still untyped. `C & keyof ...` is what lets TypeScript index the intersection
 * under the conditional.
 */
type RowOf<C extends CapabilityName> = C extends keyof CapabilityIoTypes
  ? CapabilityIoTypes[C & keyof CapabilityIoTypes]
  : CapabilityIo<unknown, unknown>;

/** The body an E1 `CommandCall<C>` must carry for capability `C`. */
export type CapabilityInput<C extends CapabilityName> = RowOf<C>["input"];

/** The `answered.data` an E1 `CommandReply<C>` carries for capability `C`. */
export type CapabilityOutput<C extends CapabilityName> = RowOf<C>["output"];

/**
 * Exhaustiveness guard.
 *
 * Type-level only: no runtime export, no value to keep alive. `_Check<T>` only
 * accepts `true`, so a missing capability row (or an extra row that is not a
 * capability) turns this into a compile error the moment a domain is added.
 */
type _Check<T extends true> = T;

/** Every `CapabilityName` has a row. */
type _AllPresent = _Check<CapabilityName extends keyof CapabilityIoTypes ? true : false>;

/** No row exists that is not a capability. */
type _NoExtras = _Check<
  Exclude<keyof CapabilityIoTypes, CapabilityName> extends never ? true : false
>;

export type { _AllPresent, _NoExtras };
