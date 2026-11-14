#!/usr/bin/env node
/**
 * compaction - the context class: one short seed turn, then `compaction_prepare`
 * on the same conversation.
 *
 * A real summary needs a real model, so this class is the one most likely to
 * come back `success: false` with no `prepare_id`; the recording is still worth
 * keeping because it shows the failure shape. `compaction_commit` is left out on
 * purpose: `prepare_id` only exists when prepare succeeds, and a placeholder for
 * a missing field aborts the recorder instead of recording the failure.
 */
export const name = "compaction";
export const description =
  "Seed one turn then compaction_prepare; proves the prepare request/response and its usage statistics.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: false,
      body: { name: "A3 Compaction", model: "deepseek/deepseek-flash" },
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
  {
    type: "compaction_prepare",
    request_id: "r-4",
    conversation_id: "default",
    body: { agent_id: "{{r-2.agent.id}}" },
  },
];
export default { name, description, commands };
