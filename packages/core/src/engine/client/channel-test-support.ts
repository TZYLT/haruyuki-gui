/**
 * Shared doubles for the channel kernel tests.
 *
 * Split out of `channel.test.ts` for the repository's file-size limit, following
 * `engine-test-support.ts`: scaffolding only, so none of it belongs to a suite.
 * The file does not end in `.test.ts` on purpose - vitest collects by that suffix,
 * so nothing here is ever treated as a test file, and a helper that stops being
 * used cannot silently pass as an empty suite.
 *
 * What lives here and why it is shared across three suites:
 *
 * - **`makeClock`** - a fake clock, because a single real `slow`-family wait would
 *   cost three minutes of wall-clock time, which the test suite forbids outright.
 *   It implements the two properties a naive fake gets wrong: a cancelled timer
 *   never fires, and a timer scheduled *while* another is firing is honoured in
 *   deadline order rather than run immediately.
 * - **`makeInlineClock`** - the adversarial clock that fires a timer the instant it
 *   is scheduled. It is what proves the in-flight entry is inserted before its
 *   timer starts; see `channel.test.ts`.
 * - **`makeReader` / `makeProbe`** - ports keyed on *test-owned marker fields*
 *   (`reply`, `capabilityProbe`), never on engine vocabulary. That is what lets the
 *   suites exercise the real seam the send path plugs into while keeping this
 *   directory free of wire ids.
 * - **`makeHarness`** - one channel with the doubles wired in and both
 *   subscriptions attached, so a test asserts on what a consumer would see.
 */

import { EngineChannel, createChannel } from "./channel";
import type {
  CapabilityProbePort,
  CapabilityProbeReading,
  ChannelClock,
  ChannelTimer,
  ChannelWriter,
  DecodedResponse,
  EngineFrameReader,
} from "./channel";
import type { EngineClientError } from "./errors";
import type { CommandRequest, CommandResult, EngineEventFrame } from "./types";

/* ------------------------------------------------------------------------- */
/* Doubles                                                                   */
/* ------------------------------------------------------------------------- */

/** A clock whose timers only fire when a test advances it. */
export interface FakeClock {
  readonly clock: ChannelClock;
  /** Advance time, firing every timer whose deadline is reached, in order. */
  advance(ms: number): void;
  /** Timers not yet fired or cancelled. */
  pending(): number;
  /** Delays requested, in request order, so a budget can be asserted exactly. */
  readonly delays: number[];
}

/**
 * Build a fake clock.
 *
 * Implements the two properties the kernel depends on and that a naive fake
 * usually gets wrong: a cancelled timer never fires, and a timer scheduled while
 * another is firing is honoured in deadline order (not run immediately).
 *
 * @param start the initial epoch in milliseconds
 * @returns the clock plus the test-side controls
 */
export function makeClock(start = 1_700_000_000_000): FakeClock {
  let now = start;
  let nextHandle = 1;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const delays: number[] = [];

  const clock: ChannelClock = {
    now: () => now,
    startTimer: (callback, delayMs) => {
      const handle = nextHandle;
      nextHandle += 1;
      delays.push(delayMs);
      timers.set(handle, { due: now + delayMs, callback });
      return handle as ChannelTimer;
    },
    stopTimer: (timer) => {
      if (timer === undefined) {
        return;
      }
      timers.delete(timer as number);
    },
  };

  return {
    clock,
    delays,
    pending: () => timers.size,
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        let chosen: number | undefined;
        let chosenDue = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of timers) {
          if (timer.due <= target && timer.due < chosenDue) {
            chosen = handle;
            chosenDue = timer.due;
          }
        }
        if (chosen === undefined) {
          break;
        }
        const timer = timers.get(chosen);
        timers.delete(chosen);
        now = chosenDue;
        timer?.callback();
      }
      now = target;
    },
  };
}

/**
 * A clock that runs the callback the instant it is scheduled.
 *
 * This is the adversarial case for insertion order: if the kernel starts its
 * timer before the table holds the entry, the expiry finds nothing, the entry is
 * then inserted holding an already-spent timer, and the slot leaks forever with
 * no TIMEOUT. Real recurrence: a fake clock already past its delay.
 *
 * @returns the clock and the number of callbacks it ran
 */
export function makeInlineClock(): { clock: ChannelClock; fired(): number } {
  let now = 1_700_000_000_000;
  let count = 0;
  return {
    fired: () => count,
    clock: {
      now: () => now,
      startTimer: (callback) => {
        count += 1;
        now += 1;
        callback();
        return "inline";
      },
      stopTimer: () => undefined,
    },
  };
}

/** A writer that records every call instead of touching a socket. */
export interface RecordingWriter {
  readonly write: ChannelWriter;
  readonly calls: { request: CommandRequest; requestId: string | undefined }[];
}

/**
 * @returns the writer and the calls it recorded
 */
export function makeWriter(): RecordingWriter {
  const calls: { request: CommandRequest; requestId: string | undefined }[] = [];
  return {
    calls,
    write: (request, requestId) => {
      calls.push({ request, requestId });
    },
  };
}

