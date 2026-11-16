/**
 * Envelope passthrough tests.
 *
 * Split out of `channel.test.ts` on responsibility: this suite is about what the
 * channel does with the four envelope fields, not about the channel's state
 * machines. It asserts against the **committed recordings** rather than a
 * hand-written sample, because the reason the passthrough exists is that the real
 * engine omits fields: 30 of the 295 recorded s2c frames are incomplete (19 carry
 * none of the four, 11 carry only some). A hand-written frame could not disagree
 * with the implementation; these can.
 *
 * What each case is designed to catch is named in its own comment. The central
 * one: assuming the four fields are always present turns roughly one frame in ten
 * into a crash, and the frames it breaks on are exactly the ones a newer engine
 * introduced.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { assertNoLeakedTimers, closeHarnesses, makeHarness } from "./channel-test-support";

/**
 * Close every channel this file built, before the next test runs.
 *
 * Without this, a test that leaves entries in flight hands its timers and
 * unsettled promises to whatever runs next - which passes in isolation and fails
 * in a full run as a `testTimeout` in a test that did nothing wrong.
 */
afterEach(() => {
  // Asserts before it cleans: see `assertNoLeakedTimers`. Calling
  // `closeHarnesses()` first would free the timers and make the check vacuous.
  assertNoLeakedTimers();
});

/* ------------------------------------------------------------------------- */
/* Envelope passthrough, against the committed recordings                    */
/* ------------------------------------------------------------------------- */

/** One recorded wire line. */
type RecordingLine = { readonly dir?: string; readonly msg?: Record<string, unknown> };

/**
 * Every s2c frame in the committed recordings, in file order.
 *
 * Loaded from disk rather than transcribed: the point of the envelope test is that
 * the *real* incomplete frames pass through, and a hand-written sample could not
 * disagree with the implementation.
 *
 * @returns the recorded inbound frames
 */
function recordedInboundFrames(): Record<string, unknown>[] {
  const directory = fileURLToPath(
    new URL("../../../../../fixtures/engine/recordings/", import.meta.url),
  );
  const frames: Record<string, unknown>[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const text = readFileSync(`${directory}${name}`, "utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const parsed = JSON.parse(line) as RecordingLine;
      if (parsed.dir !== "s2c" || parsed.msg === undefined) {
        continue;
      }
      frames.push(parsed.msg);
    }
  }
  return frames;
}

/** The frozen envelope fields, read off a recorded frame. */
const RECORDED_ENVELOPE_KEYS = ["runtime", "event_seq", "emitted_at", "idempotency_key"] as const;

describe("envelope passthrough", () => {
  it("passes all four fields through verbatim on the frames that have them", () => {
    // Red when: a field is renamed, dropped, or replaced by a sibling key.
    const frames = recordedInboundFrames();
    const h = makeHarness();

    for (const frame of frames) {
      h.channel.ingest(JSON.stringify(frame));
    }

    const complete = frames.filter((frame) =>
      RECORDED_ENVELOPE_KEYS.every((key) => frame[key] !== undefined),
    );
    expect(complete.length).toBeGreaterThan(0);

    for (const delivered of h.events) {
      const source = delivered.raw as Record<string, unknown>;
      for (const key of RECORDED_ENVELOPE_KEYS) {
        if (source[key] === undefined) {
          expect(Object.prototype.hasOwnProperty.call(delivered.envelope ?? {}, key)).toBe(false);
        } else {
          expect((delivered.envelope as Record<string, unknown>)[key]).toEqual(source[key]);
        }
      }
    }
  });

  it("does not crash on the 30 incomplete recorded frames, and omits what is absent", () => {
    // Red when: the four fields are assumed present (`envelope.runtime.agent_id`
    // on a frame that has no runtime). The corpus has 30 such frames: 19 with none
    // of the four and 11 with only some.
    const frames = recordedInboundFrames();
    const incomplete = frames.filter((frame) =>
      RECORDED_ENVELOPE_KEYS.some((key) => frame[key] === undefined),
    );
    expect(incomplete).toHaveLength(30);

    const h = makeHarness();
    expect(() => {
      for (const frame of incomplete) {
        h.channel.ingest(JSON.stringify(frame));
      }
    }).not.toThrow();

    expect(h.events).toHaveLength(incomplete.length);

    // The 19 frames with no envelope fields at all must carry no `envelope` key,
    // not an empty object: "absent" and "present but empty" are different facts.
    const empty = incomplete.filter((frame) =>
      RECORDED_ENVELOPE_KEYS.every((key) => frame[key] === undefined),
    );
    expect(empty.length).toBeGreaterThan(0);
    for (const delivered of h.events) {
      const source = delivered.raw as Record<string, unknown>;
      const hasAny = RECORDED_ENVELOPE_KEYS.some((key) => source[key] !== undefined);
      expect(Object.prototype.hasOwnProperty.call(delivered, "envelope")).toBe(hasAny);
    }
  });

  it("keeps the whole recorded corpus dispatchable", () => {
    // Red when: any frame in the real corpus throws or is silently dropped. 295
    // frames is every s2c line this repository has, so this is the widest
    // "unknown type does not crash" case available.
    const frames = recordedInboundFrames();
    const h = makeHarness({
      knownEventTypes: new Set(
        frames
          .map((frame) => frame["type"])
          .filter((type): type is string => typeof type === "string"),
      ),
    });

    for (const frame of frames) {
      h.channel.ingest(JSON.stringify(frame));
    }

    expect(h.events).toHaveLength(frames.length);
    // Every recorded type is in the injected table, so nothing is unknown.
    expect(h.channel.unknownEventCounts().size).toBe(0);
    expect(h.records).toHaveLength(0);
  });
});
