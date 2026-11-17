/**
 * The merge chain against every recorded session.
 *
 * Each recording under `fixtures/engine/recordings/` is replayed through the
 * same modules production uses -- the envelope reader, the ordering gate, the
 * delta classifier and the message assembler -- and the four variants below ask
 * whether the chain is stable under the things a network does to a stream:
 *
 * - **baseline**: the recording in its recorded order, which establishes the
 *   text each message ends up with;
 * - **shuffle**: the same frames in a deterministic random order. The gate
 *   buffers what is ahead of order and releases it later, so the final text must
 *   be identical key by key. Running it twice must also be identical, because a
 *   result that depends on `Math.random()` is a result nobody can reproduce;
 * - **duplicate**: every frame three times. A repeated sequence number is
 *   refused by the gate, so the text must not grow; the gate must also say it
 *   saw at least one repeat, otherwise the variant is silently asserting
 *   nothing;
 * - **gap**: one assistant delta is removed from the recording. The gate must
 *   give up on the hole and say so, and the message that lost the delta must
 *   lose exactly that delta's text and nothing else.
 *
 * Why the gap variant lowers the buffer bound: a hole is only declared once the
 * buffer overflows (the gate owns no timer), and a recording is far shorter than
 * the production bound, so at that bound the tail would simply be held forever
 * and nothing would be reported. The smaller bound is what makes the same
 * mechanism observable within one recording.
 *
 * The frames are built the way the channel builds them: `raw` is the parsed
 * message and `envelope` is `envelopeOf(msg)`, so the fields the reader sees and
 * the payload the classifier sees come from the same place as in production.
 *
 * Two recordings carry no assistant text (one is memory and terminal output
 * only, and two have a single-delta answer), so their baseline table is empty
 * and the gap variant has nothing to remove; that is skipped with a name that
 * says why rather than passing on an empty comparison.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { envelopeOf, type EngineEventFrame } from "../engine/client/index.js";
import { loadFixture, type WireFixture } from "../testing/index.js";
import { createAssembler } from "./assemble.js";
import { readEnvelope, type EnvelopeFacts } from "./envelope.js";
import { createOrderGate } from "./order.js";
import { classifyDelta } from "./project.js";
import type { AssistantPart } from "./types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Directory the recorded sessions live in. */
const CORPUS_DIR = path.join(REPO_ROOT, "fixtures", "engine", "recordings");

/** The shuffle seed; fixed so a failure can be reproduced exactly. */
const SHUFFLE_SEED = 42;

