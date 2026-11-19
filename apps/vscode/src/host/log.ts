/**
 * The shell's diagnostic channel: one `OutputChannel` the user can open.
 *
 * What must never appear here
 *   A log a user pastes into an issue is a public artifact. So no line carries a
 *   token, a capability token path is fine but a token value is not, and no line
 *   carries conversation content, a command's arguments or a frame payload. The
 *   three sources of a leak are all in this module's contract rather than in a
 *   reviewer's attention:
 *
 *   1. {@link describeError} reports an error's code and message only. A stack
 *      is not included, because a stack quotes whatever the call site captured.
 *   2. {@link redactLine} scrubs the shapes a secret takes when a caller writes
 *      one anyway: `key=value` pairs for the usual names, bearer tokens, and
 *      `ws://...?token=...` query strings. It is a safety net, not a licence to
 *      pass secrets: the gate cannot know every spelling, so the rule above is
 *      still the rule.
 *   3. `appendLine` accepts one line and adds no context. There is no implicit
 *      "current request" object that could drag a body along.
 *
 * What the channel does carry
 *   Lifecycle lines: the extension activated, the core phase changed, the
 *   panel opened and closed. They are what a support request actually needs:
 *   which build, which engine, which directory, which phase.
 *
 * `OutputChannel` is injected (see {@link OutputChannelLike}) so this module
 * runs in a plain `node` process and its redaction is testable without an
 * editor.
 */

/** The members of `vscode.OutputChannel` this module uses. */
export interface OutputChannelLike {
  appendLine(value: string): void;
  /** Reveal the channel. Shown by {@link ShellLog.show}, never by a log line. */
  show(): void;
}

/**
 * A source, narrowed to what {@link describeError} reports.
 *
 * Structural on purpose: both `Error` and a plain object are accepted, and
 * neither has to satisfy a nominal type.
 */
export interface ErrorLike {
  readonly name?: string;
  readonly code?: unknown;
  readonly message?: unknown;
}

/** What a log line is allowed to say about a failure. */
export interface ErrorSummary {
  /** The error's `name`, or `"Error"`. */
  readonly name: string;
  /** The error's `message`. Free text, but never a captured value. */
  readonly message: string;
  /** The error's `code`, when it carries one (a `CoreHostError` does). */
  readonly code?: string;
}

/**
 * Every name whose `=value` is scrubbed from a line.
 *
 * Matched case-insensitively as a whole word before `=`, so `token=` and
 * `TOKEN:` are caught and `tokenCount=` is not. Kept short: this is a net for
 * the spellings a shell actually produces (`--ws-token-file`, `password:`,
 * `apiKey=`), not a general secret scanner.
 */
const SECRET_KEYS = [
  "token",
  "secret",
  "password",
  "passwd",
  "apikey",
  "api_key",
  "authorization",
  "credential",
  "cookie",
] as const;

/**
 * `key=value`, `key: value` and the JSON `"key":"value"` spelling.
 *
 * The optional quotes around the separator are what makes the JSON form match:
 * `{"token":"..."}` has one on each side of the colon, and a pattern that only
 * allowed bare separators would scrub the human-readable lines and silently keep
 * the serialised ones.
 *
 * `(?!Bearer)` keeps `Authorization: Bearer <token>` for {@link BEARER_PATTERN}:
 * without it the pair rule would scrub the scheme name and leave the token.
 */
const SECRET_PAIR_PATTERN = new RegExp(
  `\\b(${SECRET_KEYS.join("|")})\\b("?\\s*[=:]\\s*"?)(?![Bb]earer\\b)("[^"]*"|'[^']*'|[^\\s,;&"]+)`,
  "gi",
);

/** `Authorization: Bearer <token>` and the bare form. */
const BEARER_PATTERN = /\b(bearer)\s+[A-Za-z0-9._~+/-]+=*/gi;

/** `ws://host/path?token=<token>` and the same on any query name above. */
const QUERY_TOKEN_PATTERN = new RegExp(`([?&](?:${SECRET_KEYS.join("|")})=)([^&\\s]+)`, "gi");

/** What a scrubbed value is replaced with. Fixed, so a reader knows it is one. */
export const REDACTED = "[redacted]";

/**
 * Scrub the secret shapes a caller may have written into a line.
 *
 * Pure and idempotent: scrubbing twice is scrubbing once, which matters because
 * the bottom half of a line can contain the word that the top half set.
 *
 * @param line the candidate line
 * @returns the line with every recognised secret replaced by `[redacted]`
 */