/** The test-owned marker field a probe frame carries. */
type ProbeFrame = { capabilityProbe?: CapabilityProbeReading };

/**
 * A probe that reads the test marker.
 *
 * The real probe will read the engine's own field for the advertised flags and
 * slash commands; the channel must not care which, so this double proves the
 * channel handles the *three-state* question and the production port supplies
 * the field names.
 *
 * @returns the probe port
 */
export function makeProbe(): CapabilityProbePort {
  return {
    read: (raw) => {
      if (typeof raw !== "object" || raw === null) {
        return undefined;
      }
      return (raw as ProbeFrame).capabilityProbe;
    },
  };
}

/** The test-owned marker field a response frame carries. */
type ReplyFrame = {
  reply?: { requestId: string; ok: boolean; data?: unknown; error?: EngineClientError };
};

/**
 * A reader that routes on `type` and recognises a response by the test marker.
 *
 * As with the probe, the engine's own correlation field name stays out of this
 * file: proving that the kernel settles what the reader reports is the point.
 *
 * @returns the reader port
 */
export function makeReader(): EngineFrameReader {
  return {
    typeOf: (raw) => {
      if (typeof raw !== "object" || raw === null) {
        return undefined;
      }
      const type = (raw as { type?: unknown }).type;
      return typeof type === "string" && type.length > 0 ? type : undefined;
    },
    responseOf: (raw): DecodedResponse | undefined => {
      if (typeof raw !== "object" || raw === null) {
        return undefined;
      }
      const reply = (raw as ReplyFrame).reply;
      if (reply === undefined) {
        return undefined;
      }
      if (reply.ok) {
        return { requestId: reply.requestId, ok: true, data: reply.data };
      }
      return {
        requestId: reply.requestId,
        ok: false,
        error: reply.error ?? { code: "REJECTED", detail: "refused by the double" },
      };
    },
  };
}

/** Build a frame that the test reader treats as a correlated answer. */
export function responseFrame(
  requestId: string,
  options: { ok?: boolean; data?: unknown; error?: EngineClientError } = {},
): string {
  const ok = options.ok ?? true;
  return JSON.stringify({
    type: "known.event",
    reply: ok
      ? { requestId, ok: true, data: options.data }
      : { requestId, ok: false, error: options.error },
  });
}

