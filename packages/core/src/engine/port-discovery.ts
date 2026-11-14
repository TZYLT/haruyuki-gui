/**
 * Port discovery: read the engine's WebSocket URL out of stdout.
 *
 * Shape source: no recursive-B1 section 2.2 (F-6/F-7/F-8), section 3.1
 * (`port-discovery.ts`: stdout parsing plus the 10 s timeout), section 3.3 (f)
 * (`PORT_NOT_FOUND` when no matching line arrives) and section 8 invariant 3
 * ("do not guess the port"). This module therefore *only* parses strings: it
 * never connects, never probes and never scans a port range.
 *
 * The engine (`haruyuki.js server --listen ws://127.0.0.1:0 ...`) prints two
 * lines once the server is up:
 *
 *     Listening on ws://127.0.0.1:6387
 *     WebSocket: ws://127.0.0.1:6387/ws
 *
 * Only the second line is the client endpoint: the first one is the listen
 * address without the `/ws` path, and `--openai-api` adds an `OpenAI:` line that
 * also carries a `ws://` URL, so neither may be accepted (F-6). Ports are
 * assigned by the system (F-7) and 0.6.0 has no `ws-url-file` (F-8), which makes
 * this stdout parse the only discovery path.
 *
 * Reading rules, all of which exist because stdout is a byte stream and not a
 * list of lines:
 * - data events may cut a line in half, so the tail after the last `\n` is kept
 *   as pending text and joined with the next chunk;
 * - both `\n` and `\r\n` line endings are accepted;
 * - empty and unrelated lines are ignored but still counted, so a timeout can
 *   report how much output was seen;
 * - a final line without a trailing newline is flushed when the stream ends.
 *
 * Failure is local: this file raises `PortNotFoundError` with
 * `code = "PORT_NOT_FOUND"`. Mapping it onto the frozen `EngineErrorCode`
 * taxonomy (and onto `EngineError`) belongs to the facade (`engine.ts`,
 * which owns that shared contract.
 */

import { StringDecoder } from "node:string_decoder";

/** Default wait for the `WebSocket:` line: 10 s. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** How much of the last seen line is kept in a failure detail. */
const MAX_LAST_LINE_CHARS = 200;

/**
 * The only accepted line shape (F-6).
 *
 * Anchored at both ends, so `Listening on ws://...` and `OpenAI: ws://...` can
 * never match. `\S+` stops at the first whitespace and `$` then requires the end
 * of the string, which is what keeps a trailing space from being swallowed: the
 * URL must end the line exactly. A trailing `\r` is removed before matching, so
 * `\r\n` streams work too.
 */
const WS_URL_LINE = /^WebSocket:\s+(ws:\/\/\S+)$/;

/**
 * Parse one already-split stdout line.
 *
 * Pure: no I/O, no state, no clock. Exported for the unit tests and for a caller
 * that already owns a line reader; the engine start path uses `waitForWsUrl`.
 *
 * @param line one line without its `\n`; a trailing `\r` is tolerated
 * @returns the trimmed URL when the line is exactly a `WebSocket:` line, else `null`
 */
export function parseWsUrlLine(line: string): string | null {
  const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
  const match = WS_URL_LINE.exec(normalized);
  // `noUncheckedIndexedAccess` types match[1] as `string | undefined`.
  return match?.[1] ?? null;
}

/** Render the last seen line for a diagnostic, clipped so a log line stays one line. */
function summarizeLine(line: string | null): string {
  if (line === null) {
    return "<none>";
  }
  const clipped =
    line.length > MAX_LAST_LINE_CHARS ? `${line.slice(0, MAX_LAST_LINE_CHARS)}...` : line;
  // JSON.stringify quotes the text and escapes control characters, so an engine
  // that prints raw bytes cannot break the one-line shape of our detail string.
  return JSON.stringify(clipped);
}

/**
 * No `WebSocket:` line arrived: timeout, early end of stream, or stream error.
 *
 * `code` is the literal `"PORT_NOT_FOUND"` so a caller can branch without
 * importing the facade's error types; `detail` is for humans and logs only and
 * always carries the number of lines seen plus the last one (clipped to 200
 * characters), which is what a "cold start failed" field report needs.
 */
export class PortNotFoundError extends Error {
  /** Wire-level classification; the facade maps it onto `EngineErrorCode`. */
  readonly code = "PORT_NOT_FOUND" as const;

  /** Human-readable diagnosis: reason, lines seen, clipped last line. */
  readonly detail: string;

  /** Number of stdout lines consumed before giving up. Unrelated lines count too. */
  readonly lineCount: number;

