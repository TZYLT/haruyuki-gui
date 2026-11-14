#!/usr/bin/env node
/**
 * subagent - the delegation class: `launch_subagent` on a live runtime, then the
 * child run reports through `update_subagent_state`.
 *
 * Signature frames: `launch_subagent_response` with success, and at least one
 * `update_subagent_state` whose `subagents` array is non-empty. The child turn
 * is a one-word reply so the parent pays for exactly one small generation.
 */
export const name = "subagent";
export const description =
  "Launch a general-purpose subagent; proves launch_subagent_response and a non-empty update_subagent_state.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: false,
      body: { name: "A3 Subagent", model: "deepseek/deepseek-flash" },
    },
    conversation_id: "default",
  },
  {
    type: "launch_subagent",
    request_id: "r-3",
    runtime: {
      agent_id: "{{r-2.runtime.agent_id}}",
      conversation_id: "default",
    },
    args: {
      subagent_type: "general-purpose",
      prompt: "Reply with one word: sub-ok",
      description: "a3 subagent scenario",
    },
  },
];
export default { name, description, commands };
