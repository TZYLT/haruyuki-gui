/**
 * Round-trip tests for the replay client.
 *
 * The fixture goes through the fake server's replay mode and a real
 * `connectEngine` socket, and the assertions are about what the client received:
 * fixture order, injections, reconnects and cleanup. The plan shapes are frozen
 * in `fixture.ts` (`ReplayPlan`).
 *
 * No wall-clock waiting: the default clock is the replay module's instant clock,
 * and the coalesce case injects a recording clock, so a run finishes as fast as
 * the event loop lets it. `replayThrough` owns the socket and server lifetimes,
 * so there is no `afterEach` cleanup here.
 */

import { describe, expect, it } from "vitest";

import type { Clock, ReplayPlan } from "./fixture";
import { createInstantClock, loadFixtureText } from "./fixture";
import type { ReplayFrame } from "./replay-client";
import { replayThrough } from "./replay-client";

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const HEADER = {
  kind: "wire",
  schemaVersion: 1,
  engine: { version: "0.6.0", commit: "1641a4f" },
  scenario: "replay-client",
  redaction: "r1",
  clock: "virtual",
  recordedAt: "2024-01-01T00:00:00.000Z",
};

type Line = { dir: "c2s" | "s2c"; at: number; msg: Record<string, unknown> };

const HANDSHAKE = { type: "app_server_info_response", success: true };
const INPUT = { type: "input", request_id: "r-1" };
const DELTA_1 = { type: "stream_delta", i: 1 };
const DELTA_2 = { type: "stream_delta", i: 2 };
const FINISHED = { type: "turn_finished" };

/** Four s2c frames around one c2s frame: line 1 s2c, 2 c2s, 3/4/5 s2c. */
const STANDARD_LINES: Line[] = [
  { dir: "s2c", at: 0, msg: HANDSHAKE },
  { dir: "c2s", at: 5, msg: INPUT },
  { dir: "s2c", at: 10, msg: DELTA_1 },
  { dir: "s2c", at: 20, msg: DELTA_2 },
  { dir: "s2c", at: 30, msg: FINISHED },
];

const EXPECTED_MESSAGES = [HANDSHAKE, DELTA_1, DELTA_2, FINISHED];
const EXPECTED_TEXTS = EXPECTED_MESSAGES.map((message) => JSON.stringify(message));

