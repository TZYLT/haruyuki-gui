/**
 * Engine-client diagnostics: what the channel saw go wrong, bounded, redacted
 * and aggregated.
 *
 * The record shape is below, and the redaction rule it enforces is "no token, no
 * absolute path survives". Two constraints shape the storage: an unknown event
 * type is COUNTED per type, never stored per frame, and the ring is a fixed 512
 * records of at most 4 KB each.
 *
 * Three jobs are kept in three pieces, because each one has its own failure
 * mode and its own test:
 *
 * 1. {@link BoundedRing} - storage, and only storage. It knows a capacity,
 *    overwrite-oldest, read-in-write-order and subscriber notification. Nothing
 *    here knows what a diagnostic is, so a capacity or ordering test is a test
 *    of arithmetic, not of a channel.
 * 2. {@link redactDiagnosticText} and {@link boundDiagnosticText} - the text
 *    fence. Pure string functions, so a credential shape is tested directly,
 *    without a socket, a record or a log.
 * 3. {@link DiagnosticLog} - the composition: sanitise on the way in, store,
 *    notify, and tally unknown event types in a `Map` instead of the ring.
 *
 * Why the fence is the most important part: a diagnostic is exported, pasted
 * into an issue and attached to a crash report. A leaked token is a security
 * incident; a leaked absolute path is a privacy one, because it exposes a user
 * name and the shape of their project tree. So redaction is applied at the one
 * entry point ({@link DiagnosticLog.record}) rather than trusting every caller
 * to remember, and it runs BEFORE the byte bound - a cut in the middle of a
 * credential is still a leak of the credential's prefix.
 *
 * The one boundary text substitution cannot enforce is `Endpoint`. A
 * `{url, token}` pair must never enter a record as a whole. The seam for "which
 * engine did this" is {@link describeEndpoint}: it yields host:port and nothing
 * else - no scheme, no path, no query, no token - and an unparsable URL falls
 * back to a placeholder rather than being passed through, because a URL that
 * will not parse is exactly the one that may carry a secret in an unexpected
 * position.
 */

import type { DiagnosticKind, DiagnosticRecord, Endpoint } from "./types";

/**
 * How many records the ring keeps before it overwrites the oldest.
 *
 * 512 is roughly three full approval round trips, small enough that the buffer
 * can never be the reason a process grows.
 */
export const DIAGNOSTIC_RING_CAPACITY = 512;

/**
 * Per-field UTF-8 byte ceiling for a stored record's text.
 *
 * `engineText` is capped at 4 KB, and the same fence is applied to `subject`
 * and `engineVersion`: a record is bounded or it is not,
 * and a hostile `subject` would otherwise be an unbounded string in the buffer.
 * 4 KB covers the engine's longest observed rejection reason.
 */
export const ENGINE_TEXT_MAX_BYTES = 4096;

/** Replacement for a credential-shaped substring. */
export const TOKEN_PLACEHOLDER = "<redacted-token>";

/** Replacement for an absolute-path-shaped substring. */
export const PATH_PLACEHOLDER = "<path>";

/** Stand-in for an endpoint whose URL cannot be parsed; the raw URL is never used. */
export const ENDPOINT_FALLBACK = "<unparsable-endpoint>";

/**
 * Opening text of the notice appended to a truncated field.
 *
 * The notice is not decoration: a silently shortened engine message reads as
 * complete, so a field report would name a reason the engine never gave. The
 * total byte count is part of the notice so a reader knows how much was cut.
 */
export const TRUNCATION_MARKER_PREFIX = "[truncated:";

/** Receives every value stored while the subscription is current. */
export type RingSubscriber<T> = (value: T) => void;

/**
 * A fixed-capacity ring that overwrites its oldest slot when full.
 *
 * The interface is deliberately small - `push`, `size`, `at`, `toArray`,
 * iteration, `subscribe` - because every extra member is a member whose
 * semantics has to be argued about in the middle of a failure path.
 *
 * Two behaviours are load-bearing and are tested against the observable result
 * rather than an internal header:
 *
 * - **Overwrite, never clear.** When the ring is full, the oldest slot is
 *   replaced and `size` stays at `capacity`. A `clear()` would lose the whole
 *   history at the exact moment the history matters most (the 513th record is
 *   usually a symptom of the 512 before it).
 * - **Read order is write order.** `at(0)` / `toArray()[0]` is the oldest value
 *   still held and the last element is the newest, even after wrapping. A
 *   reader must not have to know where the head happens to be.
 */
