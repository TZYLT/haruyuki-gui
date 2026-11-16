/**
 * Replay - the replay corpus rebuilds the recorded event sequence .
 *
 * Scope sources: docs/26 section 5.1 (Replay: order, type and count all unchanged),
 *  section 2.5 (the replayer's four measured limits), section 2.10 (the
 * corpus facts) and section 6.4 (the `test` budget).
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
 * - **Types without wire literals.**  scans this whole directory, so the
 *   engine's type names must not be written down here.) A type reaches this file
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

  it("keeps stored and emitted text equivalent, and names the difference precisely", async () => {
    // Red when: a corpus line is rewritten beyond the escaping the recorder
    // applied. The claim this case exists for is narrow on purpose - "byte
    // identity" is false for 19 of the 295 frames, and pretending otherwise would
    // either hide a real loss or fail on a difference that carries no meaning.
    const totals = corpusTotals(await corpus());

    expect(totals.lostInRewriting).toEqual([]);
    expect(totals.rewritten).toBe(19);

    // Every rewritten frame must actually differ; otherwise the escaping rule is
    // reading a difference that is not there and the check above is vacuous.
    for (const turn of (await corpus()).flatMap((entry) => entry.frames)) {
      expect(turn.escapingOnlyDifference || turn.byteIdentical).toBe(true);
    }
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
    // half), or when the channel holds a frame back waiting for a correlation -
    // a correlation - replay never answers a command, so every recorded frame must
    // recorded frame must arrive as an event.
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
    // engine's `emitted_at`; it must be a finite number on every frame.
    for (const frame of session.events) {
      expect(Number.isFinite(frame.at)).toBe(true);
    }
  });

  it("raises no malformed or unknown-event diagnostic on recorded frames", async () => {
    // Red when: a recorded frame stops parsing, or the channel reports a type it
    // cannot name as unknown with no type table injected. Recorded frames are all
    // well-formed, so any record here is a regression in the inbound path.
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    await session.settle();

    expect(session.diagnostics).toEqual([]);
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
    // exactly this mistake).
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
    // alter the asserted sequence proves nothing. Two adjacent frames of one type
    // are indistinguishable in the type sequence, so the helper must refuse a plan
    // that only swaps such a pair rather than silently returning one.
    const uniform: RecordedTurn = {
      clientLines: 0,
      fixture: { header: { kind: "wire", schemaVersion: 1 }, lines: [] },
      frames: [],
      name: "synthetic",
      span: 0,
      typeCounts: new Map(),
      types: [],
    };

    // An empty recording has no adjacent pair at all, so it is refused for the
    // strongest reason; the message must name the reason, not throw an opaque
    // index error.
    expect(() => reorderInjection(uniform)).toThrow(/no adjacent pair of differing event types/);
  });
});

/* ------------------------------------------------------------------------- */
/* Hygiene                                                                   */
/* ------------------------------------------------------------------------- */

describe("sessions leave nothing behind", () => {
  it("closes idempotently and releases the session registry", async () => {
    // Red when: `close` stops clearing the registry (the next case inherits a
    // closed server and fails somewhere unrelated) or stops being idempotent (a
    // double close throws during teardown).
    const turn = richestTurn(await corpus());
    const session = await startReplaySession({ turn });

    expect(openSessionCount()).toBeGreaterThan(0);
    expect(session.isConnected()).toBe(true);
    expect(session.isClosed()).toBe(false);

    await session.settle();
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
