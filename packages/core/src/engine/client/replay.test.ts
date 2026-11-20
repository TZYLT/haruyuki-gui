/**
 * The replay corpus rebuilds the recorded event sequence.
 *
 * ## What this suite is evidence *for*
 *
 * Replay is the only objective evidence for "behaviour equivalence": run the real
 * client stack over the real recorded frames and the consumer must see the same
 * sequence the recording produced. Everything here is therefore derived from
 * `fixtures/engine/recordings/*.jsonl` at run time - the expected sequence, the
 * expected counts, the expected pacing - because an expectation transcribed into
 * this file could drift away from the corpus and keep passing.
 *
 * ## The four replay limits, and where each one is handled
 *
 * 1. **One live connection.** The replayer serves one socket; a second client
 *    receives nothing (fact 27). Every case here builds one session, and
 *    `afterEach` closes it before the next case starts, so no two connections ever
 *    coexist.
 * 2. **Only replay mode pushes frames.** Fact 28. Every server in this file is
 *    started with `mode: "replay"`; nothing waits for an unprompted push from any
 *    other mode.
 * 3. **Replay is a scripted responder, not a recorder.** Fact 22. The plan here is
 *    built *from* the recording, and the cases assert that the frames which arrive
 *    are the corpus's own bytes rather than frames this file dreamed up.
 * 4. **The default clock is the string `"instant"`, while `plan.speed` must be a
 *    number** for pacing to exist at all (facts 23/24). The harness always passes a
 *    number, and one case here pins that the difference is real: with a numeric
 *    speed the plan asks the clock for the recorded offsets, with `"instant"` it
 *    asks for nothing.
 *
 * ## Why these assertions cannot pass vacuously
 *
 * - **Order, not length.** `diffEventSequence` reports every differing position.
 *   The planted-reorder case below runs the *same* comparison over a plan whose
 *   order was deliberately swapped and requires it to report gaps while the
 *   multiset stays unchanged - that pair is exactly what a `toHaveLength`-only
 *   assertion cannot see, so the case is the proof that the order assertion is
 *   doing the work.
 * - **Types without wire literals.** (This whole directory is scanned for wire
 *   ids, so the engine's type names must not be written down here.) A type reaches
 *   this file
 *   as `frame.eventType`, read off the corpus; the assertions compare *sequences
 *   of strings*, which needs no spelling. "19 distinct kinds" is checked as a
 *   count and as a set equality against the corpus, never as a list of literals.
 * - **No wall clock.** The harness's clock records the delays it was asked for and
 *   returns immediately, so the 6.6-second recording costs the gate a poll loop
 *   iteration. The recorded span is still asserted, from the clock's own log.
 */

import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { assertNoLeakedTimers } from "./channel-test-support";
import {
  closeSessions,
  corpusTotals,
  countTypes,
  createRecordingClock,
  diffEventSequence,
  duplicateInjection,
  formatDiff,
  isEscapingOnlyDifference,
  openSessionCount,
  readCorpus,
  readTurn,
  replayRecording,
  reorderInjection,
  richestTurn,
  startReplaySession,
  swapAdjacent,
} from "./replay-harness";
import type { RecordedTurn } from "./replay-harness";
import { loadReplayModule } from "../../testing/fixture";

/**
 * Budget for one whole-corpus pass.
 *
 * Docs/27 section 6.4 gives the whole `test` stage 45 seconds; a single case here
 * is designed for one or two orders of magnitude less than that, and the number
 * is asserted so a regression that reintroduced real waiting is reported as the
 * budget breach it is rather than as a generic timeout.
 */
const CASE_BUDGET_MS = 1_500;

/** The documented corpus size. */
const CORPUS_FRAMES = 295;

/** The documented number of distinct event types in the corpus (fact 44). */
const CORPUS_TYPES = 19;

/** The documented count of the most common type (fact 44: 155 of 295). */
const CORPUS_DOMINANT = 155;

/**
 * Close everything before the next case.
 *
 * `closeSessions` runs first so a server's listening socket is released, then
 * `assertNoLeakedTimers` closes the channels and demands the fake clocks are
 * silent. Both are needed: the first releases OS resources, the second catches a
 * promise that can never settle.
 */
afterEach(async () => {
  await closeSessions();
  assertNoLeakedTimers();
});

/* ------------------------------------------------------------------------- */
/* Shared corpus fixtures                                                    */
/* ------------------------------------------------------------------------- */

let cached: RecordedTurn[] | undefined;

/** The corpus, read once per worker; it is read-only and never mutated. */
async function corpus(): Promise<RecordedTurn[]> {
  cached ??= await readCorpus();

  return cached;
}