export class BoundedRing<T> {
  readonly #capacity: number;
  readonly #slots: (T | undefined)[];
  readonly #subscribers = new Set<RingSubscriber<T>>();

  /** Index of the oldest value; equals the write position while the ring is full. */
  #head = 0;

  /** Number of slots holding a value; never exceeds `#capacity`. */
  #length = 0;

  /**
   * @param capacity slots to keep; a positive integer.
   * @throws RangeError when `capacity` is not a positive integer, because a
   *   ring of zero slots would silently discard every record.
   */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(
        `invalid ring capacity: ${String(capacity)}; expected a positive integer`,
      );
    }

    this.#capacity = capacity;
    this.#slots = new Array<T | undefined>(capacity).fill(undefined);
  }

  /** Slots the ring can hold. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Values currently held; equals `capacity` once the ring has wrapped. */
  get size(): number {
    return this.#length;
  }

  /**
   * Store one value, evicting the oldest when full, then notify subscribers.
   *
   * Subscribers are called AFTER the value is stored and in subscription order,
   * so a subscriber that reads the ring from its callback sees what it was
   * notified about. Delivery iterates a copy of the subscriber set: a listener
   * that subscribes or unsubscribes during a delivery pass cannot change who
   * receives the value that is already being delivered.
   *
   * @param value the value to store.
   */
  push(value: T): void {
    if (this.#length === this.#capacity) {
      // Full: the head slot holds the oldest value, so overwriting it and
      // advancing the head keeps the length fixed. Emptied here instead of
      // overwritten would be the "clear on overflow" bug this branch prevents.
      this.#slots[this.#head] = value;
      this.#head = (this.#head + 1) % this.#capacity;
    } else {
      this.#slots[(this.#head + this.#length) % this.#capacity] = value;
      this.#length += 1;
    }

    for (const subscriber of [...this.#subscribers]) {
      subscriber(value);
    }
  }

  /**
   * Read one value by write order, `0` being the oldest still held.
   *
   * @param index 0-based write-order position.
   * @throws RangeError when `index` is outside `[0, size)`; a ring has no
   *   sparse reads, and returning `undefined` would hide a caller's off-by-one.
   */
  at(index: number): T {
    if (!Number.isInteger(index) || index < 0 || index >= this.#length) {
      throw new RangeError(
        `ring index out of range: ${String(index)}; size is ${String(this.#length)}`,
      );
    }

    return this.#valueAt(index);
  }

  /**
   * Snapshot in write order, oldest first.
   *
   * A fresh array on every call: a caller that sorts or splices the result must
   * not be able to reorder the ring itself.
   */
  toArray(): readonly T[] {
    return [...this];
  }

  /** Iterate oldest to newest, over a snapshot of the current contents. */
  *[Symbol.iterator](): IterableIterator<T> {
    for (let offset = 0; offset < this.#length; offset += 1) {
      yield this.#valueAt(offset);
    }
  }

  /**
   * Subscribe to values stored from now on.
   *
   * @param subscriber called once per stored value, in storage order.
   * @returns an unsubscribe function. Calling it is idempotent: the second call
   *   removes nothing and throws nothing, and no value stored after it is
   *   delivered.
   */
  subscribe(subscriber: RingSubscriber<T>): () => void {
    this.#subscribers.add(subscriber);

    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** Read the value at one write-order offset, assuming `length` says it is set. */
  #valueAt(offset: number): T {
    const value = this.#slots[(this.#head + offset) % this.#capacity];

    if (value === undefined) {
      // Cannot happen while `#length` is correct. Throwing beats returning a
      // plausible-looking `undefined`: a silent gap in a diagnostic history is
      // worse than a loud bug in the buffer.
      throw new Error(`ring slot ${String(offset)} is empty; length bookkeeping is inconsistent`);
    }

    return value;
  }
}

/**
 * One substitution rule applied to diagnostic text.
 *
 * `replacement` is a string for the rules that swap a shape for a fixed
 * placeholder, and a function for the one rule that has to inspect the match
 * before deciding. `pattern` is always global so a field carrying two
 * credentials loses both.
 */
export type RedactionRule = {
  /** Stable id, used by tests and by a future "-- why was this redacted" report. */
  readonly id: string;
  /** Global pattern to match. */
  readonly pattern: RegExp;
  /** Replacement text, or a function of the matched text. */
  readonly replacement: string | ((match: string) => string);
};

