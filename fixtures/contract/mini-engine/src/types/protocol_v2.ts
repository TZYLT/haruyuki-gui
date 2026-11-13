/**
 * Mini protocol surface for the contract gate fixtures.
 *
 * The shapes mirror the real engine closely enough for the frozen extractors
 * (`extract-commands.mjs`, `extract-messages.mjs`, `extract-parity.mjs`) to
 * parse this tree without any special casing:
 *
 *   WsProtocolCommand  3 members -> 4 wire commands, because one member is a
 *                      union alias (`AgentLifecycleCommand = A | B`) and one is
 *                      a namespace member (`QueueProtocol.ResumeQueueCommand`).
 *   WsProtocolMessage  2 members -> 2 wire messages, one of them `file_ops`
 *                      (so the bidirectional special case stays visible).
 */

import type { AgentLifecycleCommand } from "./agent-protocol";
import type { FileOpsCommand } from "./file-ops-protocol";
import type { StreamDeltaMessage } from "./message-protocol";
import type { QueueProtocol } from "./queue-protocol";

/** Union of every client-to-server command the mini engine understands. */
export type WsProtocolCommand =
  | AgentLifecycleCommand
  | QueueProtocol.ResumeQueueCommand
  | FileOpsCommand;

/**
 * Union of every server-to-client message the mini engine emits.
 *
 * `FileOpsCommand` is a member of both unions on purpose: the real engine does
 * the same, and that shared declaration home is what makes the `file_ops`
 * command bidirectional in the snapshot.
 */
export type WsProtocolMessage = StreamDeltaMessage | FileOpsCommand;