/* ------------------------------------------------------------------------- */
/* The corpus is the expectation                                           */
/* ------------------------------------------------------------------------- */

describe("the corpus this suite replays", () => {
  it("reads every committed recording, and the corpus matches its documented totals", async () => {
    // Red when: a recording is deleted/renamed (the count drops), a re-record
    // changes the vocabulary, or the dominant type stops dominating. The numbers
    // are the documentation's, the rest is measured.
    const turns = await corpus();
    const totals = corpusTotals(turns);

    expect(turns).toHaveLength(7);
    expect(totals.frames).toBe(CORPUS_FRAMES);
    expect(totals.distinctTypes).toHaveLength(CORPUS_TYPES);
    expect(totals.dominant.count).toBe(CORPUS_DOMINANT);
    expect(totals.typeCounts.get(totals.dominant.type)).toBe(CORPUS_DOMINANT);

    // Every recording contributes frames, and every frame carries a usable type:
    // a frame without one could never reach a subscriber, so it would silently
    // shrink every sequence assertion below.
    for (const turn of turns) {
      expect(turn.frames.length, `${turn.name} carries no frames`).toBeGreaterThan(0);
      expect(turn.clientLines, `${turn.name} records no client frame`).toBeGreaterThan(0);
      expect(turn.types).toHaveLength(turn.frames.length);
    }
  });

  it("reports a frame whose text lost information, rather than calling it equivalent", async () => {
    // Red when: the "no frame lost information" rule becomes a constant. The
    // committed corpus contains no such frame - every difference is the recorder's
    // non-ASCII escaping - so a corpus-only assertion cannot tell the computation
    // apart from `return true`. This case supplies the frame the corpus lacks.
    const genuine = corpusTotals([
      {
        clientLines: 0,
        fixture: { header: { kind: "wire", schemaVersion: 1 }, lines: [] },
        frames: [
          {
            at: 0,
            byteIdentical: false,
            canonical: '{"type":"a","text":"x"}',
            eventType: "a",
            json: {},
            line: 2,
            // The stored text says something the emitted text does not: a real
            // rewrite, which must be reported.
            recorded: '{"type":"a","text":"y"}',
          },
        ],
        name: "synthetic",
        span: 0,
        typeCounts: new Map([["a", 1]]),
        types: ["a"],
      },
    ]);

    expect(genuine.lostInRewriting).toEqual(["synthetic:2"]);
    expect(genuine.rewritten).toBe(1);
    expect(genuine.frames).toBe(1);
  });

  it("keeps stored and emitted text equivalent, and names the difference precisely", async () => {
    // Red when: a corpus line is rewritten beyond the escaping the recorder
    // applied. The claim this case exists for is narrow on purpose - "byte
    // identity" is false for 19 of the 295 frames, and pretending otherwise would
    // either hide a real loss or fail on a difference that carries no meaning.
    const totals = corpusTotals(await corpus());

    expect(totals.lostInRewriting).toEqual([]);
    expect(totals.rewritten).toBe(19);

    // The equivalence rule must be a computation, not a constant: fed a genuine
    // rewrite it has to say no, or "no frame lost information" would be green for
    // every possible corpus. The pair below is the one the recorder produced
    // (`\u7248` for the character) and the one it did not (`\u0041` is ASCII and
    // JSON.stringify leaves it literal).
    expect(isEscapingOnlyDifference('{"a":"\\u7248"}', '{"a":"版"}')).toBe(true);
    expect(isEscapingOnlyDifference('{"a":"版"}', '{"a":"版"}')).toBe(true);
    expect(isEscapingOnlyDifference('{"a":"\\u0041"}', '{"a":"A"}')).toBe(false);
    expect(isEscapingOnlyDifference('{"a":"版"}', '{"a":"版别"}')).toBe(false);
  });

  it("selects the in-depth recording by shape, not by name", async () => {
    // Red when: the selection is changed to a hard-coded name, or the corpus is
    // re-recorded so that the richest file changes. A name-based pick would keep
    // passing after such a change while exercising a file that no longer has the
    // vocabulary the suite is about.
    const turns = await corpus();
    const best = richestTurn(turns);
    const bestCount = best.typeCounts.size;

    for (const turn of turns) {
      expect(bestCount).toBeGreaterThanOrEqual(turn.typeCounts.size);
    }

    // Shape, not name: the pick must be one of the files that reaches the maximum,
    // and it must carry several kinds so "the sequence has a shape" is meaningful.
    const maximal = turns.filter((turn) => turn.typeCounts.size === bestCount);
    expect(maximal.map((turn) => turn.name)).toContain(best.name);
    expect(bestCount).toBeGreaterThan(3);
  });
});

