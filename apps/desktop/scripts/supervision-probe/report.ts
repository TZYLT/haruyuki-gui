/**
 * Printed judgments and the shell-log sink.
 *
 * One place decides the line shape the smoke script parses, so a check cannot
 * invent a second dialect and the smoke cannot silently skip an id. `recordOnce`
 * exists because a scenario's normal path and its `catch` can both reach the same
 * id; the first answer wins.
 */

const outcomes: { id: string; status: "PASS" | "FAIL" | "SKIP"; detail: string }[] = [];

/** Log lines the production modules emitted, for assertions about events. */
const shellLog: { event: string; detail?: Record<string, unknown> }[] = [];

/**
 * Record and print one outcome.
 *
 * Printing immediately (rather than after all checks) is what makes a hang
 * diagnosable: the lines before it say which check was running.
 *
 * @param id the requirement id
 * @param status PASS, FAIL or SKIP
 * @param detail measured facts, or the reason it failed
 */
function record(id: string, status: "PASS" | "FAIL" | "SKIP", detail: string): void {
  outcomes.push({ id, status, detail });
  process.stdout.write(`${status} ${id} ${detail}\n`);
}

/**
 * Record an outcome once; later attempts at the same id are ignored.
 *
 * @param id the requirement id
 * @param status PASS, FAIL or SKIP
 * @param detail measured facts, or the reason it failed
 */
function recordOnce(id: string, status: "PASS" | "FAIL" | "SKIP", detail: string): void {
  if (outcomes.some((outcome) => outcome.id === id)) return;

  record(id, status, detail);
}

/** Print an observation that is not a judgment. */
function info(detail: string): void {
  process.stdout.write(`INFO ${detail}\n`);
}

/** Describe an unknown thrown value without throwing again. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;

  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

/** The shell's log sink for production modules that take one. */
function logSink(event: string, detail?: Record<string, unknown>): void {
  shellLog.push(detail === undefined ? { event } : { event, detail });
}

/** Whether the shell log contains an event. */
function logged(event: string): boolean {
  return shellLog.some((entry) => entry.event === event);
}

export { describe, info, logged, logSink, outcomes, record, recordOnce, shellLog };