/** Names of the recordings, sorted so test order does not depend on the file system. */
function discoverRecordings(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

/**
 * Build the frames one recording contributes.
 *
 * Mirrors the channel: the outbound direction is replayed, `raw` is the message
 * object itself and the metadata block is read off it verbatim.
 *
 * @param fixture the loaded recording
 */
function framesOf(fixture: WireFixture): readonly EngineEventFrame[] {
  const frames: EngineEventFrame[] = [];

  for (const line of fixture.lines) {
    if (line.dir !== "s2c") {
      continue;
    }

    const msg = line.msg;
    const type = msg["type"];
    const envelope = envelopeOf(msg);

    frames.push({
      type: typeof type === "string" ? type : "",
      raw: msg,
      at: line.at,
      ...(envelope === undefined ? {} : { envelope }),
    });
  }

  return frames;
}

/** The text a list of parts contributes, matching the assembler's rule. */
function textOf(parts: readonly AssistantPart[]): string {
  let text = "";

  for (const part of parts) {
    if (part.type === "text" && typeof part.text === "string") {
      text += part.text;
    }
  }

  return text;
}

/** The identity of one assembled message, as a comparable string. */
function messageKeyOf(
  authorAgentId: string | null,
  subagentId: string | null,
  messageId: string,
): string {
  return JSON.stringify([authorAgentId, subagentId, messageId]);
}

/** What one replay produced. */
type StreamResult = {
  /** Final text per message identity. */
  readonly texts: ReadonlyMap<string, string>;
  /** Frames the gate refused as already seen. */
  readonly duplicates: number;
  /** Gaps the gate declared. */
  readonly gaps: number;
  /** Frames dropped because the watermark had already passed them. */
  readonly late: number;
};

/**
 * Play a frame list through the merge chain.
 *
 * Nothing here re-implements the chain: the gate decides delivery order, the
 * classifier decides what a payload is, and the assembler decides what text a
 * message has. This function only wires them together and keeps the running
 * text per message, exactly as a consumer would.
 *
 * @param frames the frames to replay, in arrival order
 * @param capacity ordering-gate buffer bound; production's default when omitted
 */
function run(frames: readonly EngineEventFrame[], capacity?: number): StreamResult {
  const gate = createOrderGate<{ readonly frame: EngineEventFrame; readonly facts: EnvelopeFacts }>(
    capacity === undefined ? {} : { capacity },
  );
  const assembler = createAssembler();
  const texts = new Map<string, string>();

  let duplicates = 0;
  let gaps = 0;
  let late = 0;

  const take = (frame: EngineEventFrame, facts: EnvelopeFacts): void => {
    const classified = classifyDelta(frame.raw);

    if (classified === null || classified.kind !== "assistant") {
      return;
    }

    const key = messageKeyOf(facts.authorAgentId, facts.subagentId, classified.messageId);
    const delta = assembler.push({
      authorAgentId: facts.authorAgentId,
      subagentId: facts.subagentId,
      messageId: classified.messageId,
      runId: classified.runId,
      runSeq: classified.runSeq,
      parts: classified.parts,
      at: frame.at,
    });

    if (delta === null) {
      return;
    }

    const next = delta.reset ? delta.text : `${texts.get(key) ?? ""}${delta.text}`;
    texts.set(key, next);

    // The delta's parts are the message's parts so far, so their text has to be
    // exactly what the incremental text has accumulated. If the two disagree,
    // one of them is wrong and a consumer would render something else than it
    // measured.
    expect(textOf(delta.parts)).toBe(next);
  };

  for (const frame of frames) {
    const facts = readEnvelope(frame, "default");

    // A frame with no sequence number cannot be ordered; it is processed in
    // arrival order, which is what the chain does with it in production too.
    if (facts.seq === null) {
      take(frame, facts);
      continue;
    }

    const outcome = gate.accept(facts.seq, { frame, facts });

    duplicates += outcome.duplicate ? 1 : 0;
    gaps += outcome.gaps.length;
    late += outcome.late ? 1 : 0;

    for (const delivered of outcome.deliver) {
      take(delivered.value.frame, delivered.value.facts);
    }
  }

  return { texts, duplicates, gaps, late };
}

/** A text table as a plain object with stable key order, for comparison. */
function tableOf(texts: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(
    [...texts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** A deterministic Fisher-Yates permutation of `items`. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;

  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1664525 + 1013904223) % 4_294_967_296;
    const swap = state % (index + 1);
    const atIndex = result[index];
    const atSwap = result[swap];

    if (atIndex === undefined || atSwap === undefined) {
      continue;
    }

    result[index] = atSwap;
    result[swap] = atIndex;
  }

  return result;
}

/** One assistant delta found in a recording, remembered well enough to delete it. */
type AssistantDelta = {
  /** Position in the recording's frame list. */
  readonly index: number;
  readonly facts: EnvelopeFacts;
  readonly messageId: string;
  readonly runSeq: number;
  readonly parts: readonly AssistantPart[];
};

/** Every assistant delta a recording contains, in arrival order. */
function assistantsOf(frames: readonly EngineEventFrame[]): readonly AssistantDelta[] {
  const deltas: AssistantDelta[] = [];

  frames.forEach((frame, index) => {
    const classified = classifyDelta(frame.raw);

    if (classified === null || classified.kind !== "assistant") {
      return;
    }

    deltas.push({
      index,
      facts: readEnvelope(frame, "default"),
      messageId: classified.messageId,
      runSeq: classified.runSeq,
      parts: classified.parts,
    });
  });

  return deltas;
}

/** The message identity one delta belongs to. */
function keyOfDelta(delta: AssistantDelta): string {
  return messageKeyOf(delta.facts.authorAgentId, delta.facts.subagentId, delta.messageId);
}

/**
 * Pick a delta whose removal still lets the gate see the hole.
 *
 * Two conditions: its message must have another delta, so the loss is a piece of
 * a message rather than a message that disappeared; and at least two sequenced
 * frames must follow it, so the gate can overflow on the held frame and release
 * the rest. Without the second condition the tail would stay buffered at the end
 * of the recording and the text would be shorter for a reason that has nothing
 * to do with the deleted delta.
 *
 * @param frames the recording's frames
 * @returns the delta to remove, or `null` when this recording has no candidate
 */
function pickGapCandidate(frames: readonly EngineEventFrame[]): AssistantDelta | null {
  const deltas = assistantsOf(frames);
  const counts = new Map<string, number>();

  for (const delta of deltas) {
    const key = keyOfDelta(delta);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  for (const delta of deltas) {
    if ((counts.get(keyOfDelta(delta)) ?? 0) < 2) {
      continue;
    }

    const following = frames
      .slice(delta.index + 1)
      .filter((frame) => readEnvelope(frame, "default").seq !== null).length;

    if (following >= 2) {
      return delta;
    }
  }

  return null;
}

/** The recording loaded once, with the gap candidate its variants need. */
type Recording = {
  readonly name: string;
  readonly frames: readonly EngineEventFrame[];
  readonly gapCandidate: AssistantDelta | null;
};

// Loaded at collection time so a variant can be skipped by name when the
// recording offers nothing to remove. Awaiting the loader here is what makes
// that decision available before the tests are registered.
const RECORDINGS: readonly Recording[] = await Promise.all(
  discoverRecordings().map(async (name) => {
    const fixture = await loadFixture(path.join(CORPUS_DIR, name));
    const frames = framesOf(fixture);

    return { name, frames, gapCandidate: pickGapCandidate(frames) };
  }),
);

describe("recorded sessions through the merge chain", () => {
  it("finds the recordings it claims to grade", () => {
    expect(RECORDINGS.length).toBeGreaterThan(0);
  });

  for (const { name, frames, gapCandidate } of RECORDINGS) {
    describe(name, () => {
      it("baseline: delivers the recording as recorded, in order", () => {
        const baseline = run(frames);
        const messages = new Set(assistantsOf(frames).map(keyOfDelta));

        expect(baseline.duplicates).toBe(0);
        expect(baseline.gaps).toBe(0);
        expect(baseline.late).toBe(0);
        // Every assistant message the recording mentions is in the table.
        expect(new Set(baseline.texts.keys())).toEqual(messages);

        for (const text of baseline.texts.values()) {
          expect(text.length).toBeGreaterThan(0);
        }
      });

      it("shuffle: the same text table in a different arrival order", () => {
        const baseline = run(frames);
        const reordered = shuffled(frames, SHUFFLE_SEED);

        // The variance only means something when the order actually changed.
        expect(reordered.some((frame, index) => frame !== frames[index])).toBe(true);

        const first = run(reordered);
        const second = run(reordered);

        expect(tableOf(first.texts)).toEqual(tableOf(baseline.texts));
        expect(tableOf(second.texts)).toEqual(tableOf(first.texts));
      });

      it("duplicate: repeating every frame three times does not grow the text", () => {
        const baseline = run(frames);
        const repeated = frames.flatMap((frame) => [frame, frame, frame]);
        const result = run(repeated);

        expect(tableOf(result.texts)).toEqual(tableOf(baseline.texts));

        const sequenced = frames.filter((frame) => readEnvelope(frame, "default").seq !== null);

        if (sequenced.length === 0) {
          // The recording carries no sequence number at all, so there is no
          // repeat for the gate to recognise; the text check above is the whole
          // assertion.
          expect(result.duplicates).toBe(0);
        } else {
          expect(result.duplicates).toBeGreaterThanOrEqual(1);
        }
      });

      if (gapCandidate === null) {
        it.skip("gap: skipped because no message here has more than one delta", () => {});
      } else {
        it("gap: declares the hole and loses exactly the deleted delta's text", () => {
          const baseline = run(frames);
          const reduced = frames.filter((_frame, index) => index !== gapCandidate.index);

          // A hole is only declared when the buffer overflows, and a recording is
          // much shorter than the default bound; lowering it makes the same
          // mechanism reachable inside one recording.
          const result = run(reduced, 1);

          expect(result.gaps).toBeGreaterThanOrEqual(1);

          const affected = keyOfDelta(gapCandidate);
          const deletedText = textOf(gapCandidate.parts);

          // Independently of the chain, the affected message's text must be the
          // same deltas in sequence order minus the deleted one.
          const expectedText = assistantsOf(frames)
            .filter((delta) => keyOfDelta(delta) === affected && delta.index !== gapCandidate.index)
            .sort((left, right) => left.runSeq - right.runSeq)
            .map((delta) => textOf(delta.parts))
            .join("");

          const expectedTable = tableOf(baseline.texts);
          expectedTable[affected] = expectedText;

          expect(tableOf(result.texts)).toEqual(expectedTable);
          expect(result.texts.get(affected)?.length).toBe(
            (baseline.texts.get(affected)?.length ?? 0) - deletedText.length,
          );
        });
      }
    });
  }
});
