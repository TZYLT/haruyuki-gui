#!/usr/bin/env node
/**
 * approval - the permission class: set the device to `strict`, then make the
 * model call a tool so the engine emits a `control_request` and blocks.
 *
 * What this list can and cannot prove: a static command list cannot answer the
 * request, because the permission request id is `perm-<toolCallId>` and the tool
 * call id only exists after the turn starts. So the recording ends with the
 * `control_request` pending (signature frames: `update_device_status` showing
 * `current_permission_mode: "strict"` plus `control_request`). Sending the
 * `allow` decision needs a recorder that reacts to frames, which `record.mjs`
 * deliberately is not , so the corpus 2.6 notes 2).
 */
export const name = "approval";
export const description =
  "Strict permission mode then a Bash tool call; proves the control_request gate (allow needs a reactive driver).";
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
