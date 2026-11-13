/**
 * Dispatch switch for the mini engine fixture.
 *
 * The extractor only measures the switch whose expression is
 * `command.command_id`; three string-literal cases here.
 */

export interface RemoteCommandEnvelope {
  command_id: string;
}

export function handleExecuteCommand(command: RemoteCommandEnvelope): string {
  switch (command.command_id) {
    case "clear":
      return "clear:ok";
    case "compact":
      return "compact:ok";
    case "status":
      return "status:ok";
    default:
      return "unknown";
  }
}
