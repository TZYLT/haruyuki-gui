#!/usr/bin/env node
/**
 * tool-call - the model-driven tool class: one user message that makes the model
 * call a real tool, so the recording carries `tool_call_message` followed by
 * `tool_return_message` , so the corpus 2.6 "tool call").
 *
 * The default permission mode is `unrestricted`, so the Bash tool runs without an
 * approval round trip - that is the `approval` class.
 */
export const name = "tool-call";
export const description =
  "One user message that triggers a Bash tool call; proves tool_call_message and tool_return_message in stream_delta.";
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
