#!/usr/bin/env node
/**
 * tool-call - the model-driven tool class: one user message that makes the model
 * call a real tool, so the recording carries the tool call inside
 * `approval_request_message.tool_call`, an automatic `approval_classification_end`,
 * `client_tool_start`, and `tool_return_message`. Engine 0.6.0 has
 * no separate `tool_call_message`; that frame name is not part of the protocol.
 *
 * The default permission mode is `unrestricted`, so the Bash tool runs without an
 * approval round trip - that is the `approval` class.
 */
export const name = "tool-call";
export const description =
  "One user message that triggers a Bash tool call; proves approval_request_message -> client_tool_start -> tool_return_message.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: false,
      body: { name: "A3 Tool Call", model: "deepseek/deepseek-flash" },
    },
    conversation_id: "default",
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
      messages: [{ role: "user", content: "Use the Bash tool with command: echo a3-tool-ok" }],
    },
  },
];
export default { name, description, commands };
