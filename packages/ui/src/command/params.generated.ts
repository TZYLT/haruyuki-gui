/**
 * Command parameter table, generated from the contract snapshot.
 *
 * Do not edit by hand: `node scripts/generate-command-params.mjs` rewrites it,
 * and `--check` fails when it drifts from `snapshot.json`.
 */
import type { CapabilityName } from "@haruyuki/protocol";

/** Controls a parameter renders as; `value` means "open the detail panel". */
export type CommandParamKind =
  "string" | "boolean" | "number" | "enum" | "list" | "object" | "value";

export interface CommandParamSpec {
  readonly name: string;
  readonly kind: CommandParamKind;
  readonly required: boolean;
  readonly options?: readonly string[];
}

/**
 * Per-capability arguments, envelope fields excluded (`type`, `request_id`,
 * `runtime`). A capability with no arguments is absent, not empty.
 */
export const COMMAND_PARAMS = {
  "agent.create": [{ name: "body", kind: "value", required: true }],
  "agent.createPreset": [
    { name: "model", kind: "string", required: false },
    {
      name: "personality",
      kind: "enum",
      required: true,
      options: ["memo", "tutorial", "blank", "linus", "kawaii"],
    },
    { name: "pin_global", kind: "boolean", required: false },
    { name: "tags", kind: "list", required: false },
  ],
  "agent.delete": [{ name: "agent_id", kind: "string", required: true }],
  "agent.get": [{ name: "agent_id", kind: "string", required: true }],
  "agent.list": [{ name: "query", kind: "value", required: false }],
  "agent.secretApply": [
    { name: "agent_id", kind: "string", required: true },
    { name: "set", kind: "object", required: true },
    { name: "unset", kind: "list", required: true },
  ],
  "agent.secretList": [{ name: "agent_id", kind: "string", required: true }],
  "agent.update": [
    { name: "agent_id", kind: "string", required: true },
    { name: "body", kind: "value", required: true },
  ],
  "compaction.cancel": [
    { name: "conversation_id", kind: "string", required: true },
    { name: "prepare_id", kind: "string", required: true },
  ],
  "compaction.commit": [
    { name: "block_index", kind: "number", required: false },
    { name: "conversation_id", kind: "string", required: true },
    { name: "prepare_id", kind: "string", required: true },
  ],
  "compaction.prepare": [
    { name: "body", kind: "value", required: false },
    { name: "conversation_id", kind: "string", required: true },
  ],
  "conversation.create": [
    { name: "acting_user_id", kind: "string", required: false },
    { name: "body", kind: "value", required: true },
  ],
  "conversation.delete": [{ name: "conversation_id", kind: "string", required: true }],
  "conversation.fork": [
    { name: "acting_user_id", kind: "string", required: false },
    { name: "body", kind: "value", required: false },
    { name: "conversation_id", kind: "string", required: true },
  ],
  "conversation.get": [{ name: "conversation_id", kind: "string", required: true }],
  "conversation.list": [{ name: "query", kind: "value", required: false }],
  "conversation.recompile": [
    { name: "body", kind: "value", required: false },
    { name: "conversation_id", kind: "string", required: true },
  ],
  "conversation.switch": [
    { name: "agent_id", kind: "string", required: false },
    { name: "client_info", kind: "value", required: false },
    { name: "conversation_id", kind: "string", required: false },
    { name: "conversation_source_tags", kind: "list", required: false },
    { name: "create_agent", kind: "value", required: false },
    { name: "create_conversation", kind: "value", required: false },
    { name: "cwd", kind: "value", required: false },
    { name: "execution_settings", kind: "value", required: false },
    { name: "external_tools", kind: "list", required: false },
    { name: "force_device_status", kind: "boolean", required: false },
    { name: "mode", kind: "value", required: false },
    { name: "preserve_skill_sources", kind: "boolean", required: false },
    { name: "recover_approvals", kind: "boolean", required: false },
    {
      name: "skill_sources",
      kind: "enum",
      required: false,
      options: ["bundled", "global", "agent", "project"],
    },
    { name: "wait_for_replay", kind: "boolean", required: false },
    { name: "workspace_sandbox", kind: "object", required: false },
  ],
  "conversation.sync": [
    { name: "force_device_status", kind: "boolean", required: false },
    { name: "recover_approvals", kind: "boolean", required: false },
    { name: "resume_interrupted_turn", kind: "boolean", required: false },
  ],
  "conversation.update": [
    { name: "body", kind: "value", required: true },
    { name: "conversation_id", kind: "string", required: true },
  ],
  "device.setState": [{ name: "payload", kind: "value", required: true }],
  "file.edit": [
    { name: "expected_replacements", kind: "number", required: false },
    { name: "file_path", kind: "string", required: true },
    { name: "new_string", kind: "string", required: true },
    { name: "old_string", kind: "string", required: true },
    { name: "replace_all", kind: "boolean", required: false },
  ],
  "file.read": [
    { name: "encoding", kind: "enum", required: false, options: ["utf8", "base64"] },
    { name: "path", kind: "string", required: true },
  ],
  "file.unwatch": [{ name: "path", kind: "string", required: true }],
  "file.watch": [{ name: "path", kind: "string", required: true }],
  "file.write": [
    { name: "content", kind: "string", required: true },
    { name: "path", kind: "string", required: true },
  ],
  "git.checkoutBranch": [
    { name: "branch", kind: "string", required: true },
    { name: "create", kind: "boolean", required: false },
    { name: "cwd", kind: "string", required: false },
  ],
  "git.searchBranches": [
    { name: "cwd", kind: "string", required: false },
    { name: "max_results", kind: "number", required: false },
    { name: "query", kind: "string", required: true },
  ],
  "memory.commitDiff": [
    { name: "agent_id", kind: "string", required: true },
    { name: "sha", kind: "string", required: true },
  ],
  "memory.deleteFile": [
    { name: "agent_id", kind: "string", required: true },
    { name: "commit_message", kind: "string", required: false },
    { name: "path", kind: "string", required: true },
  ],
  "memory.enable": [{ name: "agent_id", kind: "string", required: true }],
  "memory.fileAtRef": [
    { name: "agent_id", kind: "string", required: true },
    { name: "file_path", kind: "string", required: true },
    { name: "ref", kind: "string", required: true },
  ],
  "memory.history": [
    { name: "agent_id", kind: "string", required: true },
    { name: "file_path", kind: "string", required: false },
    { name: "limit", kind: "number", required: false },
  ],
  "memory.list": [
    { name: "agent_id", kind: "string", required: true },
    { name: "include_references", kind: "boolean", required: false },
  ],
  "memory.readFile": [
    { name: "agent_id", kind: "string", required: true },
    { name: "encoding", kind: "enum", required: false, options: ["utf8", "base64"] },
    { name: "path", kind: "string", required: true },
  ],
  "memory.writeFile": [
    { name: "agent_id", kind: "string", required: true },
    { name: "commit_message", kind: "string", required: false },
    { name: "content", kind: "string", required: true },
    { name: "encoding", kind: "enum", required: false, options: ["utf8", "base64"] },
    { name: "path", kind: "string", required: true },
  ],
  "message.abort": [{ name: "run_id", kind: "value", required: false }],
  "message.list": [
    { name: "conversation_id", kind: "string", required: true },
    { name: "query", kind: "value", required: false },
  ],
  "message.send": [{ name: "payload", kind: "value", required: true }],
  "model.list": [{ name: "force", kind: "boolean", required: false }],
  "model.update": [{ name: "payload", kind: "value", required: true }],
  "provider.connect": [
    { name: "auth_method_id", kind: "string", required: false },
    { name: "fields", kind: "object", required: true },
    { name: "oauth_config", kind: "value", required: false },
    { name: "provider_id", kind: "string", required: true },
    { name: "provider_name", kind: "string", required: false },
    { name: "target", kind: "value", required: true },
  ],
  "provider.disconnect": [
    { name: "provider_id", kind: "string", required: true },
    { name: "provider_name", kind: "string", required: false },
    { name: "target", kind: "value", required: true },
  ],
  "provider.listConnected": [{ name: "target", kind: "value", required: true }],
  "queue.remove": [{ name: "item_id", kind: "string", required: true }],
  "queue.stopMonitor": [{ name: "process_id", kind: "string", required: true }],
  "settings.setExperiment": [
    { name: "enabled", kind: "boolean", required: true },
    { name: "experiment_id", kind: "value", required: true },
  ],
  "settings.setReflection": [
    { name: "scope", kind: "value", required: false },
    { name: "settings", kind: "object", required: true },
  ],
  "slash.exec": [
    { name: "args", kind: "string", required: false },
    { name: "command_id", kind: "string", required: true },
  ],
  "subagent.launch": [
    { name: "args", kind: "value", required: true },
    { name: "tool_call_id", kind: "string", required: false },
  ],
  "terminal.input": [
    { name: "data", kind: "string", required: true },
    { name: "terminal_id", kind: "string", required: true },
  ],
  "terminal.kill": [{ name: "terminal_id", kind: "string", required: true }],
  "terminal.resize": [
    { name: "cols", kind: "number", required: true },
    { name: "rows", kind: "number", required: true },
    { name: "terminal_id", kind: "string", required: true },
  ],
  "terminal.spawn": [
    { name: "cols", kind: "number", required: true },
    { name: "cwd", kind: "string", required: false },
    { name: "rows", kind: "number", required: true },
    { name: "terminal_id", kind: "string", required: true },
  ],
  "toolset.update": [{ name: "toolset_preference", kind: "value", required: true }],
  "usage.aggregate": [
    { name: "agent_id", kind: "string", required: true },
    { name: "from", kind: "string", required: false },
    { name: "run_id", kind: "string", required: false },
    { name: "session_id", kind: "string", required: false },
    { name: "to", kind: "string", required: false },
  ],
  "usage.chatgpt": [
    { name: "force_refresh", kind: "boolean", required: false },
    { name: "provider_name", kind: "string", required: false },
    { name: "target", kind: "value", required: true },
  ],
  "workspace.grep": [
    { name: "case_sensitive", kind: "boolean", required: false },
    { name: "context_lines", kind: "number", required: false },
    { name: "cwd", kind: "string", required: false },
    { name: "glob", kind: "string", required: false },
    { name: "is_regex", kind: "boolean", required: false },
    { name: "max_results", kind: "number", required: false },
    { name: "query", kind: "string", required: true },
    { name: "whole_word", kind: "boolean", required: false },
  ],
  "workspace.list": [
    { name: "include_files", kind: "boolean", required: false },
    { name: "limit", kind: "number", required: false },
    { name: "offset", kind: "number", required: false },
    { name: "path", kind: "string", required: true },
  ],
  "workspace.search": [
    { name: "cwd", kind: "string", required: false },
    { name: "max_results", kind: "number", required: false },
    { name: "query", kind: "string", required: true },
  ],
  "workspace.setBootCwd": [{ name: "cwd", kind: "string", required: true }],
  "workspace.tree": [
    { name: "depth", kind: "number", required: true },
    { name: "path", kind: "string", required: true },
  ],
} as const satisfies Partial<Record<CapabilityName, readonly CommandParamSpec[]>>;
