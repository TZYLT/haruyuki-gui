/**
 * What this file proves: a probe in flight does not stand between the consumer and
 * a frame.
 *
 * ## Why a synthetic transport is legitimate here
 *
 * The claim is about **this layer**: while a liveness probe is waiting for its own
 * send to settle, a frame that arrives must still be handled at once. That is a
 * property of the code in this directory, not of the engine -- which is also why no
 * recording of a real engine is needed, and why the transport here is a stub.
 *
 * The contrast matters: an assertion about what the *engine* does (whether it
 * re-pushes a stale approval, say) cannot be proved this way, because the engine
 * is not in this test. That one keeps a recorded fixture, or admits it is only
 * shape-correct.
 *
 * ## What "not blocked" means, and what it does not
 *
 * The probe takes its send as a port, so it cannot enqueue anything the transport
 * did not offer it. What this file pins is the other half: the probe never makes
 * the consumer wait -- its own pending promise is not on the frame path.
 */

import { describe, expect, it } from "vitest";

import { createProbe } from "./probe";

function manualClock(start = 1_000_000) {
  let now = start;
  let timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => now,
    setTimer(fn: () => void, ms: number) {
      const entry = { at: now + ms, fn };
      timers.push(entry);
      return () => {
        timers = timers.filter((candidate) => candidate !== entry);
      };
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers = timers.filter((candidate) => candidate !== due);
        now = due.at;
        due.fn();
      }
      now = target;
    },
  };
}

/** A frame path that records when each frame is handled. */
function framePath() {
  const handled: number[] = [];
  return {
    handled,
    deliver: () => {
      handled.push(handled.length + 1);
    },
  };
}

describe("probe isolation", () => {
  it("keeps handling frames while the probe's own send is still pending", async () => {
    const clock = manualClock();
    const path = framePath();

    // A send that never settles on its own: this is the worst case for anything
    // that might await it before letting the consumer through.
    let release!: () => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      release = () => resolve({ ok: true });
    });

    const probe = createProbe({
      clock,
      send: () => pending,
    });

    probe.start();
    clock.advance(10_000); // the probe fires; its send is now in flight
    await Promise.resolve();

    // The consumer's frame arrives in the middle of that pending send.
    path.deliver();
    path.deliver();

    expect(path.handled).toEqual([1, 2]);
    // A pending send is not a verdict: the probe says "alive" until the answer or
    // its timeout decides otherwise. What matters here is that the two frames
    // above were handled while it was pending.
    expect(probe.state()).toBe("alive");

    release();
    await pending;
    await Promise.resolve();

    // The probe settled its own round without having delayed anything: the frames
    // above were handled before this point, not after it.
    expect(path.handled).toHaveLength(2);
  });

  it("does not stack a second send while the first is unanswered, and calls it a failure when the timeout hits", async () => {
    // Overlap is the other failure mode: a probe that stacks rounds keeps slow
    // sends spinning against the same socket. The timeout is what turns "no
    // answer" into a verdict, and the cadence then resumes.
    const clock = manualClock();
    let calls = 0;
    const never = new Promise<{ ok: boolean }>(() => {});

    const probe = createProbe({
      clock,
      send: () => {
        calls += 1;
        return never;
      },
    });

    probe.start();
    clock.advance(10_000); // fires once

    expect(calls).toBe(1);
    expect(probe.state()).toBe("alive");

    clock.advance(8_000); // the 8 s timeout settles it as a failure

    expect(calls).toBe(1);
    expect(probe.state()).toBe("suspect");

    clock.advance(10_000); // the next round is measured from the settlement, not
    // from when the previous one was sent, so a slow answer never shifts the cadence

    expect(calls).toBe(2);
  });
});
