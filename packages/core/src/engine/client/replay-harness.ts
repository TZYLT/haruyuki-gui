/**
 * Replay-corpus harness for the equivalence suite.
 *
 * Scope sources:  section 2.5 (what the replayer can and cannot do),
 * section 2.10 (the corpus facts) and section 6.4 (the `test` budget); docs/26
 * section 5.1 .
 *
 * ## What this module is for
 *
 * The equivalence suite asks one question: **does the real client stack rebuild
 * event sequence - order, type, count - when it is fed the recorded frames?**
 * Answering it needs four things that do not belong in a single test case, and
 * that four other suites would eventually copy:
 *
 * 1. **The corpus, read rather than transcribed.** Every expectation here is
 *    derived from `fixtures/engine/recordings/*.jsonl` at run time. That is what
 *    keeps the whole `client/` directory free of wire vocabulary : a type
 *    name reaches a test as data (`frame.eventType`), never as a literal, so
 *    "the type sequence is unchanged" is checked against the recording instead
 *    of against a copy of it that could drift.
 * 2. **A plan built from the recording.** The replayer is not a recorder: it
 *    emits the `s2c` lines of a fixture in fixture order, paced by the fixture's
 *    own `at` deltas . A plan therefore needs
 *    nothing but `speed` - and `speed` **must be a number**, because the default
 *    `"instant"` is what makes `plan.inject` unobservable (fact 24). One shared
 *    number keeps every case in this suite off the wall clock.
 * 3. **A clock that is asked, not obeyed.** {@link createRecordingClock} keeps
 *    the recorded pacing as *requested* delays and returns immediately, so a
 *    recording whose last frame sits at 6.6 s still costs the gate a millisecond
 *    or two. The requests are kept because they are an assertion input: their sum
 *    must equal the recording's own span, which is how the suite proves the
 *    replayer was driven by the recorded offsets rather than by its own timer.
 * 4. **A sequence diff, not a length.** `toHaveLength` cannot see a swap; a diff
 *    that reports each differing index can, and {@link diffEventSequence} also
 *    answers the question that decides whether the *order* assertion is carrying
 *    its own weight: is the multiset unchanged? A reordered run has an unchanged
 *    multiset, so a count-only assertion stays green - that is exactly what the
 *    planted-reorder case demonstrates.
 *
 * ## What it deliberately does not do
 *
 * - **No second socket.** The replayer serves one live connection at a time
 *   ; a second client receives nothing, and a suite
 *   that opened one would be testing that limitation instead of the client.
 *   {@link startReplaySession} opens exactly one transport and the tests run
 *   server-per-case, sequentially.
 * - **No `c2s` writes.** Replay never answers a command (fact 19), so sending one
 *   could only produce a frame nobody recorded. The `write` port is a no-op and
 *   the assertions are about what arrives.
 * - **No hand-written frames.** A synthetic frame could not disagree with the
 *   implementation; these can, which is the whole reason the corpus is read from
 *   disk.
 *
 * ## Leak discipline (the part that is not optional)
 *
 * A replay server that nobody closes keeps the process alive; a channel left open
 * hands timers to the next case. Every session therefore registers itself in
 * {@link liveSessions}, {@link closeSessions} closes whatever a case forgot, and
 * the channel half is handled by `channel-test-support`'s own tracking
 * (`trackChannel` / `trackClock`), so `assertNoLeakedTimers` still works here
 * without this module re-implementing it.
 *
 * This file intentionally does not end in `.test.ts`: vitest collects by that
 * suffix, so nothing here is ever mistaken for a suite.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createChannel } from "./channel";
import type { EngineChannel } from "./channel";
import { makeClock, trackChannel, trackClock } from "./channel-test-support";
import { openTransport } from "./transport";
import type { EngineTransport } from "./transport";
import type { EngineEventFrame } from "./types";
import { loadFixture, loadReplayModule } from "../../testing/fixture";
import type {
  Clock,
  ReplayInjection,
  ReplayPlan,
  WireFixture,
  WireFixtureLine,
} from "../../testing/fixture";

/* ------------------------------------------------------------------------- */
/* The corpus                                                                */
/* ------------------------------------------------------------------------- */

/** `fixtures/engine/recordings/`, the read-only A3 corpus. */
const CORPUS_DIR_URL = new URL("../../../../../fixtures/engine/recordings/", import.meta.url);