/** Build wire JSONL text: the header, then one message line per entry. */
function wireText(lines: Line[]): string {
  return [HEADER, ...lines].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

/** Load the standard fixture from text; the loader is covered by fixture.test.ts. */
async function standardFixture() {
  return loadFixtureText(wireText(STANDARD_LINES));
}

/**
 * A clock that really sleeps, so the frames of a fixture land apart in wall time.
 * Only the truncation cases need it: with the instant clock every frame is
 * already in the socket buffer when a case tries to drop the client, so nothing
 * is ever truncated.
 */
const SPACED_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Collect the parsed messages of a result, which is what the assertions compare. */
function messagesOf(frames: ReplayFrame[]): unknown[] {
  return frames.map((frame) => frame.json);
}

/* ------------------------------------------------------------------ */
/* the round trip                                                      */
/* ------------------------------------------------------------------ */

describe("replayThrough", () => {
  it("delivers every s2c line in fixture order, as raw text and as JSON", async () => {
    const fixture = await standardFixture();
    const clock = await createInstantClock();
    const result = await replayThrough({ fixture, clock });

    expect(messagesOf(result.frames)).toEqual(EXPECTED_MESSAGES);
    expect(result.received).toEqual(EXPECTED_TEXTS);
    // The server's own log proves the two views agree byte for byte.
    expect(result.server.emitted).toEqual(EXPECTED_TEXTS);
    // The replay client never speaks; c2s lines are recorded, not replayed.
    expect(result.server.received).toEqual([]);
  });

  it("shows a plan duplicate as the repeated frame in the received order", async () => {
    const fixture = await standardFixture();
    const plan: ReplayPlan = { inject: [{ kind: "duplicate", line: 3, times: 2 }] };
    const result = await replayThrough({ fixture, plan });

    expect(messagesOf(result.frames)).toEqual([
      HANDSHAKE,
      DELTA_1,
      DELTA_1,
      DELTA_1,
      DELTA_2,
      FINISHED,
    ]);
  });

  it("reconnects after a planned disconnect with resume true and delivers the tail", async () => {
    const fixture = await standardFixture();
    const plan: ReplayPlan = { inject: [{ kind: "disconnect", atLine: 3, resume: true }] };
    const result = await replayThrough({ fixture, plan });

    expect(messagesOf(result.frames)).toEqual(EXPECTED_MESSAGES);
    expect(result.server.emitted).toEqual(EXPECTED_TEXTS);
  });

  it("makes a reorder plan observable in the received order", async () => {
    const fixture = await standardFixture();
    const plan: ReplayPlan = { inject: [{ kind: "reorder", lines: [3, 5] }] };
    const result = await replayThrough({ fixture, plan });

    // Lines 3 and 5 are the second and the last s2c frame.
    expect(messagesOf(result.frames)).toEqual([HANDSHAKE, FINISHED, DELTA_2, DELTA_1]);
  });

  it("makes a coalesce plan observable through the injected clock, never by reordering", async () => {
    const fixture = await standardFixture();
    const spacedWaits: number[] = [];
    const coalescedWaits: number[] = [];
    const spacedClock: Clock = {
      now: () => 0,
      sleep: async (ms) => {
        spacedWaits.push(ms);
      },
    };
    const coalescedClock: Clock = {
      now: () => 0,
      sleep: async (ms) => {
        coalescedWaits.push(ms);
      },
    };

    const spaced = await replayThrough({ fixture, plan: { speed: 10 }, clock: spacedClock });
    const coalesced = await replayThrough({
      fixture,
      plan: { speed: 10, inject: [{ kind: "coalesce", lines: [3, 4] }] },
      clock: coalescedClock,
    });

    // Ten milliseconds per virtual millisecond; coalesce drops the second wait.
    expect(spacedWaits).toEqual([100, 100, 100]);
    expect(coalescedWaits).toEqual([100, 100]);
    expect(messagesOf(spaced.frames)).toEqual(EXPECTED_MESSAGES);
    expect(messagesOf(coalesced.frames)).toEqual(EXPECTED_MESSAGES);
  });

  it("refuses a run that ends before the plan's emissions", async () => {
    const fixture = await standardFixture();

    // Four s2c frames are planned; the client dies after the first. This used to
    // resolve with one frame, so a replay that died mid-plan looked complete.
    let seen = 0;

    await expect(
      replayThrough({
        fixture,
        // 10 ms between frames at speed 1, so frame 3 is not yet emitted when the
        // client dies after frame 2: this is a real truncation, not a race.
        plan: { speed: 1 },
        clock: SPACED_CLOCK,
        onFrame: (_frame, socket) => {
          seen += 1;

          if (seen === 2) {
            socket.terminate();
          }
        },
      }),
    ).rejects.toThrow(/socket closed after 2 of 4 s2c frames/);
  });

  it("stops when the client breaks and still tears the server down", async () => {
    const fixture = await standardFixture();
    let broke = false;
    const first = await replayThrough({
      fixture,
      // A deliberate early break is the caller's choice, so it has to say so.
      allowTruncation: true,
      plan: { speed: 1 },
      clock: SPACED_CLOCK,
      onFrame: (frame, socket) => {
        // Break the client mid-run; the replay can no longer reach this socket.
        if (!broke) {
          broke = true;
          setTimeout(() => socket.terminate(), 0);
        }
      },
    });

    expect(broke).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.expectedFrames).toBe(4);
    // Whatever arrived is the leading prefix of the fixture's s2c lines.
    expect(first.frames.every((frame, index) => frame.text === EXPECTED_TEXTS[index])).toBe(true);
    expect(first.received.length).toBe(first.frames.length);

    // The returned handle is already closed; closing it again is idempotent.
    await first.server.close();

    // No listener or server state leaked: a second run on the same fixture works.
    const second = await replayThrough({ fixture });

    expect(messagesOf(second.frames)).toEqual(EXPECTED_MESSAGES);
  });

  it("finishes immediately for a fixture with no s2c line", async () => {
    const fixture = await loadFixtureText(wireText([{ dir: "c2s", at: 0, msg: INPUT }]));
    const result = await replayThrough({ fixture });

    expect(result.frames).toEqual([]);
    expect(result.received).toEqual([]);
    expect(result.expectedFrames).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.server.emitted).toEqual([]);
  });
});
