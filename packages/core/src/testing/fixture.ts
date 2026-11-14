/**
 * fixture.ts - JSONL fixture loaders for the test-support surface.
 *
 * Scope: the two line formats a fixture can have - the `wire` format, validated
 * by `fixtures/engine/replay.mjs`, and the `frames` format, checked in this
 * for the same shapes as a data snapshot.
 *
 * `fixtures/engine/replay.mjs` owns wire validation - the header, `dir`, `at`,
 * `msg` and the 1-based line number in every error - so this module delegates to
 * `parseWireFixture` instead of re-implementing it. Bridge frames have no owner
 * yet, so their header and envelope checks live here.
 *
 * Why the fixture module is loaded with a dynamic `import()`: `tsconfig.base.json`
 * sets `allowJs: false` and `fixtures/` ships no declaration file, so a static
 * specifier for `replay.mjs` fails typecheck with TS7016. The location is still a
 * single plain relative URL, and the loading mechanism matches the established
 * convention in `engine/fake-server.test.ts` and `engine/replay.test.ts`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Frozen schemaVersion of both fixture formats; a header with another value is rejected. */
const SCHEMA_VERSION = 1;

/** `kind` value of a bridge-frame file header. */
const FRAMES_KIND = "frames";

/** Frozen `bridgeVersion` of the bridge corpus; a header with another value is rejected. */
const BRIDGE_VERSION = 1;

/** Channels a bridge frame may use. */
const FRAME_CHANNELS = ["control", "stream", "bulk"] as const;

/**
 * The virtual clock the replay engine drives.
 *
 * Mirrors the frozen JSDoc typedef in `fixtures/engine/replay.mjs`; consumers
 * import it from this module so the replay module is loaded in one place only.
 */