/** Capability token this suite shares between the fake server and the client. */
const REPLAY_TOKEN = "w10-replay-token";

/** Budget for one connection attempt; a stuck upgrade must fail, not hang. */
const CONNECT_BUDGET_MS = 1_000;

/** Default budget for "the plan's frames should all have arrived by now". */
const SETTLE_BUDGET_MS = 2_000;

/** Poll interval of {@link ReplaySession.settle}; one macrotask, not a wait. */
const SETTLE_POLL_MS = 1;

/** The frame-count scaling the replay driver applies to `at` deltas. */
const REPLAY_SPEED = 1;

/** One recorded `s2c` frame, with both the bytes and the parsed message. */
export type RecordedFrame = {
  /** 1-based index into `fixture.lines`, i.e. what a plan injection names. */
  readonly line: number;
  /** The recording's own offset, in milliseconds from connect. */
  readonly at: number;
  /** The parsed message exactly as `parseWireFixture` produced it. */
  readonly json: Record<string, unknown>;
  /** The engine's event type; read here so no test has to spell it. */
  readonly eventType: string;
  /** The text the replay driver emits: compact JSON of {@link json}. */
  readonly canonical: string;
  /** The stored `msg` segment, byte for byte. */
  readonly recorded: string;
  /**
   * Whether stored bytes and emitted bytes agree.
   *
   * They disagree on a minority of lines: the recorder wrote non-ASCII code
   * points as `\uXXXX` escapes, while the replay engine serialises the parsed
   * message and JSON.stringify writes those characters literally. The two texts
   * are the same JSON, and the difference is exactly that escaping - which is
   * what {@link escapingOnlyDifference} proves rather than assumes. Conflating
   * "byte-identical" with "equivalent" would either hide a real loss or fail on a
   * difference that carries no information.
   */
  readonly byteIdentical: boolean;
  /**
   * `true` when the stored bytes differ from {@link canonical} only by non-ASCII
   * escaping.
   *
   * Always `true` for a byte-identical frame: there is nothing to differ.
   */
  readonly escapingOnlyDifference: boolean;
};

/** One recorded session: the fixture, its `s2c` frames and the derived facts. */
export type RecordedTurn = {
  /** Corpus file name without the extension, e.g. the scenario it recorded. */
  readonly name: string;
  /** The parsed fixture, ready to hand to the replay driver. */
  readonly fixture: WireFixture;
  /** Every `s2c` line, in recorded order. */
  readonly frames: readonly RecordedFrame[];
  /** The recorded event-type sequence, one entry per frame. */
  readonly types: readonly string[];
  /** Event type -> how many times the recording carries it. */
  readonly typeCounts: ReadonlyMap<string, number>;
  /** Offset of the last recorded frame; the span a `speed: 1` plan must ask for. */
  readonly span: number;
  /** How many `c2s` lines the fixture carries (they are never emitted). */
  readonly clientLines: number;
};

/** One non-blank physical line after the header, with its 1-based line number. */
function messageLines(name: string): string[] {
  const path = fileURLToPath(new URL(`${name}.jsonl`, CORPUS_DIR_URL));
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1);
}

/** The stored `msg` object of one fixture line, as a text segment. */
function storedSegment(raw: string, message: Record<string, unknown>): string {
  const marker = '"msg":';
  const at = raw.indexOf(marker);

  if (at < 0) {
    throw new Error(
      `replay corpus: a message line carries no "${marker}" segment: ${raw.slice(0, 80)}`,
    );
  }

  // A nested occurrence would be escaped (`\"msg\":`), so the first hit is the
  // top-level key. The parse check below fails loudly if that ever stops holding.
  const segment = raw.slice(at + marker.length, -1);
  const parsed: unknown = JSON.parse(segment);

  if (JSON.stringify(parsed) !== JSON.stringify(message)) {
    throw new Error(
      `replay corpus: the stored segment of ${raw.slice(0, 60)} is not the parsed message`,
    );
  }

  return segment;
}

/**
 * Rewrite `\uXXXX` escapes of non-ASCII code points into the characters
 * themselves, leaving every other escape (control characters included) alone.
 *
 * This is the one textual transformation the recorder applied, so it is what
 * decides whether a stored frame is a differently-spelled copy of the emitted
 * one. ASCII escapes such as `\u001b` are deliberately untouched: `JSON.stringify`
 * keeps those escaped too, so rewriting them would produce a false "equivalent".
 *
 * @param text a JSON text
 * @returns the same text with non-ASCII escapes resolved
 */
