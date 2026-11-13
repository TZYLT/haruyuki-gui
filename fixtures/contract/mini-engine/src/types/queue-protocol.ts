/**
 * Namespace-declared command for the mini engine fixture.
 *
 * The union references it as `QueueProtocol.ResumeQueueCommand`, which is the
 * namespace-member form the extractor has to resolve.
 */
export namespace QueueProtocol {
  export interface ResumeQueueCommand {
    type: "queue_resume";
    request_id: string;
    queue_id: string;
  }
}
