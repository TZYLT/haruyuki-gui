#!/usr/bin/env node
/**
 * memory - the memfs memory class: list, read, write, plus the `memory_updated`
 * broadcasts that carry no runtime envelope.
 *
 * `create_agent.memfs` is true so the agent owns a memory repository; the model
 * is named but never called, so this class costs no provider tokens.
 */
export const name = "memory";
export const description =
  "List, read and write memory files on a memfs agent; proves the three responses plus envelope-less memory_updated.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  {
    type: "runtime_start",
    request_id: "r-2",
    create_agent: {
      memfs: true,
      body: { name: "A3 Memory", model: "deepseek/deepseek-flash" },
    },
    conversation_id: "default",
  },
  { type: "list_memory", request_id: "r-3", agent_id: "{{r-2.agent.id}}" },
  {
    type: "read_memory_file",
    request_id: "r-4",
    agent_id: "{{r-2.agent.id}}",
    path: "MEMORY.md",
  },
  {
    type: "write_memory_file",
    request_id: "r-5",
    agent_id: "{{r-2.agent.id}}",
    path: "MEMORY.md",
    content: "# Memory\n\n- a3 memory scenario\n",
    encoding: "utf8",
    commit_message: "a3 memory scenario",
  },
];
export default { name, description, commands };