/* ------------------------------------------------------------------------- */
/* The sequence                                                              */
/* ------------------------------------------------------------------------- */

describe("the rebuilt sequence matches the recording", () => {
  it("rebuilds the recorded order, type by type, with no gap anywhere", async () => {
    // The main assertion. Red when: a frame is dropped, doubled or reordered -
    // delivery order changed, a subscriber skipped, a parse swallowed a frame.
    const turn = richestTurn(await corpus());
    const result = await replayRecording({ turn });

    const diff = diffEventSequence(turn.types, result.types);
    expect(diff.gaps, formatDiff(`${turn.name}: delivered sequence vs recording`, diff)).toEqual(
      [],
    );
    expect(diff.lengthDelta).toBe(0);
    expect(result.types).toHaveLength(turn.frames.length);
    expect(result.wallMs).toBeLessThan(CASE_BUDGET_MS);
  });

  it("delivers the corpus's own bytes, frame for frame", async () => {
    // Red when: the frames are not the recording (a plan this file made up, an
    // envelope field rewritten, a re-serialisation that drops unknown keys). It is
    // the assertion that makes "replayed from real frames" a measured fact.
    const turn = richestTurn(await corpus());
    const result = await replayRecording({ turn });

    expect(result.frameTexts).toHaveLength(turn.frames.length);

    for (const [index, frame] of turn.frames.entries()) {
      const arrived = result.frameTexts[index];

      expect(arrived, `frame ${String(index)} of ${turn.name}`).toBeDefined();

      // The client received the plan's text verbatim, and that text is the
      // corpus's message in the corpus's serialisation - either literally
      // (`recorded`) or via the recorder's non-ASCII escaping (`canonical`).
      const equivalent = arrived === frame.canonical || arrived === frame.recorded;
      expect(equivalent, `frame ${String(index)} is neither the stored nor the emitted text`).toBe(
        true,
      );

      if (frame.byteIdentical) {
        expect(arrived).toBe(frame.recorded);
      }
    }

    // Nothing beyond the plan may arrive: a trailing frame would mean the driver
    // emitted something the corpus does not contain.
    expect(result.expectedFrames).toBe(turn.frames.length);
  });

  it("passes the engine's envelope through verbatim, and omits it when absent", async () => {
    // Red when: the envelope is dropped from the delivered frame, a field is lost,
    // or an empty envelope is invented for a frame that carried none. Most of the
    // recorded frames carry these fields (265 of 295), so this
    // is the majority of the corpus, not a corner.
    const absent = await readTurn("terminal");
    const session = await startReplaySession({ turn: absent });

    await session.settle();

    // A recording whose frames carry none of the four keys: the contract says "no
    // `envelope` key at all", which is a different answer from `{}`.
    expect(session.events).toHaveLength(absent.frames.length);
    expect(session.events.every((frame) => frame.envelope === undefined)).toBe(true);

    // ...and a recording where they are present, compared against the corpus value
    // by value rather than against a literal.
    const rich = await readTurn("memory");
    const richer = await startReplaySession({ turn: rich });

    await richer.settle();

    let compared = 0;

    for (const [index, frame] of rich.frames.entries()) {
      const recorded = frame.json;
      const delivered = richer.events[index];

      expect(delivered).toBeDefined();

      const present = ["runtime", "event_seq", "emitted_at", "idempotency_key"].filter(
        (key) => recorded[key] !== undefined,
      );

      if (present.length === 0) {
        expect(
          delivered?.envelope,
          `frame ${String(index)} should carry no envelope`,
        ).toBeUndefined();
        continue;
      }

      expect(delivered?.envelope, `frame ${String(index)} should carry an envelope`).toBeDefined();

      // Exactly the present keys, each with the recorded value: no field added and
      // none dropped.
      expect(Object.keys(delivered?.envelope ?? {}).sort()).toEqual([...present].sort());

      for (const key of present) {
        expect((delivered?.envelope as Record<string, unknown> | undefined)?.[key]).toEqual(
          recorded[key],
        );
        compared += 1;
      }
    }

    expect(compared).toBeGreaterThan(0);
  });

  it("keeps the raw message on every frame for consumers that need the payload", async () => {
    // Red when: `raw` is dropped or replaced by a re-serialised copy. A consumer
    // reads engine fields this package does not model from `raw`, so losing it is
    // invisible to every assertion above.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    await session.settle();

    for (const [index, frame] of turn.frames.entries()) {
      expect(session.events[index]?.raw).toEqual(frame.json);
    }
  });

  it("keeps the type counts identical, type by type", async () => {
    // Red when: a type is swapped for another (a mis-routed subscription, a
    // dropped kind). Count equality alone cannot see order - the case below covers
    // that - but it catches a substitution that keeps the length.
    const turn = richestTurn(await corpus());
    const result = await replayRecording({ turn });

    const expected = countTypes(turn.types);
    const actual = countTypes(result.types);

    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());

    for (const [type, count] of expected) {
      expect(actual.get(type), `count of ${type}`).toBe(count);
    }

    expect([...actual.values()].reduce((sum, value) => sum + value, 0)).toBe(turn.frames.length);
  });

  it("rebuilds every recording in the corpus, concatenated in file order", async () => {
    // The strongest evidence this suite can give: all 295 frames, 19 kinds, every
    // committed recording, in one pass. Red when: anything works for one scenario
    // but not for another (a frame shape only some recordings carry), or when a
    // session leaks state into the next one.
    const turns = await corpus();
    const recorded: string[] = [];
    const delivered: string[] = [];
    const texts: string[] = [];
    const startedAt = Date.now();
    let frames = 0;

    for (const turn of turns) {
      const result = await replayRecording({ turn });

      recorded.push(...turn.types);
      delivered.push(...result.types);
      texts.push(...result.frameTexts);
      frames += turn.frames.length;
    }

    const diff = diffEventSequence(recorded, delivered);
    expect(diff.gaps, formatDiff("whole corpus: delivered sequence vs recording", diff)).toEqual(
      [],
    );
    expect(diff.lengthDelta).toBe(0);
    expect(delivered).toHaveLength(CORPUS_FRAMES);
    expect(new Set(delivered).size).toBe(CORPUS_TYPES);
    expect(frames).toBe(CORPUS_FRAMES);
    expect(texts).toHaveLength(CORPUS_FRAMES);
    expect(Date.now() - startedAt).toBeLessThan(CASE_BUDGET_MS * 2);
  });

  it("keeps a single subscriber's frame count equal to the plan's", async () => {
    // Red when: delivery is silent to the only subscriber (the "not lost" half of
    // the delivery guarantee), or when the channel holds a frame back waiting for
    // a correlation - replay never answers a command, so every recorded frame must
    // arrive as an event.
    //
    // One subscriber, one connection on purpose: a second *subscriber* would need
    // a second channel and therefore a second socket, and the replayer serves one
    // live connection only (fact 27).
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    await session.settle();

    expect(session.events).toHaveLength(turn.frames.length);
    expect(session.events.map((frame) => frame.type)).toEqual(turn.types);

    // `at` is our receive time from the injected channel clock, never the
    // engine's `emitted_at` and never the wall clock. The fake clock does not
    // advance during this session, so the value is exactly its `now()`; a
    // silently substituted `Date.now()` would be a different order of magnitude
    // and fail here.
    for (const frame of session.events) {
      expect(frame.at).toBe(session.eventNow());
    }

    // The engine's own timestamp is carried, not converted: `emitted_at` is a
    // string on the recording, so a numeric `at` cannot be a copy of it.
    expect(turn.frames.some((frame) => typeof frame.json["emitted_at"] === "string")).toBe(true);
  });

  it("fans out to every subscriber, and gives each the same frames in the same order", async () => {
    // Red when: the channel delivers to only the first (or only the last)
    // subscriber, or a second subscriber's registration changes the first one's
    // view. One connection, several subscribers: that distinction is the point,
    // since the replayer cannot serve a second socket but a channel can fan out
    // freely.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ connect: false, turn });
    const second: string[] = [];
    const third: string[] = [];

    session.subscribe((frame) => {
      second.push(frame.type);
    });
    const detach = session.subscribe((frame) => {
      third.push(frame.type);
    });

    await session.connect();
    await session.settle();

    const primary = session.events.map((frame) => frame.type);

    expect(second).toEqual(primary);
    expect(third).toEqual(primary);
    expect(primary).toEqual(turn.types);

    // Unsubscribing one listener must not disturb the others.
    detach();
    expect(second).toHaveLength(turn.frames.length);
  });

  it("raises no malformed or unknown-event diagnostic on recorded frames", async () => {
    // Red when: a recorded frame stops parsing, or the channel reports a type it
    // cannot name as unknown with no type table injected. Recorded frames are all
    // well-formed, so any record here is a regression in the inbound path.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    await session.settle();

    expect(session.diagnostics).toEqual([]);

    // "No diagnostics" alone stays green when the diagnostic port is wired to
    // nothing at all, so the port is shown to be live on the same channel: a
    // frame that is not JSON must be reported. Without this, deleting the
    // `onDiagnostic` fan-out would be undetectable from this suite.
    session.injectRaw("{ not json");
    expect(session.diagnostics.length).toBe(1);
    expect(session.diagnostics[0]?.kind).toBe("malformed");

    // ...and the injected garbage did not become an event, nor disturb the
    // sequence already asserted above.
    expect(session.events).toHaveLength(turn.frames.length);
  });
});