function unescapeNonAscii(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex: string) => {
    const code = Number.parseInt(hex, 16);
    return code > 0x7f ? String.fromCharCode(code) : whole;
  });
}

/** Build the derived view of one recorded fixture line. */
function toFrame(
  line: WireFixtureLine,
  lineNumber: number,
  raw: string | undefined,
): RecordedFrame {
  if (raw === undefined) {
    throw new Error(`replay corpus: no stored text for fixture line ${String(lineNumber)}`);
  }

  const type = line.msg["type"];

  if (typeof type !== "string" || type.length === 0) {
    throw new Error(
      `replay corpus: the frame on fixture line ${String(lineNumber)} carries no event type`,
    );
  }

  const canonical = JSON.stringify(line.msg);
  const stored = storedSegment(raw, line.msg);

  return {
    at: line.at,
    byteIdentical: canonical === stored,
    canonical,
    escapingOnlyDifference: unescapeNonAscii(stored) === canonical,
    eventType: type,
    json: line.msg,
    line: lineNumber,
    recorded: stored,
  };
}

/**
 * Read one recording and derive everything the suite asserts on.
 *
 * The fixture goes through the frozen parser (`loadFixture`), so a corpus file
 * that drifts from the frozen format fails here with that parser's own message
 * rather than with a later assertion.
 *
 * @param name corpus file name without the extension
 * @returns the recording, its frames and the derived sequences
 */
export async function readTurn(name: string): Promise<RecordedTurn> {
  const path = fileURLToPath(new URL(`${name}.jsonl`, CORPUS_DIR_URL));
  const fixture = await loadFixture(path);
  const stored = messageLines(name);

  if (stored.length !== fixture.lines.length) {
    throw new Error(
      `replay corpus: ${name} has ${String(stored.length)} message lines but the parser returned ` +
        `${String(fixture.lines.length)}; the raw and parsed views are out of step`,
    );
  }

  const frames: RecordedFrame[] = [];
  const typeCounts = new Map<string, number>();
  let span = 0;
  let clientLines = 0;

  for (const [index, line] of fixture.lines.entries()) {
    if (line.dir === "c2s") {
      clientLines += 1;
      continue;
    }

    const frame = toFrame(line, index + 1, stored[index]);

    frames.push(frame);
    typeCounts.set(frame.eventType, (typeCounts.get(frame.eventType) ?? 0) + 1);
    span = frame.at;
  }

  return {
    clientLines,
    fixture,
    frames,
    name,
    span,
    typeCounts,
    types: frames.map((frame) => frame.eventType),
  };
}

/**
 * Every recording in the corpus, in file-name order.
 *
 * @returns the seven recorded sessions
 */
export async function readCorpus(): Promise<RecordedTurn[]> {
  const names = readdirSync(fileURLToPath(CORPUS_DIR_URL))
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => entry.slice(0, -".jsonl".length))
    .sort();

  return Promise.all(names.map((name) => readTurn(name)));
}

/** Corpus-wide totals, all derived; nothing here is a transcribed count. */
export type CorpusTotals = {
  readonly frames: number;
  readonly distinctTypes: readonly string[];
  readonly typeCounts: ReadonlyMap<string, number>;
  /** The type carried most often, and how often. */
  readonly dominant: { readonly type: string; readonly count: number };
  /** Frames whose stored bytes differ from the replay engine's serialisation. */
  readonly rewritten: number;
  /** Frames whose stored bytes differ in any way other than non-ASCII escaping. */
  readonly lostInRewriting: readonly string[];
};

/**
 * Add up the corpus.
 *
 * @param turns every recorded turn
 * @returns the totals the suite pins the documented corpus facts against
 */
export function corpusTotals(turns: readonly RecordedTurn[]): CorpusTotals {
  const typeCounts = new Map<string, number>();
  const lostInRewriting: string[] = [];
  let frames = 0;
  let rewritten = 0;

  for (const turn of turns) {
    for (const frame of turn.frames) {
      frames += 1;
      rewritten += frame.byteIdentical ? 0 : 1;
      typeCounts.set(frame.eventType, (typeCounts.get(frame.eventType) ?? 0) + 1);

      if (!frame.byteIdentical && !frame.escapingOnlyDifference) {
        lostInRewriting.push(`${turn.name}:${String(frame.line)}`);
      }
    }
  }

  let dominant = { count: 0, type: "" };

  for (const [type, count] of typeCounts) {
    if (count > dominant.count) {
      dominant = { count, type };
    }
  }

  return {
    distinctTypes: [...typeCounts.keys()],
    dominant,
    frames,
    lostInRewriting,
    rewritten,
    typeCounts,
  };
}

