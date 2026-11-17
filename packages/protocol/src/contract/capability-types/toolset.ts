/**
 * Capability IO for the `toolset` family.
 *
 * `toolset.update` switches the harness preset for a runtime and answers with
 * both the concrete toolset name and the preference that produced it.
 */

import type { ToolsetName, ToolsetPreference } from "./engine-domain.js";

export interface ToolsetUpdateInput {
  readonly toolset_preference: ToolsetPreference;
}

export interface ToolsetUpdateOutput {
  readonly current_toolset?: ToolsetName;
  readonly current_toolset_preference?: ToolsetPreference;
}

export interface ToolsetIo {
  readonly "toolset.update": {
    readonly input: ToolsetUpdateInput;
    readonly output: ToolsetUpdateOutput;
  };
}
