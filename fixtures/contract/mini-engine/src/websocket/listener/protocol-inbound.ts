/**
 * Inbound OR chain for the mini engine fixture.
 *
 * Three guards, each named `is<TypeName>`; the extractor reverse-looks them up
 * in the `src/types` index, which is how the real engine resolves them too.
 */

import type {
  AgentListCommand,
  AgentCancelCommand,
} from "../../types/agent-protocol";
import type { QueueProtocol } from "../../types/queue-protocol";
import type { WsProtocolCommand } from "../../types/protocol_v2";

export function parseServerMessage(value: unknown): WsProtocolCommand | null {
  if (isAgentListCommand(value)) {
    return value as AgentListCommand;
  }

  if (isAgentCancelCommand(value)) {
    return value as AgentCancelCommand;
  }

  if (isResumeQueueCommand(value)) {
    return value as QueueProtocol.ResumeQueueCommand;
  }

  return null;
}