/**
 * The substitutions that implement "no token, no absolute path".
 *
 * Order is load-bearing and is tested, in three bands:
 *
 * 1. **Context-keeping credential rules first** (`Bearer`, a query value).
 *    These have to see the value while its surroundings are still intact: the
 *    `Bearer` rule keeps the header, the query rule keeps the parameter NAME,
 *    and both would lose that context if a path or opaque-run rule had already
 *    rewritten the neighbourhood.
 * 2. **Path rules next**, `file://` before the POSIX rule. An absolute path has
 *    to be replaced as ONE path: if a bare-shape token rule ran first and fired
 *    on a long random directory name, the path rule could no longer match the
 *    whole string and its tail would survive as a fragment. Replacing the path
 *    first also keeps `<path>` meaning "one path was here" instead of
 *    "a path, minus one segment that looked like a key".
 * 3. **Bare-shape token rules last** (JWT, provider key, 64-hex, opaque run).
 *    By the time they run, every absolute path is already `<path>`, so what
 *    remains is a credential standing on its own - which is exactly the shape
 *    these rules recognize.
 *
 * The `file://` rule needs its own place in band 2 because the POSIX rule's
 * lookbehind deliberately refuses a path that starts right after `/` (that
 * refusal is what keeps `https://host/a/b` and `ws://127.0.0.1:1/x` readable).
 * A `file://` URL carries a real absolute path, so it gets an explicit rule.
 *
 * The generic opaque-run rule is the safety net for "any credential that looks
 * like a long random string": 32+ characters drawn from the base64/base64url
 * alphabet, replaced only when the run contains at least one digit. The digit
 * guard keeps ordinary long identifiers (`unmodelled_stream_chunk`) and long
 * lowercase path segments from being mistaken for secrets, while a random key
 * of that length contains a digit with overwhelming probability. Leaving a
 * 32-character all-letter run alone is the deliberate residual gap: it is far
 * more likely to be an identifier a reader needs than a credential, and the
 * documented credential shapes (bearer, JWT, provider key, 32+ hex) are covered
 * by their own rules.
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  {
    // The header stays, the secret goes: "Authorization: Bearer <...>" still
    // tells a reader what failed, and the value is what must not survive.
    id: "bearer-credential",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `Bearer ${TOKEN_PLACEHOLDER}`,
  },
  {
    // An endpoint may carry its token in a query string. The parameter name is
    // kept for diagnosis, the value is dropped even when it is short or uses a
    // shape no other rule recognizes.
    id: "credential-query",
    pattern:
      /([?&](?:token|access_token|accessToken|api_key|apiKey|apikey|key|secret|password|sig|signature)=)[^&\s"'<>]*/gi,
    replacement: `$1${TOKEN_PLACEHOLDER}`,
  },
  {
    // An absolute path inside a file URL: the whole URL becomes a placeholder
    // only for the path part, so "file:/<path>" still says a file was involved.
    id: "file-url",
    pattern: /\bfile:\/{1,3}[^\s"'<>]*/gi,
    replacement: `file://${PATH_PLACEHOLDER}`,
  },
  {
    // Windows drive path, including the forward-slash spelling and spaces
    // inside a directory name. The lookbehind stops a URL scheme (`ws:/`,
    // `https:/`) from being read as a drive.
    id: "windows-path",
    pattern: /(?<![\w:/\\])[A-Za-z]:[\\/][^\s"'<>|,;]*/g,
    replacement: PATH_PLACEHOLDER,
  },
  {
    // Windows UNC path: \\server\share\...
    id: "unc-path",
    pattern: /(?<![\w:/\\])\\\\[A-Za-z0-9._$-]+\\[^\s"'<>|,;]*/g,
    replacement: PATH_PLACEHOLDER,
  },
  {
    // Unix absolute path. The lookbehind refuses a path that follows a word
    // character, `:` or another `/`, which is what keeps `https://host/a/b`
    // and `ws://127.0.0.1:1/x` readable while `/home/user/.haruyuki/token`
    // (the usual first character, a space or the start of the string) is
    // replaced whole.
    id: "posix-path",
    pattern: /(?<![\w:/\\])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g,
    replacement: PATH_PLACEHOLDER,
  },
  {
    // A JWT: three dot-separated base64url segments. The `eyJ` prefix is the
    // base64url encoding of `{"`, so requiring it keeps a dotted host name
    // (`api.example.com`) from being mistaken for a credential.
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: TOKEN_PLACEHOLDER,
  },
  {
    // Provider-style keys: a fixed, recognizable prefix plus a long body.
    id: "provider-key",
    pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g,
    replacement: TOKEN_PLACEHOLDER,
  },
  {
    // The engine capability token's own shape: 32 random bytes written as 64
    // hex characters (`generateToken`). The lookarounds stop a longer hex run
    // from being cut in half.
    id: "hex-credential",
    pattern: /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g,
    replacement: TOKEN_PLACEHOLDER,
  },
  {
    // Safety net: a long run from the base64/base64url alphabet that contains a
    // digit. See the note above on why the digit guard exists and what it
    // deliberately leaves alone.
    id: "opaque-credential",
    pattern: /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    replacement: (match) => (/[0-9]/.test(match) ? TOKEN_PLACEHOLDER : match),
  },
];

/** One encoder for the module; `TextEncoder` is stateless, so sharing is safe. */
const UTF8 = new TextEncoder();

/** UTF-8 byte length of a string, the unit both limits are expressed in. */
function byteLength(text: string): number {
  return UTF8.encode(text).byteLength;
}

/** UTF-8 width of one code point (a lone surrogate counts as the replacement). */
function utf8Width(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1;
  }

  if (codePoint <= 0x7ff) {
    return 2;
  }

  return codePoint <= 0xffff ? 3 : 4;
}

/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `limit` bytes.
 *
 * Iterating code points rather than slicing UTF-16 units is the point: a
 * `slice(0, 4096)` on a string of emoji keeps 4096 code units, which is 8192
 * bytes, and can also end in the middle of a surrogate pair.
 */
function cutToBytes(text: string, limit: number): string {
  if (limit <= 0) {
    return "";
  }

  let used = 0;
  let end = 0;

  for (const character of text) {
    const width = utf8Width(character.codePointAt(0) ?? 0);

    if (used + width > limit) {
      break;
    }

    used += width;
    end += character.length;
  }

  return text.slice(0, end);
}

/**
 * Replace every credential-shaped and absolute-path-shaped substring.
 *
 * Pure and total: any string in, a string at most as long out (the placeholders
 * are shorter than the shapes they replace, except for the deliberately short
 * `file://` form).
 *
 * @param text untrusted engine output, a subject or a version string.
 * @returns the same text with secrets and absolute paths replaced.
 */
export function redactDiagnosticText(text: string): string {
  let redacted = text;

  for (const rule of REDACTION_RULES) {
    const { replacement } = rule;

    // `String.replace` with a global pattern starts at 0 and resets `lastIndex`,
    // so the shared compiled patterns are safe to reuse across calls.
    redacted =
      typeof replacement === "string"
        ? redacted.replace(rule.pattern, replacement)
        : redacted.replace(rule.pattern, (match: string) => replacement(match));
  }

  return redacted;
}

/**
 * Bound one field to {@link ENGINE_TEXT_MAX_BYTES} UTF-8 bytes, and say so when
 * the bound bit.
 *
 * The notice is inside the byte budget, not on top of it: the stored field must
 * be bounded, so the kept text is shortened by the notice's own length and the
 * notice records the total. That keeps the invariant a reader cares about ("no
 * single diagnostic field exceeds 4 KB") true by construction, rather than true
 * for the text and false for the record.
 *
 * The total counted is the total of the text handed in, i.e. after redaction.
 * It is the number the reader would have been able to see.
 *
 * @param text already redacted text.
 * @returns `text` unchanged when it fits, or a bounded prefix plus the notice.
 */
export function boundDiagnosticText(text: string): string {
  const total = byteLength(text);

  if (total <= ENGINE_TEXT_MAX_BYTES) {
    return text;
  }

  const marker = ` ${TRUNCATION_MARKER_PREFIX} ${String(total)} bytes total]`;
  const body = cutToBytes(text, ENGINE_TEXT_MAX_BYTES - byteLength(marker));

  return `${body}${marker}`;
}

/**
 * A record as a caller states it: everything except the timestamp.
 *
 * `at` is deliberately not the caller's job. It answers "when did WE see this",
 * which only the log's own clock can answer, and a caller who had to write it
 * would eventually write a placeholder (a constant, a zero, a copied frame
 * time) and the field would become noise that looks like data. So the write
 * path takes a draft and stamps it.
 *
 * The field is still accepted when supplied, for two reasons: a caller that
 * already knows the instant (a frame's receive time, carried from the code that
 * observed it) should not have to be stamped later, and a test needs a fixed
 * time to be deterministic. Omitted is the normal case.
 */
export type DiagnosticDraft = Omit<DiagnosticRecord, "at"> & {
  /** Explicit epoch milliseconds; the log's clock stamps the record when omitted. */
  readonly at?: number;
};

/**
 * Whether a value is usable as `at`: a finite number of epoch milliseconds.
 *
 * A `NaN` or infinite stamp is worse than no stamp: it reaches a renderer as
 * "Invalid Date" and reaches a sort as an unorderable value, so a supplied
 * value that fails this check is replaced by the clock rather than passed on.
 */
function isUsableTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

/**
 * Redact then bound one record, and freeze the result.
 *
 * Redaction runs first: a credential cut in half by the byte bound is a partial
 * credential in a file that gets pasted into an issue.
 *
 * `at` is carried through untouched. It is a number this process took from its
 * own clock, not engine text, so there is nothing in it to redact.
 *
 * The record is frozen so a subscriber cannot rewrite what the ring holds. The
 * ring stores the frozen record, so the history cannot disagree with what was
 * delivered.
 *
 * @param record the complete record a caller asked to store.
 * @returns the record as it will be stored and delivered.
 */
export function sanitizeDiagnosticRecord(record: DiagnosticRecord): DiagnosticRecord {
  const sanitized: {
    at: number;
    kind: DiagnosticKind;
    subject: string;
    engineText?: string;
    engineVersion?: string;
  } = {
    at: record.at,
    kind: record.kind,
    subject: boundDiagnosticText(redactDiagnosticText(record.subject)),
  };

  if (record.engineText !== undefined) {
    sanitized.engineText = boundDiagnosticText(redactDiagnosticText(record.engineText));
  }

  if (record.engineVersion !== undefined) {
    sanitized.engineVersion = boundDiagnosticText(redactDiagnosticText(record.engineVersion));
  }

  return Object.freeze(sanitized);
}

/**
 * How to name the engine a record came from: its host and port, nothing else.
 *
 * This is the only sanctioned way to put an endpoint near a diagnostic, and it
 * exists because `{url, token}` must never enter one: the URL is a credential
 * carrier too - the token may sit in its query string, and its path can name a
 * workspace.
 *
 * An unparsable URL yields {@link ENDPOINT_FALLBACK} rather than the raw string,
 * because a URL that fails to parse is precisely the one whose secret may be
 * somewhere no rule anticipates.
 *
 * @param endpoint the endpoint of the engine the record is about.
 * @returns `"host:port"`, or the fallback when the URL cannot be parsed.
 */
export function describeEndpoint(endpoint: Endpoint): string {
  try {
    const { host } = new URL(endpoint.url);

    return host === "" ? ENDPOINT_FALLBACK : host;
  } catch {
    return ENDPOINT_FALLBACK;
  }
}

/**
 * The bounded, redacted diagnostic history of one channel, plus the unknown
 * event tally.
 *
 * `record` is the single write path and it always sanitises, so no caller can
 * put a raw token or a raw path into the ring by forgetting a step. The ring
 * decides what is kept (newest {@link DIAGNOSTIC_RING_CAPACITY}); this class
 * decides what a record looks like on the way in.
 *
 * Unknown event types are counted, never stored: one recording has
 * 155 frames of a single high-volume streaming type, so storing them per frame
 * would spend 30% of a 512-record buffer on one type and evict the failures the
 * buffer exists for. The tally answers the question the buffer cannot ("what is
 * this engine sending that we do not model, and how much of it").
 */
export class DiagnosticLog {
  readonly #ring: BoundedRing<DiagnosticRecord>;

  /** Unknown event type -> frames seen. A `Map`, so it cannot grow per frame. */
  readonly #unknownEvents = new Map<string, number>();

  /** This process's clock, in epoch milliseconds. Injected so a test can pin it. */
  readonly #now: () => number;

  /** Newest stamp this log has produced, so stamps never go backwards. */
  #lastAt = Number.NEGATIVE_INFINITY;

  /**
   * @param capacity ring size; defaults to {@link DIAGNOSTIC_RING_CAPACITY}.
   *   Exposed for tests and for a future "reduced history" mode, not for a
   *   caller to raise at will: the bound is the protection.
   * @param now the clock used to stamp a record whose `at` was omitted.
   *   Defaults to `Date.now`. Injected rather than reached for directly so a
   *   test can drive time deterministically instead of racing a real clock.
   */
  constructor(capacity: number = DIAGNOSTIC_RING_CAPACITY, now: () => number = Date.now) {
    this.#ring = new BoundedRing<DiagnosticRecord>(capacity);
    this.#now = now;
  }

  /** Ring size in records. */
  get capacity(): number {
    return this.#ring.capacity;
  }

  /** Records currently held, oldest first. */
  get size(): number {
    return this.#ring.size;
  }

  /**
   * Sanitise and store one record, then notify subscribers.
   *
   * The record's `at` is stamped here, not by the caller: a caller that had to
   * supply a time would end up writing a placeholder, and a placeholder in a
   * timestamp column is indistinguishable from a real reading. An explicit
   * finite `at` is honoured (a caller that already observed the instant, or a
   * test that needs determinism); anything else falls back to this log's clock.
   *
   * The stamp is clamped to be **monotonically non-decreasing**. Two records
   * produced in the same millisecond share a stamp, which is honest, but a stamp
   * that went backwards would make `entries()` unorderable by time and would let
   * a reader conclude the second record happened first. A clock stepped backwards
   * (NTP correction, a suspended machine) is exactly when this matters, and it is
   * silent unless guarded here.
   *
   * The stored record is the redacted, bounded, frozen one; subscribers receive
   * that same object, never the caller's.
   *
   * An `unknown-event` record may be stored through here as a SUMMARY (one line
   * saying "an unrecognised type arrived"), and it costs one of the 512 slots.
   * Per-frame unknown types must go through {@link recordUnknownEvent} instead,
   * which is why that method exists and is tested separately.
   *
   * @param draft everything about the record except, normally, its timestamp.
   */
  record(draft: DiagnosticDraft): void {
    const supplied = draft.at;
    const stamped = isUsableTimestamp(supplied) ? Math.max(supplied, this.#lastAt) : this.#nextAt();

    this.#lastAt = stamped;

    // Rebuilt rather than spread so no extra property a caller slipped in can
    // ride into the stored record: the ring holds the shape it was promised.
    const complete: DiagnosticRecord = {
      at: stamped,
      kind: draft.kind,
      subject: draft.subject,
      ...(draft.engineText === undefined ? {} : { engineText: draft.engineText }),
      ...(draft.engineVersion === undefined ? {} : { engineVersion: draft.engineVersion }),
    };

    this.#ring.push(sanitizeDiagnosticRecord(complete));
  }

  /** Read the clock, keeping the produced stamp at or above the last one. */
  #nextAt(): number {
    return Math.max(this.#now(), this.#lastAt);
  }

  /** Stored records in write order, oldest first. A fresh array per call. */
  entries(): readonly DiagnosticRecord[] {
    return this.#ring.toArray();
  }

  /**
   * Subscribe to records stored from now on.
   *
   * @param subscriber called with the sanitised record.
   * @returns an idempotent unsubscribe function.
   */
  onRecord(subscriber: RingSubscriber<DiagnosticRecord>): () => void {
    return this.#ring.subscribe(subscriber);
  }

  /**
   * Count one frame of an unrecognised event type.
   *
   * Deliberately does NOT touch the ring: the count is the record.
   * Order of first appearance is preserved by `Map`, so {@link unknownEventTypes}
   * lists types in the order the engine first sent them.
   *
   * @param type the engine's own event type name, verbatim.
   */
  recordUnknownEvent(type: string): void {
    this.#unknownEvents.set(type, (this.#unknownEvents.get(type) ?? 0) + 1);
  }

  /**
   * Frames seen for one unknown type.
   *
   * @param type the engine's own event type name.
   * @returns the count, or `0` for a type never seen. `0` is chosen over
   *   `undefined` so a caller needs no second branch to render "0 frames".
   */
  unknownEventCount(type: string): number {
    return this.#unknownEvents.get(type) ?? 0;
  }

  /** Every unknown type seen, in first-appearance order. A fresh array per call. */
  unknownEventTypes(): readonly string[] {
    return [...this.#unknownEvents.keys()];
  }

  /** Total unknown-event frames counted, across all types. */
  unknownEventTotal(): number {
    let total = 0;

    for (const count of this.#unknownEvents.values()) {
      total += count;
    }

    return total;
  }
}
