/**
 * Server-to-client message for the mini engine fixture.
 *
 * The `usage` member is optional and nested, so the message fingerprint covers
 * an object literal one level deep.
 */

export interface StreamDeltaMessage {
  type: "stream_delta";
  request_id: string;
  delta: string;
  usage?: {
    tokens: number;
    model?: string;
  };
}
