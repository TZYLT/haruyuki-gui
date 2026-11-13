/**
 * Remote-command parity constants for the mini engine fixture.
 *
 * Three / one / one entries, mirroring the real engine's three constants. The
 * values are remote-command ids, not wire ids; the snapshot keeps them apart.
 */

export const SUPPORTED_REMOTE_COMMANDS = ["clear", "compact", "status"] as const;

export const REMOTE_COMMANDS_HANDLED_ELSEWHERE: Record<string, string> = {
  toolset: "the toolset service owns this command",
};

export const UNADVERTISED_REMOTE_COMMAND_ALIASES: Record<string, string> = {
  "set-max-context": "kept for older clients, no longer advertised",
};
