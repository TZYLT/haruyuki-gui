#!/usr/bin/env node
/**
 * approval - the permission class: set the device to `strict`, then make the
 * model call a tool so the engine stops at a `control_request` and waits.
 *
 * A static command list cannot answer that request: the permission id is
 * `perm-<toolCallId>` and the tool call id only exists once the turn has started.
 * The `decision` half therefore comes from the recorder's
 * `--auto-approve allow`, which reacts to the frame (the one place a recording
 * needs to), and the committed recording covers the whole round
 * trip: `control_request` -> c2s `approval_response` -> `client_tool_start` ->
 * `tool_return_message` -> `turn_finished`. Without the flag the same list stops
 * at the pending `control_request`.
 */
export const name = "approval";
export const description =
  "Strict permission mode then a Bash tool call; the recorder answers the control_request itself (--auto-approve allow), so the recording covers request, decision and tool return.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: false,
      body: { name: "A3 Approval", model: "deepseek/deepseek-flash" },
    },
    conversation_id: "default",
  },
  {
    type: "change_device_state",
    runtime: {
      agent_id: "{{r-2.runtime.agent_id}}",
      conversation_id: "default",
    },
    payload: { mode: "strict" },
  },
  {
    type: "input",
    request_id: "r-3",
    runtime: {
      agent_id: "{{r-2.runtime.agent_id}}",
      conversation_id: "default",
    },
    payload: {
      kind: "create_message",
      messages: [{ role: "user", content: "Use the Bash tool with command: echo a3-approval-ok" }],
    },
  },
];
export default { name, description, commands };