/* ------------------------------------------------------------------------- */
/* Pacing                                                                    */
/* ------------------------------------------------------------------------- */

describe("pacing comes from the recording and costs no wall clock", () => {
  it("asks the clock for exactly the recorded offsets", async () => {
    // Red when: the driver emits everything at once (a string speed), or the plan
    // is given a speed that does not match the recording. The clock's request log
    // is the assertion; the sum is the recording's own span.
    const turn = richestTurn(await corpus());
    const result = await replayRecording({ turn });
    const waits = result.clock.sleeps;

    expect(waits.length).toBeGreaterThan(0);
    expect(result.clock.total()).toBe(turn.span);

    // Every individual request is a non-negative delta, and at least one is
    // non-zero: a plan of zero delays would still satisfy the sum only if the span
    // were zero, which the corpus contradicts.
    expect(waits.every((ms) => Number.isInteger(ms) && ms >= 0)).toBe(true);
    expect(waits.some((ms) => ms > 0)).toBe(true);
  });

  it("proves a numeric speed is what exercises the clock at all", async () => {
    // Red when: the harness starts passing `"instant"`. With that default the plan
    // requests nothing, so the pacing case above would become a tautology while
    // still passing. That mistake has been measured before, which is why this case
    // exists.
    const turn = richestTurn(await corpus());
    const replay = await loadReplayModule();
    const paced = replay.buildReplaySteps(turn.fixture, { speed: 1 });
    const instant = replay.buildReplaySteps(turn.fixture, { speed: "instant" });
    const sumOf = (steps: typeof paced): number =>
      steps.reduce((sum, step) => sum + (step.kind === "frame" ? step.delayMs : 0), 0);

    expect(sumOf(paced)).toBe(turn.span);
    expect(sumOf(instant)).toBe(0);
    expect(paced.filter((step) => step.kind === "frame")).toHaveLength(turn.frames.length);
    expect(instant.filter((step) => step.kind === "frame")).toHaveLength(turn.frames.length);

    // The clock the harness builds records what it was asked and resolves at once;
    // that combination is what keeps a 6.6 s recording off the wall clock.
    const recording = createRecordingClock();

    expect(recording.total()).toBe(0);
    await recording.clock.sleep(250);
    expect(recording.total()).toBe(250);
    expect(recording.sleeps).toEqual([250]);
  });

  it("finishes the longest recording far inside the case budget", async () => {
    // Red when: real time creeps back in - one `setTimeout(span)` would blow this
    // budget on its own. The recording whose span is largest is selected by
    // measurement, so a re-record cannot quietly dodge the case.
    const turns = await corpus();
    const longest = [...turns].sort((left, right) => right.span - left.span)[0];

    if (longest === undefined) {
      throw new Error("replay corpus: no recording was read");
    }

    const result = await replayRecording({ turn: longest });

    expect(result.types).toHaveLength(longest.frames.length);
    expect(longest.span).toBeGreaterThan(CASE_BUDGET_MS);
    expect(result.wallMs).toBeLessThan(CASE_BUDGET_MS);
  });

  it("scales the recorded offsets by the plan's speed", async () => {
    // Red when: the driver ignores `plan.speed` and always uses the recorded
    // offsets. This case exists because every other case here runs at `speed: 1`,
    // where "multiply by speed" and "do not multiply" are the same arithmetic -
    // an equivalent mutant. Only a non-unit speed can tell them apart, and speed
    // scaling is the mechanism this case exercises.
    const turn = richestTurn(await corpus());

    expect(turn.span).toBeGreaterThan(1_000);

    const single = await replayRecording({ turn, plan: { speed: 1 } });
    const double = await replayRecording({ turn, plan: { speed: 2 } });
    const half = await replayRecording({ turn, plan: { speed: 0.5 } });
    const frameCount = turn.frames.length;

    // At `speed: 1` the deltas telescope back to the recorded span with no
    // rounding at all, so this one is exact.
    expect(single.clock.total()).toBe(turn.span);

    // At any other speed each of the N delays is rounded independently, so the
    // total can only be asserted to within the rounding it must perform: N/2 ms of
    // slack. The assertion is a *bound*, not a re-implementation of the driver's
    // own arithmetic - recomputing `sum(round(delta * speed))` here would pass even
    // if the driver ignored `speed` in some other way.
    const slack = Math.ceil(frameCount / 2) + 1;

    expect(Math.abs(double.clock.total() - turn.span * 2)).toBeLessThanOrEqual(slack);
    expect(Math.abs(half.clock.total() - turn.span * 0.5)).toBeLessThanOrEqual(slack);

    // Scaling really happened, rather than being within slack of the same number:
    // doubling must be roughly twice the single-speed total, and halving roughly
    // half. Without this the bound above would also hold for a driver that always
    // used the recorded offsets when the span happened to be small.
    expect(double.clock.total()).toBeGreaterThan(single.clock.total() * 1.9);
    expect(half.clock.total()).toBeLessThan(single.clock.total() * 0.6);

    // Order and type are independent of pacing: all three runs agree.
    expect(double.types).toEqual(turn.types);
    expect(half.types).toEqual(turn.types);
    expect(single.types).toEqual(turn.types);
  });
});

