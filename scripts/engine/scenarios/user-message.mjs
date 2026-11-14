#!/usr/bin/env node
/**
 * user-message - the plain conversation class: one runtime, one user message,
 * one assistant turn. Cheapest paid class.
 *
 * Signature frames: `input_accepted`, `stream_delta` (assistant_message),
 * `stream_delta` (usage_statistics), `stream_delta` (stop_reason: end_turn) and
 * `turn_finished`. The prompt stays tiny on purpose: this is a wire recording,
 * not a model benchmark.
 */
export const name = "user-message";
export const description =
  "One user message on a live runtime; proves input_accepted through usage_statistics to turn_finished.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: false,
      body: { name: "A3 User Message", model: "deepseek/deepseek-flash" },
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
      messages: [{ role: "user", content: "Reply with exactly one word: ok" }],
    },
  },
];
export default { name, description, commands };
