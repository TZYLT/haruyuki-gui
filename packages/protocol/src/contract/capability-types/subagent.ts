/**
 * Capability IO for the `subagent` family.
 *
 * One capability. Its reply is a discriminated result on `success`: a launch
 * either reports where the task landed or why it could not start.
 */

import type { SubagentLaunchArgs, SubagentLaunchResult } from "./engine-domain.js";

export interface SubagentLaunchInput {
  readonly args: SubagentLaunchArgs;
  readonly tool_call_id?: string;
}

export type SubagentLaunchOutput = SubagentLaunchResult;

export interface SubagentIo {
  readonly "subagent.launch": {
    readonly input: SubagentLaunchInput;
    readonly output: SubagentLaunchOutput;
  };
}
