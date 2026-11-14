/**
 * The shell's log: one JSON line per event, one file per day.
 *
 * The format decisions here are the ones D4 builds rotation and the diagnostic
 * bundle on, so they are stated rather than assumed:
 *
 *   JSONL, not pretty-printed JSON. A log is appended to and read by tools; a
 *   document that has to be re-serialised to be read is a document that is lost
 *   when the process dies mid-write.
 *
 *   One file per day, named by UTC date. A local date would make two files with
 *   the same name in the same hour twice a year; UTC never repeats.
 *
 *   The directory comes from `app.getPath("logs")` and nowhere else. D2 needs the
 *   same path for its own logs and must call this function rather than rebuild
 *   it, or a diagnostic bundle will miss half the story.
 *
 * What this module does NOT do: rotation, retention, redaction and bundling. All
 * four belong to D4. Writing them here would mean two owners for one policy.
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** The levels a log line may carry, narrowest first. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** One line of the log. */
export interface LogRecord {
  /** ISO 8601 with milliseconds, UTC. */
  time: string;
  level: LogLevel;
  /** Short stable identifier, e.g. `shell.start`. Not a sentence. */
  event: string;
  /** Structured detail. Values are JSON-serialisable. */
  detail?: Record<string, unknown>;
}

/**
 * The log file for a UTC date.
 *
 * @param logDir `app.getPath("logs")`
 * @param at the instant to name the file for
 */
export function logFilePath(logDir: string, at: Date): string {
  // `toISOString` yields `2026-11-14T13:45:00.000Z`; the date part is the UTC day.
  const day = at.toISOString().slice(0, 10);

  return path.join(logDir, `shell-${day}.jsonl`);
}

/**
 * Serialise one record as a single line.
 *
 * Newlines inside a detail value would break the one-record-per-line contract,
 * so the serialiser is the place that guarantees it: `JSON.stringify` escapes
 * them, and the assertion below catches the case where it did not.
 *
 * @param record the record to serialise
 * @throws never -- an unserialisable detail is replaced rather than thrown, so a
 *   logging call cannot take down the caller
 */
export function formatRecord(record: LogRecord): string {
  const line: LogRecord = {
    time: record.time,
    level: record.level,
    event: record.event,
  };

  if (record.detail !== undefined) {
    try {
      // Round-trip through JSON to drop functions and cycles from the detail
      // before it reaches the file, rather than throwing at `JSON.stringify`.
      line.detail = JSON.parse(JSON.stringify(record.detail)) as Record<string, unknown>;
    } catch {
      line.detail = { unserialisable: true };
    }
  }

  const serialised = JSON.stringify(line);

  // Belt and braces: a value that survived the round trip but still contains a
  // raw newline would split one record into two unparseable halves.
  return serialised.replace(/[\r\n]+/g, "\\n");
}

/** What the logger needs from its environment, so a test can supply a directory. */
export interface LoggerOptions {
  /** Absolute log directory. */
  readonly logDir: string;
  /** Minimum level to write. Defaults to `info`. */
  readonly minLevel?: LogLevel;
  /** Clock, injected so a test can name a file without waiting for midnight. */
  readonly now?: () => Date;
}

/** A logger bound to one directory. */
export interface Logger {
  debug(event: string, detail?: Record<string, unknown>): void;
  info(event: string, detail?: Record<string, unknown>): void;
  warn(event: string, detail?: Record<string, unknown>): void;
  error(event: string, detail?: Record<string, unknown>): void;
  /** Resolve when every write issued so far has finished. */
  flush(): Promise<void>;
}

/**
 * Order levels so `minLevel` is a comparison rather than a lookup table.
 *
 * @param level the level to rank
 */
function rank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/**
 * Create a logger.
 *
 * Writes are serialised through one promise chain. Two concurrent appends to the
 * same file can interleave bytes on Windows, and an interleaved JSONL file is
 * unparseable from the point of corruption onward -- which is exactly the moment
 * someone is reading it to find out what happened.
 *
 * @param options directory, minimum level and clock
 */
export function createLogger(options: LoggerOptions): Logger {
  const { logDir, minLevel = "info", now = () => new Date() } = options;
  const threshold = rank(minLevel);

  let ready: Promise<void> | null = null;
  let queue: Promise<void> = Promise.resolve();

  function ensureDir(): Promise<void> {
    ready ??= mkdir(logDir, { recursive: true }).then(() => undefined);
    return ready;
  }

  function write(level: LogLevel, event: string, detail?: Record<string, unknown>): void {
    if (rank(level) < threshold) return;

    const at = now();
    const record: LogRecord = { time: at.toISOString(), level, event };

    if (detail !== undefined) record.detail = detail;

    const line = formatRecord(record) + "\n";
    const file = logFilePath(logDir, at);

    queue = queue
      .then(ensureDir)
      .then(() => appendFile(file, line, "utf8"))
      .catch(() => {
        // A log write that fails must not fail the caller. The alternative --
        // surfacing it -- turns "the disk is full" into "the app crashed", and
        // the app crashing is not more diagnosable than the missing line.
      });
  }

  return {
    debug: (event, detail) => write("debug", event, detail),
    info: (event, detail) => write("info", event, detail),
    warn: (event, detail) => write("warn", event, detail),
    error: (event, detail) => write("error", event, detail),
    flush: () => queue,
  };
}