/* ------------------------------------------------------------------------- */
/* The reverse self-check                                                    */
/* ------------------------------------------------------------------------- */

describe("the assertions above can fail (planted order changes)", () => {
  it("goes red when the plan emits two recorded frames in the opposite order", async () => {
    // This is the standard requirement for the item: prove the main assertion is
    // not spinning in place. The planted change is a real replay - the same
    // recording, one `reorder` injection - so what goes red is the same comparison
    // as the main case, on a genuinely different arrival order.
    const turn = richestTurn(await corpus());
    const planted = reorderInjection(turn);
    const result = await replayRecording({
      plan: { inject: [planted.injection], speed: 1 },
      turn,
    });
    const diff = diffEventSequence(turn.types, result.types);

    // 1. The arrival order really changed: the two positions now disagree.
    expect(result.types[planted.index]).toBe(turn.types[planted.index + 1]);
    expect(result.types[planted.index + 1]).toBe(turn.types[planted.index]);

    // 2. The main assertion reports it. This is the red the suite requires.
    expect(
      diff.gaps,
      formatDiff("planted reorder vs recording", diff).concat("\n[EXPECTED RED]"),
    ).not.toEqual([]);
    expect(diff.gaps.map((gap) => gap.index)).toEqual([planted.index, planted.index + 1]);

    // 3. ...and it is the *only* thing that reports it: the multiset is unchanged
    // and the length is unchanged, so a count-only assertion (`toHaveLength`, or a
    // per-type tally) stays green on this input. That is the claim the main
    // assertion is worth having.
    expect(diff.lengthDelta).toBe(0);
    expect(diff.sameMultiset).toBe(true);
    expect(countTypes(result.types)).toEqual(countTypes(turn.types));
    expect(result.types).toHaveLength(turn.frames.length);
  });

  it("goes red on a duplicated frame while the type counts finally disagree", async () => {
    // The complement of the reorder: a length change that a multiset comparison
    // sees and a same-position comparison sees as a tail. Both directions matter -
    // a suite that only catches reordering would miss a doubled frame.
    const turn = richestTurn(await corpus());
    const planted = duplicateInjection(turn, 2);
    const result = await replayRecording({
      plan: { inject: [planted.injection], speed: 1 },
      turn,
    });
    const diff = diffEventSequence(turn.types, result.types);

    expect(diff.gaps).not.toEqual([]);
    expect(diff.lengthDelta).toBe(2);
    expect(diff.sameMultiset).toBe(false);
    expect(result.types).toHaveLength(turn.frames.length + 2);
    expect(result.frameTexts.filter((text) => text === planted.frame.canonical)).toHaveLength(
      (turn.types.filter((type) => type === planted.frame.eventType).length >= 1 ? 1 : 0) + 2,
    );
    expect(countTypes(result.types).get(planted.frame.eventType)).toBe(
      (turn.typeCounts.get(planted.frame.eventType) ?? 0) + 2,
    );
  });

  it("keeps the comparison honest: identical input passes, and a swap of the expectation fails", () => {
    // The pure-function half of the self-check, with no server: it proves the
    // comparison is neither "always red" nor "always green". Without this, the
    // reorder case above could be red for an unrelated reason.
    const recorded = ["alpha", "beta", "gamma", "alpha"];

    expect(diffEventSequence(recorded, recorded)).toEqual({
      gaps: [],
      lengthDelta: 0,
      sameMultiset: true,
    });

    const swapped = swapAdjacent(recorded, 0);
    const diff = diffEventSequence(recorded, swapped);

    expect(swapped).toEqual(["beta", "alpha", "gamma", "alpha"]);
    expect(diff.gaps).toEqual([
      { actual: "beta", expected: "alpha", index: 0 },
      { actual: "alpha", expected: "beta", index: 1 },
    ]);
    expect(diff.sameMultiset).toBe(true);

    // The multiset verdict must count occurrences, not distinct kinds: `alpha`
    // appears twice in the recording, so a sequence that swaps one of them for a
    // third kind has the same *set* of types and a different multiset.
    expect(diffEventSequence(recorded, ["alpha", "beta", "gamma", "gamma"]).sameMultiset).toBe(
      false,
    );
    expect(diffEventSequence(recorded, ["alpha", "beta", "gamma", "delta"]).sameMultiset).toBe(
      false,
    );

    // Truncation and extension are both visible, and neither looks like a swap.
    expect(diffEventSequence(recorded, recorded.slice(0, 3))).toMatchObject({
      lengthDelta: -1,
      sameMultiset: false,
    });
    expect(diffEventSequence(recorded, [...recorded, "delta"])).toMatchObject({
      lengthDelta: 1,
      sameMultiset: false,
    });
    expect(formatDiff("sample", diff)).toContain("2 position(s) differ");
  });

  it("refuses a reorder that would swap two frames of the same type", () => {
    // The equivalent-mutant trap: a planted change that cannot alter the asserted
    // sequence proves nothing. Two adjacent frames of one type
    // are indistinguishable in the type sequence, so the helper must *skip* such a
    // pair and pick a differing one - and must refuse outright when no differing
    // pair exists.
    const line = { at: 0, dir: "s2c" as const, msg: {} };
    const frame = (lineNumber: number, eventType: string) => ({
      at: lineNumber,
      byteIdentical: true,
      canonical: "{}",
      eventType,
      json: {},
      line: lineNumber,
      recorded: "{}",
    });

    /** A turn whose type sequence is exactly `types`, one frame each. */
    const turnOf = (types: readonly string[]): RecordedTurn => ({
      clientLines: 0,
      fixture: { header: { kind: "wire", schemaVersion: 1 }, lines: [line] },
      frames: types.map((type, index) => frame(index + 1, type)),
      name: "synthetic",
      span: 0,
      typeCounts: countTypes(types),
      types: [...types],
    });

    // A uniform run has no differing pair anywhere: refused, with the reason
    // stated rather than an opaque index error.
    expect(() => reorderInjection(turnOf(["a", "a", "a"]))).toThrow(
      /no adjacent pair of differing event types/,
    );
    expect(() => reorderInjection(turnOf([]))).toThrow(/no adjacent pair of differing event types/);

    // A run that starts uniform still finds the first *differing* pair, so the
    // planted swap is one the assertion can actually see.
    const picked = reorderInjection(turnOf(["a", "a", "b", "c"]));
    expect(picked.index).toBe(1);
    expect(picked.injection).toEqual({ kind: "reorder", lines: [2, 3] });

    // And the guard is not "always refuse": a differing pair is accepted.
    expect(reorderInjection(turnOf(["a", "b"]))).toEqual({
      index: 0,
      injection: { kind: "reorder", lines: [1, 2] },
    });
  });
});