  /** Clipped last line, or `null` when the stream produced nothing. */
  readonly lastLine: string | null;

  constructor(lineCount: number, lastLine: string | null, reason: string, cause?: unknown) {
    const lastLineSummary = summarizeLine(lastLine);
    const detail = `${reason}; ${lineCount} line(s) read; last line: ${lastLineSummary}`;
    super(`WebSocket URL not found: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "PortNotFoundError";
    this.detail = detail;
    this.lineCount = lineCount;
    this.lastLine = lastLineSummary;
  }
}

/** A readable stream that also reports whether it already ended (all Node streams do). */
type EndAwareStream = NodeJS.ReadableStream & { readonly readableEnded?: boolean };

/**
 * Resolve with the first `WebSocket: ws://...` URL printed on `stream`.
 *
 * The stream is only read here; ownership (pause/resume/destroy) stays with the
 * caller. Listeners are removed and the timer is cleared on every exit path, so
 * a late line after a timeout cannot resolve the rejected promise.
 *
 * Rejects with `PortNotFoundError` when:
 * - no matching line arrived within `timeoutMs`;
 * - the stream ended (or closed, or errored) first;
 * - the stream had already ended when called, which would otherwise hang because
 *   `end` never fires twice.
 *
 * @param stream engine stdout (a pipe created with `stdio: "pipe"`)
 * @param timeoutMs upper bound for the wait, 10 s by default (3.3 (f))
 */
export function waitForWsUrl(
  stream: NodeJS.ReadableStream,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    /** Text read from the last `\n` on; the chunk that cut a line in half lives here. */
    let pending = "";
    let lineCount = 0;
    let lastLine: string | null = null;
    let settled = false;
    // Decoding through StringDecoder keeps a multi-byte character that a chunk
    // boundary cut in half intact instead of turning it into U+FFFD.
    const decoder = new StringDecoder("utf8");

    const timer = setTimeout(() => {
      fail(`timed out after ${timeoutMs}ms waiting for a WebSocket line`);
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      stream.removeListener("error", onError);
    }

    function succeed(url: string): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(url);
    }

    function fail(reason: string, cause?: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      // Before the diagnosis is built, so a half-written last line is part of it
      // instead of "0 line(s) read".
      absorbPending();
      cleanup();
      reject(new PortNotFoundError(lineCount, lastLine, reason, cause));
    }

    /** Consume one complete line: count it, remember it, match it. */
    function consumeLine(rawLine: string): string | null {
      lineCount += 1;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lastLine = line;
      return parseWsUrlLine(line);
    }

    /** Split arrived text into lines, keeping an unterminated tail in `pending`. */
    function feed(text: string): void {
      pending += text;
      let newlineAt = pending.indexOf("\n");
      while (newlineAt !== -1) {
        const rawLine = pending.slice(0, newlineAt);
        pending = pending.slice(newlineAt + 1);
        const url = consumeLine(rawLine);
        if (url !== null) {
          succeed(url);
          return;
        }
        newlineAt = pending.indexOf("\n");
      }
    }

    function onData(chunk: Buffer | string): void {
      if (settled) {
        return;
      }
      feed(typeof chunk === "string" ? chunk : decoder.write(chunk));
    }

    /**
     * Count the unterminated tail as a line for the diagnosis.
     *
     * A timeout or an early end usually means the engine wrote something that is
     * not a `WebSocket:` line, and the last thing it wrote may well have no
     * newline yet. Reporting "0 line(s) read; last line: <none>" while half a
     * line is sitting in the buffer sends the reader looking in the wrong place.
     */
    function absorbPending(): void {
      if (pending.length === 0) {
        return;
      }

      lineCount += 1;
      lastLine = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
      pending = "";
    }

    function onEnd(): void {
      if (settled) {
        return;
      }
      // A stream can end on a complete line that simply lacks its `\n`.
      if (pending.length > 0) {
        const tail = pending;
        pending = "";
        const url = consumeLine(tail);
        if (url !== null) {
          succeed(url);
          return;
        }
      }
      fail("the stdout stream ended before a WebSocket line arrived");
    }

    function onError(error: unknown): void {
      fail("the stdout stream failed", error);
    }

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", onError);

    // Attaching after the fact cannot recover a stream that already ended: `end`
    // will never fire again, so waiting would hang until the timeout. Report it
    // now instead, which also covers a caller that passes a drained fixture.
    if ((stream as EndAwareStream).readableEnded === true) {
      fail("the stdout stream had already ended before port discovery started");
    }
  });
}