/** Build a plain push frame. */
export function eventFrame(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

/** The structured form of a channel under test. */
export interface Harness {
  readonly channel: EngineChannel;
  readonly clock: FakeClock;
  readonly writer: RecordingWriter;
  readonly events: EngineEventFrame[];
  readonly records: { kind: string; subject: string; engineText?: string }[];
}

/**
 * Build a channel with the doubles wired in and subscriptions attached.
 *
 * @param overrides options to override for one test
 * @returns the channel and the observable side effects
 */
/**
 * Harnesses built during the current test, so `afterEach` can close them.
 *
 * Every channel a test builds is closed when that test ends. This is not
 * tidiness: a channel left open with in-flight entries holds timers and promises,
 * and the *next* test inherits them. The failure that produces is the worst kind
 * to debug - it passes in isolation, fails in a full run, and shows up as a
 * `testTimeout` thirty seconds later with no indication of which test leaked.
 *
 * The registration is automatic (every `makeHarness` call adds itself), so a new
 * test cannot forget it.
 */
const liveHarnesses: EngineChannel[] = [];

/**
 * Every fake clock a test built, so teardown can prove nothing is still pending.
 *
 * Kept separately from {@link liveHarnesses} because the two catch different
 * leaks. A channel left open holds entries *and* timers; a clock inspected on its
 * own catches a timer that survived a channel that was closed - for example one
 * created outside `makeHarness`, or a `takeEntry` path that forgot to cancel.
 */
const liveClocks: FakeClock[] = [];

/**
 * Register a clock for teardown inspection.
 *
 * Exported so a test that builds its own channel - the inline-clock case, which
 * needs a clock `makeHarness` cannot supply - can still be checked. A test that
 * constructs a channel directly and does not register its clock is a test whose
 * leaks no one will see until they surface as a thirty-second timeout in an
 * unrelated case.
 *
 * @param clock the fake clock to inspect at teardown
 * @returns the same clock, for use in a single expression
 */
export function trackClock<T extends FakeClock>(clock: T): T {
  liveClocks.push(clock);
  return clock;
}

/**
 * Register a channel a test built without `makeHarness`, so teardown closes it.
 *
 * The inline-clock case needs this: its clock fires a timer the moment it is
 * scheduled, which is precisely what `makeHarness` cannot provide. A channel
 * created directly and *not* registered here is a leak no assertion will see.
 *
 * @param channel the channel to close at teardown
 * @returns the same channel, for use in a single expression
 */
export function trackChannel<T extends EngineChannel>(channel: T): T {
  liveHarnesses.push(channel);
  return channel;
}

/**
 * Timers still scheduled on any fake clock a test built.
 *
 * This is the signal that a channel leaked. A live timer means an in-flight entry
 * that was never settled, which in turn means a promise that will never resolve -
 * and in a real run it is the *next* test that pays for it.
 *
 * @returns the total across every tracked clock
 */
export function pendingTimerCount(): number {
  let total = 0;
  for (const clock of liveClocks) {
    total += clock.pending();
  }
  return total;
}

/**
 * Close every channel a test built and drop its timers.
 *
 * `close()` settles each in-flight request with `NOT_CONNECTED` and clears the
 * timer, so nothing survives into the next test. Errors are swallowed on purpose:
 * this is teardown, and a channel that throws while closing must not turn a
 * passing test red for a reason unrelated to what it asserted.
 */
export function closeHarnesses(): void {
  while (liveHarnesses.length > 0) {
    const channel = liveHarnesses.pop();
    try {
      channel?.close();
    } catch {
      // Teardown must not fail the test it is cleaning up after.
    }
  }
}

/**
 * Teardown shared by every suite: close, then demand the clock is silent.
 *
 * The invariant being checked is **"`close()` frees everything"**, not "no test
 * ever leaves a request in flight". Those are different claims and only the first
 * one is true: several tests deliberately leave entries in the table to assert on
 * its contents, and that is legitimate because `close()` settles them. Asserting
 * before closing would red those tests for doing the right thing.
 *
 * What must never survive is a timer that `close()` failed to cancel. Such a timer
 * is the real defect: it holds a promise that can never settle, it outlives the
 * test, and in a full run the *next* test pays for it by timing out. That is the
 * failure mode this guard exists to catch - so the guard runs after closing, and it
 * is only vacuous if `close()` is broken in a way it will then report.
 *
 * The assertion is on the fake clock because a timer is the one leak that cannot be
 * quietly absorbed: unlike an unresolved promise, it is observable.
 *
 * @throws when any fake clock still has a scheduled timer after closing
 */
export function assertNoLeakedTimers(): void {
  closeHarnesses();
  const pending = pendingTimerCount();
  liveClocks.length = 0;

  if (pending !== 0) {
    throw new Error(
      `teardown found ${String(pending)} timer(s) still scheduled after closing the channel. ` +
        "`close()` is supposed to settle every in-flight entry and cancel its timer; " +
        "a timer that survives it holds a promise that can never settle, and in a full " +
        "run an unrelated test pays for it by timing out.",
    );
  }
}

/**
 * Build a channel with the doubles wired in and subscriptions attached.
 *
 * @param overrides options to override for one test
 * @returns the channel and the observable side effects
 */
export function makeHarness(overrides: Partial<Parameters<typeof createChannel>[0]> = {}): Harness {
  const clock = makeClock();
  const writer = makeWriter();
  const events: EngineEventFrame[] = [];
  const records: { kind: string; subject: string; engineText?: string }[] = [];
  const channel = createChannel({
    agentId: "agent-1",
    write: writer.write,
    reader: makeReader(),
    probe: makeProbe(),
    clock: clock.clock,
    ...overrides,
  });
  channel.onEvent((frame) => events.push(frame));
  channel.onDiagnostic((record) => {
    records.push({ ...record });
  });
  liveHarnesses.push(channel);
  trackClock(clock);
  return { channel, clock, writer, events, records };
}

/**
 * Await a send that must settle without an answer ever arriving.
 *
 * Every `send` that is expected to refuse (a full table, a duplicate id, a
 * not-connected channel, a closed channel) or to fire-and-forget (a silent or
 * untracked capability) settles within a microtask. A *tracked* send does not: it
 * waits for an answer that no test is going to inject.
 *
 * That difference is what makes this helper worth having. Written as a bare
 * `await`, a regression that wrongly tracks one of those sends does not fail - it
 * hangs until vitest's `testTimeout` fires, which reports "test timed out in
 * 30000ms" and names neither the regression nor the assertion. Racing the promise
 * against one macrotask turns that into an immediate, self-describing failure.
 *
 * The 0 ms timer is a real timer on purpose: the point is to let every microtask
 * in the channel settle, and a real timer is the shortest portable way to say
 * "after the current work, but not forever". One macrotask costs nothing; the
 * timeout it replaces costs thirty seconds.
 *
 * @param promise the send under test
 * @returns the result, once it settles
 * @throws when the send has not settled after one macrotask, naming the cause
 */
export async function expectSettles(promise: Promise<CommandResult>): Promise<CommandResult> {
  const unsettled = Symbol("unsettled");
  const raced = await Promise.race([
    promise,
    new Promise<typeof unsettled>((resolve) => {
      setTimeout(() => {
        resolve(unsettled);
      }, 0);
    }),
  ]);

  if (raced === unsettled) {
    throw new Error(
      "send did not settle; it was tracked in the in-flight table and no answer will come. " +
        "A refusal, a not-connected channel, or a silent/untracked capability must resolve immediately.",
    );
  }

  return raced;
}

/** A tracked capability: one of the 60 with a correlated answer. */
export const TRACKED = "conversation.sync";

/** The two capabilities that carry a request id and never answer. */
export const SILENT = ["file.watch", "file.unwatch"] as const;

/** The five commands whose wire carries no request id at all. */
export const UNTRACKED = [
  "device.setState",
  "terminal.input",
  "terminal.kill",
  "terminal.resize",
  "terminal.spawn",
] as const;
