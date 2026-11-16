/**
 * Redaction: what may leave the machine inside a diagnostic bundle.
 *
 * A bundle is meant to be sent to someone else, so everything in it is treated as
 * hostile to the user until proven otherwise. Two things are removed, and the
 * difference matters:
 *
 *   The home directory is replaced, not deleted. `C:\Users\ana\proj\a.ts`
 *   becomes `~\proj\a.ts`: the relative structure is what makes a stack trace
 *   readable, and it is also the part that says nothing about who the user is.
 *   Both separators are handled, and on Windows the match is case-insensitive
 *   because the filesystem is.
 *
 *   Secrets are replaced *as values*, with the label kept. `token=abc` becomes
 *   `token=[redacted]`, not `[redacted]`: a reader still needs to know that a
 *   token was there to understand the log, and the shape of the line -- including
 *   JSON validity -- has to survive so a parser can still read the bundle.
 *
 * The hard part is not matching secrets; it is not matching everything else.
 * `tokenizer` is a word, `tokens_per_second` is a metric, and a redactor that
 * blanks them is worse than useless because it hides the evidence while looking
 * thorough. Hence the word-boundary matching below rather than a substring test.
 *
 * No network, no Electron, no clock: this is a pure text function so that a test
 * can state the corpus and the bundle writer can call it on any file.
 */

/** What a stripped secret looks like. Stable, so a `summary.txt` can explain it. */
export const REDACTED = "[redacted]";

/** What a local token-file path becomes: the flag is diagnostic, the path is not. */
export const TOKEN_FILE_PLACEHOLDER = "<token-file>";

/** What a cycle in a structured value becomes. */
export const CYCLE_PLACEHOLDER = "[cycle]";

/** What a value redaction needs to know about its environment. */
export interface RedactOptions {
  /**
   * Absolute home directory, without a trailing separator being required.
   *
   * Callers get it from `os.homedir()` or `app.getPath("home")`; tests pass
   * literals. Absent means "no home path known", and then nothing is replaced --
   * guessing at one would delete a legitimate path from the bundle.
   */
  readonly homeDir?: string;
  /**
   * Secret values the caller already holds, e.g. the engine's run token.
   *
   * Values shorter than four characters are ignored: replacing them would mangle
   * ordinary words, and a one-character secret is not a secret worth shipping a
   * redactor for.
   */
  readonly secrets?: readonly string[];
}

/** Words that name a secret when they are a whole word of a key. */
const SECRET_WORDS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "authorization",
  "apikey",
  "key",
  "cookie",
  "credential",
  "credentials",
]);

/**
 * Split a key into lower-case words, including camelCase boundaries.
 *
 * `runToken` → `run`, `token`; `api_key` → `api`, `key`; `tokenizer` stays one
 * word and therefore does not match. This is the whole defence against
 * over-redaction: a key is secret when one of its words is.
 */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== "");
}

/**
 * Whether a structured key names a secret (`token`, `runToken`, `apiKey`, ...).
 *
 * `apiKey` never survives the split as one word, so the joined form is checked
 * too. `tokenizer` matches neither, which is the point.
 */
function isSecretKey(key: string): boolean {
  const words = keyWords(key);

  if (words.length === 0) return false;

  // A rate metric is not a credential: `tokens_per_second` contains the word
  // `tokens`, but blanking it would destroy the measurement the comment above
  // promises to preserve. The `tokens` word alone still matches.
  if (words.includes("per") && words.includes("second")) return false;

  if (SECRET_WORDS.has(words.join(""))) return true;

  return words.some((word) => SECRET_WORDS.has(word));
}

/** Escape a literal string for use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The spellings of one home directory that can appear in text.
 *
 * Windows paths reach us in three shapes: as the OS wrote them (`\`), as a URL or
 * a slash-normalised config wrote them (`/`), and as JSON escaped them (`\\`).
 * All three have to be replaced or the bundle leaks the name in whichever form
 * the file happened to use.
 */
