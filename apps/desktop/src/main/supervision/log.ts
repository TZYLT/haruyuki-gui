/**
 * The supervision listeners' log adapter.
 *
 * Supervision modules take a `(event, detail) => void` sink rather than a logger, so
 * they can be tested without one. This is the shell's answer: forward to the shell
 * logger when it exists, and never let logging throw -- supervision reports run at
 * boot and on the way out, where a throw from a log sink would replace the failure
 * being reported.
 *
 * It lives outside `main.ts` because `main.ts` is over the file-size gate and this is
 * a seam, not wiring.
 */

/** What supervision modules accept as a log sink. */
export type SupervisionLog = (event: string, detail?: Record<string, unknown>) => void;

/** The one method this adapter needs from the shell logger. */
export interface LogSink {
  info(event: string, detail?: Record<string, unknown>): void;
}

/**
 * Build the shell's supervision log sink.
 *
 * @param current the shell logger, read through a function because it is replaced at
 *   start and again at quit; a captured value would go stale
 */
export function createSupervisionLog(current: () => LogSink | null): SupervisionLog {
  return (event, detail) => {
    current()?.info(event, detail);
  };
}
