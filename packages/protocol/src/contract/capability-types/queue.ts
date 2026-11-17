/**
 * Capability IO for the `queue` family.
 *
 * `queue.stopMonitor` is runtime-scoped: its reply echoes the process it
 * stopped, which is the only confirmation that the monitor is gone.
 */

export interface QueueRemoveInput {
  readonly item_id: string;
}

export type QueueResumeInput = Record<never, never>;

export interface QueueStopMonitorInput {
  readonly process_id: string;
}

export interface QueueRemoveOutput {
  readonly item_id: string;
}

export interface QueueResumeOutput {
  /** Number of queue items released by this command. */
  readonly resumed: number;
}

export interface QueueStopMonitorOutput {
  readonly process_id: string;
  readonly stopped: boolean;
}

export interface QueueIo {
  readonly "queue.remove": { readonly input: QueueRemoveInput; readonly output: QueueRemoveOutput };
  readonly "queue.resume": { readonly input: QueueResumeInput; readonly output: QueueResumeOutput };
  readonly "queue.stopMonitor": {
    readonly input: QueueStopMonitorInput;
    readonly output: QueueStopMonitorOutput;
  };
}
