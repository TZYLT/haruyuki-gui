#!/usr/bin/env node
/**
 * terminal - cheapest conversation class: a real terminal with zero assembly.
 *
 * Proof: `terminal_spawn` needs no agent, no conversation
 * and no provider. Signature frames are `terminal_spawned`, `terminal_output`
 * (raw, no envelope) and `terminal_exited`. `cwd` is deliberately omitted so the
 * command list stays portable - the engine falls back to its own run directory.
 */
export const name = "terminal";
export const description =
  "Spawn a terminal and run one echo command; proves raw terminal frames without a runtime scope.";
export const commands = [
  { type: "app_server_info", request_id: "r-1" },
  { type: "terminal_spawn", terminal_id: "a3-term-1", cols: 80, rows: 24 },
  { type: "terminal_input", terminal_id: "a3-term-1", data: "echo a3-terminal-ok\r" },
  { type: "terminal_input", terminal_id: "a3-term-1", data: "exit\r" },
];
export default { name, description, commands };
