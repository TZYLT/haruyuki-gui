/**
 * Bounded stderr tail for the engine facade (B1 document-level contract v1.1).
 *
 * The watch package owns the single stderr reader in `spawn.ts` (`drainStream`);
 * this class is only a subscriber to that reader. It must never attach its own
 * `data` listener, or the drain would see two consumers of the same chunks and
 * the watchdog marker parser could lose bytes.
 *
 * Two caps, both enforced on every push:
 *
 * - lines: the caller asks for at most 200 lines by default;
 * - bytes: 128 KiB, because a single engine line can be huge (a stack trace, a
 *   JSON dump) and 200 of those would be tens of megabytes in a diagnostic
 *   bundle that is supposed to stay small.
 *
 * A partial line at the end of a chunk is kept and reported by `snapshot()` as
 * the last line. The engine writes sentences without a trailing newline in
 * several places, and dropping that text would make the last, often most
 * relevant, line invisible.
 */

/** Default number of lines returned by {@link StderrTail.snapshot}. */
const DEFAULT_MAX_LINES = 200;

/** Default byte budget for the whole tail. */
const DEFAULT_MAX_BYTES = 128 * 1024;

/** Options for {@link StderrTail}. */
export interface StderrTailOptions {
  /** Maximum lines kept; defaults to 200. */
  readonly maxLines?: number;
  /** Maximum bytes kept across all lines; defaults to 128 KiB. */
  readonly maxBytes?: number;
}

/**
 * A bounded, append-only tail of stderr text.
 *
 * Not thread-safe and not shared; one instance belongs to one engine attempt.
 */
export class StderrTail {
  private readonly maxLines: number;

  private readonly maxBytes: number;

  private readonly lines: string[] = [];

  private bytes = 0;

  private pending = "";

  /**
   * @param options caps; omitted values use the documented defaults
   */
  constructor(options: StderrTailOptions = {}) {
    this.maxLines = Math.max(1, options.maxLines ?? DEFAULT_MAX_LINES);
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
  }

  /**
   * Append one chunk of stderr text.
   *
   * Chunks are split on newlines; the incomplete tail stays in `pending` until
   * the next chunk or until `snapshot()` reports it.
   *
   * @param chunk text as delivered by the single stderr reader
   */
  push(chunk: string): void {
    if (chunk === "") {
      return;
    }

    const text = this.pending + chunk;
    const parts = text.split("\n");

    this.pending = parts.pop() ?? "";

    for (const part of parts) {
      this.addLine(part.endsWith("\r") ? part.slice(0, -1) : part);
    }

    // A pending fragment that alone exceeds the byte budget can never be
    // completed usefully; keep only its tail so memory stays bounded.
    if (Buffer.byteLength(this.pending, "utf8") > this.maxBytes) {
      const buffer = Buffer.from(this.pending, "utf8");
      this.pending = buffer.subarray(buffer.length - this.maxBytes).toString("utf8");
    }
  }

  /** Drop everything. Called when a new attempt starts. */
  clear(): void {
    this.lines.length = 0;
    this.bytes = 0;
    this.pending = "";
  }

  /**
   * Return the last `limit` lines, oldest first.
   *
   * @param limit maximum lines to return; defaults to the configured cap
   */
  snapshot(limit: number = this.maxLines): readonly string[] {
    const pendingFits = this.pending !== "" && this.textFits();
    const all = pendingFits ? [...this.lines, this.pending] : this.lines;
    const count = Math.max(0, Math.min(limit, all.length));

    return all.slice(all.length - count);
  }

  /** Add one complete line, then trim both caps. */
  private addLine(line: string): void {
    if (line === "") {
      return;
    }

    const trimmed =
      Buffer.byteLength(line, "utf8") > this.maxBytes
        ? Buffer.from(line, "utf8").subarray(0, this.maxBytes).toString("utf8")
        : line;

    this.lines.push(trimmed);
    this.bytes += Buffer.byteLength(trimmed, "utf8");

    while (this.lines.length > this.maxLines || this.bytes > this.maxBytes) {
      const dropped = this.lines.shift();

      if (dropped === undefined) {
        break;
      }

      this.bytes -= Buffer.byteLength(dropped, "utf8");
    }
  }

  /** Whether adding the pending line would stay inside the byte budget. */
  private textFits(): boolean {
    return this.bytes + Buffer.byteLength(this.pending, "utf8") <= this.maxBytes;
  }
}