export interface Clock {
  /** Current virtual time in milliseconds. */
  now(): number;
  /** Wait for `ms` virtual milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** One message line of a wire fixture. */
export type WireFixtureLine = {
  /** Direction on the wire: `s2c` is replayed, `c2s` is only recorded. */
  dir: "c2s" | "s2c";
  /** Virtual milliseconds; timing only, never an assertion input. */
  at: number;
  /** The parsed message body. */
  msg: Record<string, unknown>;
};

/** Wire fixture header: the first JSONL line. */
export type WireFixtureHeader = {
  kind: "wire";
  schemaVersion: 1;
  engine?: { version: string; commit: string };
  scenario?: string;
  redaction?: string;
  clock?: string;
  recordedAt?: string;
  [key: string]: unknown;
};

/** A parsed `wire` fixture: header plus message lines in emission order. */
export type WireFixture = {
  header: WireFixtureHeader;
  lines: WireFixtureLine[];
};

/** One injection the replay driver applies to a fixture (frozen shape). */
export type ReplayInjection =
  | { kind: "reorder"; lines: [number, number] }
  | { kind: "duplicate"; line: number; times: number }
  | { kind: "coalesce"; lines: number[] }
  | { kind: "disconnect"; atLine: number; resume: boolean };

/** A replay plan: playback speed plus line-level injections. */
export type ReplayPlan = {
  /** `"instant"` (default) waits for nothing; a number scales `at` deltas. */
  speed?: "instant" | number;
  /** Line-level injections, applied in array order. */
  inject?: ReplayInjection[];
};

/** One step the replay driver executes. */
export type ReplayStep =
  | { kind: "frame"; delayMs: number; line: number; text: string }
  | { kind: "disconnect"; delayMs: number; line: number; resume: boolean };

/** A bridge channel name. */
export type FrameChannel = (typeof FRAME_CHANNELS)[number];

/** One bridge frame envelope. */
export type BridgeFrame = {
  v: 1;
  ch: FrameChannel;
  seq: number;
  t: string;
  body: Record<string, unknown>;
  /**
   * The paging cursor of a `bulk` frame.
   *
   * `watermark` and `token` are optional because corpora recorded before the
   * cursor existed carry only `more`. A consumer that needs the cursor must
   * treat an absent value as "unknown position", never as position zero: a
   * watermark of zero is a real snapshot position, and conflating the two
   * would make a stale page look current.
   */
  page?: { more: boolean; watermark?: number; token?: string };
};

/** Bridge corpus header: the first JSONL line. */
export type FramesFixtureHeader = {
  kind: "frames";
  schemaVersion: 1;
  bridgeVersion: number;
  clock?: string;
  note?: string;
  [key: string]: unknown;
};

/** A parsed bridge corpus: header plus Frame envelopes in arrival order. */
export type FramesFixture = {
  header: FramesFixtureHeader;
  frames: BridgeFrame[];
};

/**
 * The surface of `fixtures/engine/replay.mjs` this module and its consumers use.
 *
 * Deliberately smaller than the module itself: the socket side (`runReplay`) is
 * driven by the fake server, never by a test directly.
 */
export type ReplayModule = {
  parseWireFixture(text: string): WireFixture;
  buildReplaySteps(fixture: WireFixture, plan?: ReplayPlan): ReplayStep[];
  createInstantClock(): Clock;
};

/** `packages/core/src/testing` -> repo root -> `fixtures/engine/replay.mjs`. */
const REPLAY_MODULE_URL = new URL("../../../../fixtures/engine/replay.mjs", import.meta.url);

let replayModule: Promise<ReplayModule> | undefined;

/**
 * Load the frozen replay module once, through the same relative path the engine
 * tests use.
 *
 * A failed import is not cached, so a transient failure (a moved checkout, a
 * broken transform) can be retried instead of poisoning every later caller.
 */
export function loadReplayModule(): Promise<ReplayModule> {
  replayModule ??= import(pathToFileURL(fileURLToPath(REPLAY_MODULE_URL)).href)
    .then((module) => module as ReplayModule)
    .catch((error: unknown) => {
      replayModule = undefined;
      throw error;
    });

  return replayModule;
}

/**
 * A clock that never waits.
 *
 * Delegates to `createInstantClock` in `replay.mjs`; it is async only because
 * the fixture module is loaded lazily (see {@link loadReplayModule}).
 */
export async function createInstantClock(): Promise<Clock> {
  return (await loadReplayModule()).createInstantClock();
}

/**
 * Read and validate a `wire` JSONL fixture from disk.
 *
 * The whole file is validated by `parseWireFixture`, so a bad header or a bad
 * message line rejects with the existing `replay: fixture line <n>: ...` message.
 *
 * @param path Path of the `.jsonl` file.
 */
export async function loadFixture(path: string): Promise<WireFixture> {
  return loadFixtureText(await readFixtureText(path));
}

/**
 * Validate `wire` JSONL text through the frozen replay parser.
 *
 * Lets a test build a fixture inline without touching the file system.
 *
 * @param text Raw JSONL contents, one message per line.
 */
export async function loadFixtureText(text: string): Promise<WireFixture> {
  return (await loadReplayModule()).parseWireFixture(text);
}

/**
 * Read and validate a bridge-frame fixture from disk.
 *
 * The header must carry `kind: "frames"`, `schemaVersion: 1` and
 * `bridgeVersion: 1`; every following non-blank line must be a Frame envelope
 * (`v`, `ch`, `seq`, `t`, `body`, optional `page`). Every error names the
 * 1-based physical line, like the wire parser does.
 *
 * @param path Path of the `.jsonl` file.
 */
export async function loadFramesFixture(path: string): Promise<FramesFixture> {
  return parseFramesFixture(await readFixtureText(path));
}

/** One line of a JSONL fixture: its 1-based physical line number and trimmed text. */
type FixtureEntry = {
  lineNumber: number;
  raw: string;
};

/**
 * Parse bridge-frame JSONL text.
 *
 * Blank lines are skipped (a trailing newline is fine) but still count for line
 * numbers, matching the wire parser.
 *
 * @param text Raw JSONL contents.
 */
function parseFramesFixture(text: string): FramesFixture {
  const entries = splitEntries(text);
  const headerEntry = entries[0];

  if (headerEntry === undefined) {
    throw lineError(1, `expected a ${FRAMES_KIND} JSON header, found an empty fixture`);
  }

  const header = parseJsonObject(headerEntry, "header");

  if (header.kind !== FRAMES_KIND) {
    throw lineError(
      headerEntry.lineNumber,
      `header "kind" must be "${FRAMES_KIND}", found ${JSON.stringify(header.kind)}`,
    );
  }

  if (header.schemaVersion !== SCHEMA_VERSION) {
    throw lineError(
      headerEntry.lineNumber,
      `header "schemaVersion" must be ${SCHEMA_VERSION}, found ${JSON.stringify(header.schemaVersion)}`,
    );
  }

  if (header.bridgeVersion !== BRIDGE_VERSION) {
    throw lineError(
      headerEntry.lineNumber,
      `header "bridgeVersion" must be ${BRIDGE_VERSION}, found ${JSON.stringify(header.bridgeVersion)}`,
    );
  }

  // Rebuild the header from the values just validated: keeps the type honest and
  // preserves the fields this module does not interpret (`clock`, `note`, ...).
  const validatedHeader: FramesFixtureHeader = {
    ...header,
    kind: FRAMES_KIND,
    schemaVersion: SCHEMA_VERSION,
    bridgeVersion: BRIDGE_VERSION,
  };

  return { header: validatedHeader, frames: entries.slice(1).map(readFrame) };
}

/** Validate one Frame envelope line, or throw with its 1-based line number. */
function readFrame(entry: FixtureEntry): BridgeFrame {
  const value = parseJsonObject(entry, "frame");

  if (value.v !== SCHEMA_VERSION) {
    throw lineError(
      entry.lineNumber,
      `frame "v" must be ${SCHEMA_VERSION}, found ${JSON.stringify(value.v)}`,
    );
  }

  const channel = value.ch;

  if (!isFrameChannel(channel)) {
    throw lineError(
      entry.lineNumber,
      `frame "ch" must be one of ${FRAME_CHANNELS.join(", ")}, found ${JSON.stringify(channel)}`,
    );
  }

  const seq = value.seq;

  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw lineError(
      entry.lineNumber,
      `frame "seq" must be a positive integer, found ${JSON.stringify(seq)}`,
    );
  }