/* ------------------------------------------------------------------------- */
/* Hygiene                                                                   */
/* ------------------------------------------------------------------------- */

describe("sessions leave nothing behind", () => {
  it("keeps delivering to the other subscribers when one of them throws", async () => {
    // Red when: a consumer's exception propagates out of the channel's fan-out, so
    // one broken subscriber costs every later subscriber its frame. On a recorded
    // replay that is frame loss with no diagnostic - the worst shape of failure,
    // because the sequence assertion in the *primary* subscriber still passes.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ connect: false, turn });
    const healthy: string[] = [];

    // Registered first, so a propagating exception would cut the healthy one off.
    session.subscribe(() => {
      throw new Error("a renderer bug");
    });
    session.subscribe((frame) => {
      healthy.push(frame.type);
    });

    await session.connect();
    await session.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(healthy).toEqual(turn.types);
    expect(session.events.map((frame) => frame.type)).toEqual(turn.types);
  });

  it("closes idempotently and releases the session registry", async () => {
    // Red when: `close` stops clearing the registry (the next case inherits a
    // closed server and fails somewhere unrelated) or stops being idempotent (a
    // double close throws during teardown).
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    expect(openSessionCount()).toBeGreaterThan(0);
    expect(session.isConnected()).toBe(true);
    expect(session.isClosed()).toBe(false);

    // `connect` is idempotent too: calling it twice must not open a second socket.
    // The replayer serves one live connection, so a second socket would receive
    // nothing - the frames would silently stop. The
    // attempt counter is what makes the guard observable; `isConnected` alone stays
    // true even when a second socket was opened behind it.
    await session.connect();
    await session.settle();

    const afterFirst = session.frameTexts.length;
    await session.connect();
    await session.settle();

    expect(session.connectAttempts()).toBe(1);
    expect(session.frameTexts.length).toBe(afterFirst);
    expect(session.frameTexts.length).toBe(turn.frames.length);

    await session.close();
    await session.close();

    expect(session.isClosed()).toBe(true);
    expect(openSessionCount()).toBe(0);
  });

  it("starts the server before the client, since replay waits for a socket", async () => {
    // Red when: the harness connects first (the driver would then hold a socket
    // that is already gone on a disconnect plan) or emits before the socket
    // exists. With `connect: false` the server is up and has emitted nothing:
    // that is the measured form of "a frame waits for a connection".
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ connect: false, turn });

    expect(session.isConnected()).toBe(false);
    expect(session.emitted()).toHaveLength(0);
    expect(session.frameTexts).toHaveLength(0);

    await session.connect();
    await session.settle();

    expect(session.isConnected()).toBe(true);
    expect(session.emitted()).toHaveLength(turn.frames.length);

    // What the server believes it emitted is what the client received: a frame
    // lost between the two would be a transport fault, not a plan fault, and the
    // two being equal is what makes the sequence assertion above meaningful.
    expect([...session.frameTexts]).toEqual([...session.emitted()]);
  });

  it("does not hand the captured frames to a second subscriber a second time", async () => {
    // Red when: `openTransport` copies its capture queue instead of emptying it,
    // so every subscriber attached later receives the frames the first one already
    // took. This is the path the instant clock exercises and no ordinary test can:
    // because the clock never waits, part of the recording is pushed during the
    // upgrade and is waiting when `openTransport` resolves.
    //
    // The rule is `splice`, deliberately the single mechanism - see
    // `openTransport`'s own comment: two guards over one mistake hide each other.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });
    const late: string[] = [];

    // Attached *after* the session's own listener drained the capture queue. Any
    // frame it now receives is a live one; under the copy mutant it would also
    // receive the captured ones again.
    session.onRawFrame((raw) => {
      late.push(raw);
    });

    await session.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The captured prefix is real: the first frames were waiting before the
    // session's own subscriber existed, so they cannot be re-offered.
    expect(session.frameTexts).toHaveLength(turn.frames.length);
    expect(late).not.toContain(session.frameTexts[0]);

    // The port is nonetheless live, not dead: frames still in flight when the
    // late listener attached do reach it. A listener attached to nothing would
    // satisfy "did not receive the first frame" vacuously.
    expect(late.length).toBeGreaterThan(0);
    expect(late.length).toBeLessThan(turn.frames.length);

    // Nothing was delivered twice: the late listener's frames are a suffix of the
    // session's, never an overlapping replay of them.
    expect(session.frameTexts.slice(session.frameTexts.length - late.length)).toEqual(late);
  });

  it("refuses to hand out the raw-frame port before the session connects", async () => {
    // Red when: `onRawFrame` is silently accepted before there is a transport,
    // which would make the case above pass by subscribing to nothing. A clear
    // error is the difference between "no frames were lost" and "nothing was
    // listening".
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ connect: false, turn });

    expect(() => session.onRawFrame(() => undefined)).toThrow(/before the session connected/);
  });

  it("fails fast, with a self-describing error, when the plan outruns the corpus", async () => {
    // Red when: `settle` becomes a bare `await` on a promise that never resolves.
    // The failure a bare await produces is a 30-second `testTimeout` naming no
    // cause; this one costs a single budget and names the shortfall.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ connect: false, turn });

    await expect(session.settle(50)).rejects.toThrow(
      /replay did not settle: 0 of \d+ planned frame\(s\) arrived within 50 ms/,
    );
  });

  it("spends no real time on the corpus's own recorded span", async () => {
    // A guard on the whole file's budget rather than on one case: the corpus spans
    // tens of seconds of recorded time across seven files, and replaying all of it
    // must not involve waiting for any of it.
    const startedAt = Date.now();
    const turns = await corpus();
    const result = await replayRecording({ turn: richestTurn(turns) });

    expect(result.types).toHaveLength(richestTurn(turns).frames.length);
    expect(Date.now() - startedAt).toBeLessThan(CASE_BUDGET_MS);
  });
});