function homeSpellings(homeDir: string): string[] {
  const stripped = homeDir.replace(/[\\/]+$/, "");
  // A drive root is `C:\`, not `C:`. Stripping its separator would leave a
  // two-character string that matches every path on the drive.
  const trimmed = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : stripped;

  if (trimmed === "") return [];

  const forward = trimmed.replace(/\\/g, "/");
  const backward = trimmed.replace(/\//g, "\\");
  const spellings = new Set([trimmed, forward, backward]);

  for (const spelling of [...spellings]) {
    if (spelling.includes("\\")) spellings.add(spelling.replace(/\\/g, "\\\\"));
  }

  // Longest first: an escaped form must win over the plain one it contains.
  return [...spellings].sort((a, b) => b.length - a.length);
}

/**
 * Replace the home directory with `~`.
 *
 * The match must end at a separator, a quote, whitespace or the end of the text,
 * so `C:\Users\ana` does not eat the first five characters of
 * `C:\Users\anonymous`. On Windows the comparison is case-insensitive, matching
 * the filesystem; elsewhere a case difference is a different path.
 */
function redactHome(text: string, homeDir: string | undefined): string {
  if (homeDir === undefined) return text;

  const flags = process.platform === "win32" ? "gi" : "g";
  let out = text;

  for (const spelling of homeSpellings(homeDir)) {
    const pattern = new RegExp(`${escapeRegExp(spelling)}(?=$|[\\\\/\\s"',)\\]}:;])`, flags);

    out = out.replace(pattern, "~");
  }

  return out;
}

/** Replace the values of `--ws-token-file` flags, keeping the flag legible. */
function redactTokenFileFlags(text: string): string {
  return text.replace(
    /(--ws-token-file(?:=|[ \t]+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+)/gi,
    `$1${TOKEN_FILE_PLACEHOLDER}`,
  );
}

/**
 * Replace secrets that appear as structured values.
 *
 * Three shapes, in this order because each can produce text the next one would
 * otherwise mis-handle:
 *
 *   1. `"key": "value"` -- JSON and JSON-ish documents.
 *   2. `key=value` -- query strings and command lines. The value ends at a
 *      separator, so `?token=abc&x=1` keeps `x=1` and keeps its parentheses.
 *   3. `Authorization:` / `Bearer` headers, which have no `=` to key on.
 *
 * Key names are checked with `isSecretKey`, so `tokenizer=fast` is left alone.
 * `[redacted]` contains no quote or separator, so a second pass is harmless and
 * the text stays JSON-parseable.
 */
function redactStructuredSecrets(text: string): string {
  const quoted = text.replace(
    /"([^"\r\n]+)"(\s*:\s*)"([^"\r\n]*)"/g,
    (match: string, key: string, separator: string, value: string): string =>
      isSecretKey(key) ? `"${key}"${separator}"${REDACTED}"` : match,
  );

  const assigned = quoted.replace(
    /(\b[A-Za-z0-9_.-]+[ \t]*=[ \t]*)([^\s&"',;)\]}>]+)/g,
    (match: string, prefix: string, value: string): string => {
      const key = prefix.slice(0, prefix.indexOf("="));

      return isSecretKey(key) ? `${prefix}${REDACTED}` : match;
    },
  );

  const authorised = assigned.replace(
    /(authorization[ \t]*:[ \t]*)((?:bearer|basic|token)[ \t]+)?([^\s"',;]+)/gi,
    `$1$2${REDACTED}`,
  );

  // Header-style secrets (`Cookie: ...`, `X-Api-Key: ...`, `token: ...`) have
  // no `=`. The key is checked with the same word splitter, so `Date:` and
  // `Content-Type:` survive while a secret-named header is cleared.
  const headed = authorised.replace(
    /(^|[\r\n])([ \t]*[A-Za-z0-9-]+[ \t]*:[ \t]*)([^\r\n]+)/g,
    (match: string, start: string, prefix: string, value: string): string => {
      const key = prefix.replace(/:.*$/, "").trim();

      // `Authorization` has its own rule below, which keeps the scheme
      // (`Bearer`) legible; redacting the whole value here would erase it.
      if (key.toLowerCase() === "authorization") return match;

      return isSecretKey(key) ? `${start}${prefix}${REDACTED}` : match;
    },
  );

  return headed.replace(/(\bBearer[ \t]+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`);
}

/** Redact one string: home first (paths), then secrets (values). */
function redactString(text: string, options: RedactOptions): string {
  let out = redactHome(text, options.homeDir);

  for (const secret of options.secrets ?? []) {
    if (secret.length < 4) continue;

    out = out.split(secret).join(REDACTED);
  }

  out = redactStructuredSecrets(out);

  return redactTokenFileFlags(out);
}

/**
 * Redact free text: a `summary.txt`, a `README.txt`, a stack trace, a log tail.
 *
 * Line structure and JSON validity survive because every replacement is a plain
 * token with no quote or newline in it.
 *
 * @param text the text to clean
 * @param options the home directory and any known secret values
 */
export function redactText(text: string, options: RedactOptions = {}): string {
  return redactString(text, options);
}

/**
 * Redact human-readable bundle files (`summary.txt`, `README.txt`).
 *
 * The same policy as {@link redactText}, named for its caller so that a change
 * to what bundle prose may contain has one place to land rather than being
 * re-derived at each file writer.
 *
 * @param text the file contents about to be written
 * @param options the home directory and any known secret values
 */
export function redactDiagnosticText(text: string, options: RedactOptions = {}): string {
  return redactString(text, options);
}

/**
 * Deep-copy a value, redacting strings and the values of secret-named keys.
 *
 * Used for JSON in the bundle: `shell-settings.json`, `manifest.json`, a
 * conversation record. Keys are matched with {@link isSecretKey}, so a field
 * called `tokenizer` keeps its value while `runToken` and `api_key` do not.
 *
 * Cycles are broken with a `WeakSet` and reported as {@link CYCLE_PLACEHOLDER},
 * and anything that is not JSON (`undefined`, a function, a bigint) becomes
 * `null`: the result has to survive `JSON.stringify` without throwing, because a
 * bundle writer will do exactly that.
 *
 * @param value the parsed document
 * @param options the home directory and any known secret values
 */
export function redactValue<T>(value: T, options: RedactOptions = {}): T {
  const seen = new WeakSet<object>();

  function clone(input: unknown): unknown {
    if (typeof input === "string") return redactString(input, options);
    if (input === null) return null;
    if (typeof input === "number" || typeof input === "boolean") return input;
    // A `Date` reaches JSON as its ISO string; keeping it as an object would
    // serialise to `{}` and turn a timestamp into a mystery.
    if (input instanceof Date) return input.toISOString();
    if (typeof input !== "object") return null;

    if (seen.has(input)) return CYCLE_PLACEHOLDER;

    // Marked while descending and unmarked on the way out: a shared reference is
    // copied twice, only a real cycle is cut. Leaving it marked would report a
    // perfectly ordinary repeated object as a cycle.
    seen.add(input);

    const copy: unknown = Array.isArray(input)
      ? input.map((item) => clone(item))
      : Object.fromEntries(
          Object.entries(input as Record<string, unknown>).map(([key, item]) => [
            key,
            isSecretKey(key) ? REDACTED : clone(item),
          ]),
        );

    seen.delete(input);

    return copy;
  }

  return clone(value) as T;
}
