/**
 * Bidirectional `file_ops` shape for the mini engine fixture.
 *
 * The single interface is a member of both `WsProtocolCommand` and
 * `WsProtocolMessage`, mirroring the real engine: one declaration home, two
 * directions, and the `file_ops` special case stays visible in the snapshot.
 */

export interface FileOpsCommand {
  type: "file_ops";
  request_id: string;
  operations: Array<{
    path: string;
    mode?: string;
  }>;
}