/**
 * The recording the suite exercises in depth.
 *
 * Selected by **shape**, never by name: the corpus file with the most distinct
 * event types, ties broken by frame count and then by file name. A name-based
 * selection would keep passing after the corpus was re-recorded into a file that
 * no longer carries the shapes the suite is about.
 *
 * @param turns every recorded turn
 * @returns the turn with the richest event vocabulary
 */
export function richestTurn(turns: readonly RecordedTurn[]): RecordedTurn {
  const ranked = [...turns].sort(
    (left, right) =>
      right.typeCounts.size - left.typeCounts.size ||
      right.frames.length - left.frames.length ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  const best = ranked[0];

  if (best === undefined) {
    throw new Error("replay corpus: no recording was read, so there is no turn to replay");
  }

  return best;
}

/* ------------------------------------------------------------------------- */
/* Sequence comparison                                                       */
/* ------------------------------------------------------------------------- */

/** One position where the rebuilt sequence and the recording disagree. */
export type SequenceGap = {
  readonly index: number;
  /** What the recording has here, or `undefined` when the rebuild stopped short. */
  readonly expected: string | undefined;
  /** What the rebuild has here, or `undefined` when it ran long. */
  readonly actual: string | undefined;
};

/** The verdict of {@link diffEventSequence}. */
export type SequenceDiff = {
  /** Every differing position, lowest first; empty means the sequences agree. */
  readonly gaps: readonly SequenceGap[];
  /** `actual.length - expected.length`; non-zero means frames were lost or doubled. */
  readonly lengthDelta: number;
  /**
   * Whether the two sequences carry the same types the same number of times,
   * ignoring order.
   *
   * This is the field that makes the suite's honesty checkable. On a reordered
   * run it is `true` and {@link gaps} is non-empty, which is precisely the state a
   * count-only assertion cannot distinguish from a correct run: the order
   * assertion is the only thing doing the work, and the planted-reorder case
   * proves it.
   */
  readonly sameMultiset: boolean;
};

/**
 * Compare two event sequences position by position.
 *
 * Order-sensitive **and** count-sensitive, and the two answers are reported
 * separately so a failure says which property broke (a swap keeps the multiset, a
 * loss does not).
 *
 * @param expected the recorded sequence
 * @param actual what the client delivered
 * @returns the gaps, the length delta and the multiset verdict
 */
export function diffEventSequence(
  expected: readonly string[],
  actual: readonly string[],
): SequenceDiff {
  const gaps: SequenceGap[] = [];
  const length = Math.max(expected.length, actual.length);

  for (let index = 0; index < length; index += 1) {
    const want = expected[index];
    const got = actual[index];

    if (want !== got) {
      gaps.push({ actual: got, expected: want, index });
    }
  }

  const sortedExpected = [...expected].sort();
  const sortedActual = [...actual].sort();

  return {
    gaps,
    lengthDelta: actual.length - expected.length,
    sameMultiset:
      sortedExpected.length === sortedActual.length &&
      sortedExpected.every((type, index) => type === sortedActual[index]),
  };
}

/**
 * Render a diff as the failure message a reader can act on.
 *
 * @param label what was compared
 * @param diff the verdict
 * @returns a one-block description naming the first few gaps
 */
export function formatDiff(label: string, diff: SequenceDiff): string {
  const lines = [
    `${label}: ${String(diff.gaps.length)} position(s) differ ` +
      `(length delta ${String(diff.lengthDelta)}, same multiset: ${String(diff.sameMultiset)})`,
  ];

  for (const gap of diff.gaps.slice(0, 8)) {
    lines.push(
      `  [${String(gap.index)}] recorded ${String(gap.expected)} / delivered ${String(gap.actual)}`,
    );
  }

  if (diff.gaps.length > 8) {
    lines.push(`  ... ${String(diff.gaps.length - 8)} more`);
  }

  return lines.join("\n");
}

/** Count the types of one delivered sequence, for a per-type comparison. */
export function countTypes(sequence: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const type of sequence) {
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  return counts;
}

/**
 * The recorded sequence with two adjacent positions swapped, computed rather than
 * replayed.
 *
 * @param sequence the recorded sequence
 * @param index the first of the two positions
 * @returns a copy with `index` and `index + 1` exchanged
 */
export function swapAdjacent(sequence: readonly string[], index: number): string[] {
  const copy = [...sequence];
  const first = copy[index];
  const second = copy[index + 1];

  if (first === undefined || second === undefined) {
    throw new Error(
      `swapAdjacent: no adjacent pair at ${String(index)} in a ${String(sequence.length)}-long sequence`,
    );
  }

  copy[index] = second;
  copy[index + 1] = first;

  return copy;
}

/* ------------------------------------------------------------------------- */
/* Clock                                                                     */
/* ------------------------------------------------------------------------- */

/** The clock the replay driver sees, plus the record of what it asked for. */
export type RecordingClock = {
  readonly clock: Clock;
  /** Every delay requested, in request order. */
  readonly sleeps: readonly number[];
  /** Sum of the requested delays: the recording's span at `speed: 1`. */
  total(): number;
};

/**
 * A clock that records what it was asked to wait for and waits for none of it.
 *
 * Why not the frozen `createInstantClock`: its `sleep` is `() => Promise.resolve()`
 * and it keeps no record, so a case could not tell "the driver honoured the
 * recorded offsets" from "the driver emitted everything at once". Keeping the
 * request is the assertion; resolving the promise immediately is the budget.
 *
 * @returns the clock and its request log
 */
export function createRecordingClock(): RecordingClock {
  const sleeps: number[] = [];

  return {
    clock: {
      now: () => 0,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
    sleeps,
    total: () => sleeps.reduce((sum, ms) => sum + ms, 0),
  };
}

/* ------------------------------------------------------------------------- */
/* The fake server                                                           */
/* ------------------------------------------------------------------------- */

/** What `startFakeServer` resolves with in replay mode. */
export type ReplayServerHandle = {
  readonly url: string;
  readonly port: number;
  /** Every frame the server received, in arrival order. */
  readonly received: readonly string[];
  /** Every frame replay emitted, in emission order. */
  readonly emitted: readonly string[];
  close(): Promise<void>;
};

/** The subset of the fake server's options this suite uses. */
type ReplayServerOptions = {
  mode: "replay";
  token: string;
  replay: { fixture: WireFixture; plan: ReplayPlan; clock: Clock };
};

/** The subset of the fake server's module surface this suite uses. */
type FakeServerModule = {
  startFakeServer(options: ReplayServerOptions): Promise<ReplayServerHandle>;
};

let fakeServerModule: Promise<FakeServerModule> | undefined;

/**
 * Load `fixtures/engine/fake-server.mjs`.
 *
 * Dynamically, because `tsconfig.base.json` sets `allowJs: false` and the fixture
 * tree ships no declarations: a static specifier would fail typecheck. The
 * module is cached; a failed load is not, so one bad import cannot poison the
 * rest of the run.
 *
 * @returns the module's replay-capable surface
 */
async function loadFakeServer(): Promise<FakeServerModule> {
  fakeServerModule ??= import(
    pathToFileURL(
      fileURLToPath(new URL("../../../../../fixtures/engine/fake-server.mjs", import.meta.url)),
    ).href
  )
    .then((module) => module as FakeServerModule)
    .catch((error: unknown) => {
      fakeServerModule = undefined;
      throw error;
    });

  return fakeServerModule;
}

/* ------------------------------------------------------------------------- */
/* Sessions                                                                  */
/* ------------------------------------------------------------------------- */

/** A replay in progress: one server, one transport, one channel, one clock. */
export type ReplaySession = {
  readonly turn: RecordedTurn;
  readonly plan: ReplayPlan;
  readonly clock: RecordingClock;
  /** Frames the plan asks for; the settle target and the exact expected count. */
  readonly expectedFrames: number;
  /** Delays the plan will request from the clock, in emission order. */
  readonly plannedDelays: readonly number[];
  /** Raw frame text as it arrived, in arrival order. */
  readonly frameTexts: readonly string[];
  /** Frames the channel delivered to its event subscriber, in arrival order. */
  readonly events: readonly EngineEventFrame[];
  /** Diagnostics the channel produced, in arrival order. */
  readonly diagnostics: readonly { readonly kind: string; readonly subject: string }[];
  /** The server, for `emitted` and an idempotent close. */
  readonly server: ReplayServerHandle;
  /** Frames the server believes it emitted, in emission order. */
  emitted(): readonly string[];
  /** Whether the connection has been opened. */
  isConnected(): boolean;
  /** Whether {@link ReplaySession.close} has run. */
  isClosed(): boolean;
  /** Start the one allowed client connection. Idempotent. */
  connect(): Promise<void>;
  /** Wait until every planned frame has arrived, or fail naming the shortfall. */
  settle(budgetMs?: number): Promise<void>;
  /** Close the transport, the channel and the server. Idempotent. */
  close(): Promise<void>;
};

/** Sessions built during the current test, so teardown can close them. */
const liveSessions: ReplaySession[] = [];

/**
 * Register a session for teardown.
 *
 * @param session the session to close if its case forgets
 * @returns the same session
 */
export function trackSession<T extends ReplaySession>(session: T): T {
  liveSessions.push(session);
  return session;
}

/** How many sessions have not been closed yet. */
export function openSessionCount(): number {
  return liveSessions.length;
}

/**
 * Close every session a case built.
 *
 * Awaited by each suite's `afterEach`: a server whose `close()` is not awaited
 * still holds its listening socket, and a leaked port is a failure in whichever
 * case runs next.
 */
export async function closeSessions(): Promise<void> {
  while (liveSessions.length > 0) {
    const session = liveSessions.pop();

    if (session !== undefined) {
      await session.close();
    }
  }
}

/** Everything {@link startReplaySession} needs. */
export type StartReplayOptions = {
  readonly turn: RecordedTurn;
  /** Plan to run; defaults to the whole recording at the suite's speed. */
  readonly plan?: ReplayPlan;
  /** Connect immediately; `false` leaves the connection to the caller. */
  readonly connect?: boolean;
};

/**
 * Start a replay of one recording.
 *
 * The server is started **before** the client connects, and the driver waits for
 * a socket before its first emission (the single-live-connection rule), so a case
 * -connection rule), so a case may inspect `server.emitted` in between.
 *
 * @param options the recording and an optional plan
 * @returns the session, already registered for teardown
 */
export async function startReplaySession(options: StartReplayOptions): Promise<ReplaySession> {
  const plan = options.plan ?? { speed: REPLAY_SPEED };
  const clock = createRecordingClock();
  const replay = await loadReplayModule();
  const steps = replay.buildReplaySteps(options.turn.fixture, plan);
  const plannedDelays = steps.flatMap((step) => (step.kind === "frame" ? [step.delayMs] : []));
  const fakeServer = await loadFakeServer();
  const server = await fakeServer.startFakeServer({
    mode: "replay",
    replay: { clock: clock.clock, fixture: options.turn.fixture, plan },
    token: REPLAY_TOKEN,
  });

  const frameTexts: string[] = [];
  const events: EngineEventFrame[] = [];
  const diagnostics: { kind: string; subject: string }[] = [];
  const fake = trackClock(makeClock());
  const channel: EngineChannel = trackChannel(
    createChannel({
      agentId: "agent-1",
      clock: fake.clock,
      // Replay never answers a command, so a write
      // here could only produce a frame the recording does not contain.
      write: () => undefined,
    }),
  );
  let transport: EngineTransport | undefined;
  let closed = false;

  channel.onEvent((frame) => {
    events.push(frame);
  });
  channel.onDiagnostic((record) => {
    diagnostics.push({ kind: record.kind, subject: record.subject });
  });

  const session: ReplaySession = {
    clock,
    connect: async () => {
      if (transport !== undefined) {
        return;
      }

      const opened = await openTransport(server.url, REPLAY_TOKEN, {
        timeoutMs: CONNECT_BUDGET_MS,
      });

      transport = opened;
      opened.onFrame((frame) => {
        frameTexts.push(frame.raw);
        channel.ingest(frame.raw);
      });
    },

    events,
    expectedFrames: plannedDelays.length,
    frameTexts,

    close: async () => {
      if (closed) {
        return;
      }

      closed = true;
      transport?.close();
      channel.close();

      try {
        await server.close();
      } finally {
        const at = liveSessions.indexOf(session);

        if (at >= 0) {
          liveSessions.splice(at, 1);
        }
      }
    },
    diagnostics,
    emitted: () => server.emitted,
    isClosed: () => closed,
    isConnected: () => transport !== undefined,
    plannedDelays,
    plan,
    server,
    settle: async (budgetMs = SETTLE_BUDGET_MS) => {
      const deadline = Date.now() + budgetMs;

      while (frameTexts.length < plannedDelays.length && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
      }

      if (frameTexts.length !== plannedDelays.length) {
        throw new Error(
          `replay did not settle: ${String(frameTexts.length)} of ` +
            `${String(plannedDelays.length)} planned frame(s) arrived within ` +
            `${String(budgetMs)} ms. The plan and the recording disagree, or the driver ` +
            "stalled on a socket - in replay mode a frame waits for a connection " +
            "so this is a wiring failure, not a slow machine.",
        );
      }

      // Delivery is synchronous inside `onFrame` (`channel.ingest`), so the two
      // counters agreeing is a property worth asserting rather than assuming.
      if (events.length !== frameTexts.length) {
        throw new Error(
          `replay delivered ${String(frameTexts.length)} frame(s) but the channel emitted ` +
            `${String(events.length)} event(s); a frame was swallowed on the way in`,
        );
      }
    },
    turn: options.turn,
  };

  liveSessions.push(session);

  try {
    if (options.connect !== false) {
      await session.connect();
    }
  } catch (error) {
    await session.close();
    throw error;
  }

  return session;
}

/**
 * Replay a recording and return the rebuilt event sequence.
 *
 * The convenience form for the cases that want only the sequence: it starts a
 * session, connects, settles and closes before returning, so a case cannot leak
 * one. The cases that need the intermediate states use
 * {@link startReplaySession} directly.
 *
 * @param options the recording and an optional plan
 * @returns the delivered events, the arrival texts and the timing record
 */
export async function replayRecording(options: StartReplayOptions): Promise<{
  readonly turn: RecordedTurn;
  readonly plan: ReplayPlan;
  readonly types: readonly string[];
  readonly frameTexts: readonly string[];
  readonly clock: RecordingClock;
  readonly expectedFrames: number;
  readonly wallMs: number;
}> {
  const startedAt = Date.now();
  const session = await startReplaySession(options);

  try {
    await session.settle();

    return {
      clock: session.clock,
      expectedFrames: session.expectedFrames,
      frameTexts: [...session.frameTexts],
      plan: session.plan,
      turn: session.turn,
      types: session.events.map((frame) => frame.type),
      wallMs: Date.now() - startedAt,
    };
  } finally {
    await session.close();
  }
}

/**
 * The replay injection that swaps two adjacent recorded frames of *different*
 * types.
 *
 * Chosen from the data rather than hard-coded, and the "different types"
 * condition is not cosmetic: swapping two frames of the same type leaves the
 * type sequence unchanged, which makes the planted case a tautology. That is the
 * equivalent-mutant trap, and this helper refuses it by
 * construction.
 *
 * @param turn the recording to perturb
 * @returns the injection and the position it swaps
 */
export function reorderInjection(turn: RecordedTurn): {
  readonly injection: ReplayInjection;
  readonly index: number;
} {
  for (let index = 0; index + 1 < turn.frames.length; index += 1) {
    const first = turn.frames[index];
    const second = turn.frames[index + 1];

    if (first === undefined || second === undefined) {
      break;
    }

    if (first.eventType !== second.eventType) {
      return { index, injection: { kind: "reorder", lines: [first.line, second.line] } };
    }
  }

  throw new Error(
    "replay corpus: the selected recording has no adjacent pair of differing event types, " +
      "so a reorder injection could not change the type sequence and the planted case " +
      "would prove nothing",
  );
}

/**
 * The replay injection that repeats one recorded frame.
 *
 * @param turn the recording to perturb
 * @param times how many extra copies to emit
 * @returns the injection and the frame it repeats
 */
export function duplicateInjection(
  turn: RecordedTurn,
  times = 2,
): { readonly injection: ReplayInjection; readonly frame: RecordedFrame } {
  const middle = turn.frames[Math.floor(turn.frames.length / 2)];

  if (middle === undefined) {
    throw new Error("replay corpus: the selected recording carries no frames to duplicate");
  }

  return { frame: middle, injection: { kind: "duplicate", line: middle.line, times } };
}