  const t = value.t;

  if (typeof t !== "string" || t.length === 0) {
    throw lineError(
      entry.lineNumber,
      `frame "t" must be a non-empty string, found ${JSON.stringify(t)}`,
    );
  }

  const body = value.body;

  if (!isRecord(body)) {
    throw lineError(entry.lineNumber, `frame "body" must be a JSON object, found ${typeof body}`);
  }

  const frame: BridgeFrame = { v: SCHEMA_VERSION, ch: channel, seq, t, body };
  const page = value.page;

  if (page !== undefined) {
    if (!isPage(page)) {
      throw lineError(
        entry.lineNumber,
        `frame "page" must be an object with a boolean "more", found ${JSON.stringify(page)}`,
      );
    }

    // Everything the envelope carried is kept: a loader that silently narrows
    // the frame cannot be used to test a consumer that reads the narrowed-away
    // fields, and the loss is invisible at the call site.
    frame.page = {
      more: page.more,
      ...(page.watermark === undefined ? {} : { watermark: page.watermark }),
      ...(page.token === undefined ? {} : { token: page.token }),
    };
  }

  return frame;
}

/** Read a fixture file, turning a read failure into a named loader error. */
async function readFixtureText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`fixture: cannot read "${path}": ${detailOf(error)}`, { cause: error });
  }
}

/** Split JSONL text into non-blank entries that keep their physical line numbers. */
function splitEntries(text: string): FixtureEntry[] {
  return text
    .split(/\r?\n/)
    .map((physical, index) => ({ lineNumber: index + 1, raw: physical.trim() }))
    .filter((entry) => entry.raw.length > 0);
}

/** Parse one line as a JSON object, or throw with its 1-based line number. */
function parseJsonObject(entry: FixtureEntry, label: string): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(entry.raw);
  } catch (error) {
    throw lineError(entry.lineNumber, `${label} is not valid JSON (${detailOf(error)})`);
  }

  if (!isRecord(value)) {
    throw lineError(
      entry.lineNumber,
      `${label} must be a JSON object, found ${Array.isArray(value) ? "an array" : typeof value}`,
    );
  }

  return value;
}

/** Build one loader error that points at a 1-based fixture line. */
function lineError(lineNumber: number, message: string): Error {
  return new Error(`fixture: line ${lineNumber}: ${message}`);
}

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is one of the frozen bridge channel names. */
function isFrameChannel(value: unknown): value is FrameChannel {
  return typeof value === "string" && (FRAME_CHANNELS as readonly string[]).includes(value);
}

/** True for a `page` envelope field. */
/**
 * Whether a frame's `page` field is a usable cursor.
 *
 * `more` is required because every recorded corpus has it and the drain loop
 * keys on it. The other two are checked only when present, so an older corpus
 * still loads while a malformed cursor is still rejected.
 */
function isPage(value: unknown): value is { more: boolean; watermark?: number; token?: string } {
  if (!isRecord(value) || typeof value.more !== "boolean") {
    return false;
  }

  if (value.watermark !== undefined && typeof value.watermark !== "number") {
    return false;
  }

  return value.token === undefined || typeof value.token === "string";
}

/** Readable message for a thrown value of unknown shape. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