export function redactLine(line: string): string {
  return line
    .replace(SECRET_PAIR_PATTERN, (_match, key: string, separator: string, value: string) => {
      // The quotes belong to the value, not to the separator. Re-emitting the one
      // that opened it keeps a JSON object well-formed after the scrub.
      const opening = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";

      return `${key}${separator}${opening}${REDACTED}${opening}`;
    })
    .replace(BEARER_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(QUERY_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`);
}

/**
 * Summarise a thrown value for a log line.
 *
 * Deliberately drops the stack: it is the one field that quotes values the
 * throwing call site happened to capture.
 *
 * @param value the thrown value, of any type
 * @returns the three fields a reader needs, never a payload
 */
export function describeError(value: unknown): ErrorSummary {
  if (typeof value !== "object" || value === null) {
    return { name: "Error", message: typeof value === "string" ? value : String(value) };
  }

  const candidate = value as ErrorLike;
  const name = typeof candidate.name === "string" ? candidate.name : "Error";
  const message =
    typeof candidate.message === "string"
      ? candidate.message
      : typeof candidate.message === "undefined"
        ? ""
        : String(candidate.message);
  const code =
    typeof candidate.code === "string" || typeof candidate.code === "number"
      ? String(candidate.code)
      : undefined;

  return {
    name,
    message,
    ...(code === undefined ? {} : { code }),
  };
}

/** The handle the composition root keeps. */
export interface ShellLog {
  /** Append one line, after redaction. A trailing newline is not its business. */
  write(line: string): void;
  /** Append one line built from a code and optional JSON fields. */
  event(code: string, fields?: Record<string, unknown>): void;
  /**
   * Append one line describing a thrown value.
   *
   * The one place a failure becomes a log line, so the shape of that line --
   * which fields, and which of them are dropped -- is decided once instead of at
   * each `catch`. The message is kept because it is the actionable half; the
   * stack is not, because it is the half that quotes captured values.
   */
  failure(code: string, error: unknown): void;
  /** Reveal the channel in the panel's Output view. */
  show(): void;
  /**
   * How many lines the channel refused.
   *
   * A logger that cannot write is still a logger: losing a line must not become
   * losing the extension. The count is what keeps that silent -- a session that
   * ends with a non-zero count had a channel that closed early, and that is a
   * fact worth being able to read afterwards instead of inferring from a gap.
   */
  readonly droppedLines: number;
}

/** Options of {@link createShellLog}. */
export interface ShellLogOptions {
  /** The channel to write to. Created and disposed by the composition root. */
  readonly channel: OutputChannelLike;
  /** Prefix every line carries, so a pasted log names its source. */
  readonly prefix?: string;
}

/** The default prefix; `[Haruyuki]` reads as a category in a pasted log. */
const DEFAULT_PREFIX = "[haruyuki]";

/**
 * Build the log.
 *
 * @param options the channel and the line prefix
 * @returns the handle
 */
export function createShellLog(options: ShellLogOptions): ShellLog {
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  /**
   * Append one already-prefixed line to the channel.
   *
   * @param line the line, without a prefix and without a newline
   */
  /**
   * Append one already-prefixed line to the channel.
   *
   * A failed write is counted and dropped, never re-thrown and never retried.
   * Re-throwing would let a shutdown-time log line abort `deactivate`, which is
   * what "the window closed itself" looks like from the outside; retrying would
   * call the same dead channel a second time and throw again in the same place.
   *
   * @param line the line, without a prefix and without a newline
   */
  function append(line: string): void {
    try {
      options.channel.appendLine(redactLine(`${prefix} ${line}`));
    } catch {
      dropped += 1;
    }
  }

  let dropped = 0;

  return {
    get droppedLines(): number {
      return dropped;
    },
    write(line: string): void {
      append(line);
    },

    event(code: string, fields: Record<string, unknown> = {}): void {
      // `JSON.stringify` on a cycle throws, and a logger that throws inside a
      // failure path replaces the failure being reported. The field object is
      // shallow by contract; a cycle still degrades to the code alone.
      let rendered = "";

      if (Object.keys(fields).length > 0) {
        try {
          rendered = ` ${JSON.stringify(fields)}`;
        } catch {
          rendered = " {unserializable}";
        }
      }

      append(`${code}${rendered}`);
    },

    failure(code: string, error: unknown): void {
      const summary = describeError(error);

      append(
        `${code} ${JSON.stringify({
          name: summary.name,
          message: summary.message,
          code: summary.code ?? null,
        })}`,
      );
    },

    show(): void {
      // Same reason as `append`: revealing a closed channel throws, and the one
      // caller that reveals on the user's behalf is a command handler, which
      // must not fail because the channel it was opening had already gone.
      try {
        options.channel.show();
      } catch {
        dropped += 1;
      }
    },
  };
}
