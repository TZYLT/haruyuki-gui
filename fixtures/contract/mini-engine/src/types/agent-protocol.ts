/**
 * Agent commands for the mini engine fixture.
 *
 * `AgentListCommand` carries an optional field and one nested object literal so
 * the field-level extraction (`?`, nested shapes, fingerprints) is exercised.
 */

/** Union alias member of `WsProtocolCommand`; expands to two wire commands. */
export type AgentLifecycleCommand = AgentListCommand | AgentCancelCommand;

export interface AgentListCommand {
  type: "agent_list";
  request_id: string;
  limit?: number;
  filter?: {
    status: string;
    tag?: string;
  };
}

export interface AgentCancelCommand {
  type: "agent_cancel";
  request_id: string;
  agent_id: string;
}
