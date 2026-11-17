/**
 * Tests for the connection liveness probe.
 *
 * The probe is driven entirely through its injected clock, so every case walks
 * time by hand: no test sleeps, and the worst-case detection window is checked
 * at the exact millisecond it is supposed to close. Round trips are plain
 * promises the test resolves, which is what lets a case pin "a late answer from
 * an abandoned attempt is ignored" without guessing at real timer behaviour.
 */

import { describe, expect, it } from "vitest";

import { createProbe } from "./probe";
import type { Probe, ProbeClock, ProbeOptions, ProbeSend, ProbeState } from "./probe";

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/**
 * A clock whose timers only fire when `advance` walks past them.
 *
 * Timers are kept in a set instead of a sorted list because callbacks arm new
 * timers while the clock is mid-advance; the loop below re-scans what is due
 * after each callback, which also gives zero-delay timers a chance to run.
 */
class FakeClock implements ProbeClock {
  private time = 0;
  private nextId = 1;
  private readonly timers = new Set<FakeTimer>();

  now(): number {
    return this.time;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const timer: FakeTimer = { id: this.nextId, at: this.time + ms, fn };
    this.nextId += 1;
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }

  /** Fires every due timer in order, including ones armed during the walk. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: FakeTimer | null = null;
      for (const timer of this.timers) {
        if (timer.at > target) continue;
        if (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) {
          next = timer;
        }
      }
      if (next === null) break;
      this.timers.delete(next);
      this.time = next.at;
      next.fn();
    }
    this.time = target;
  }

  pending(): number {
    return this.timers.size;
  }
}

/** Flushes the microtasks a round-trip settlement is queued on. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** Builds a probe over a fresh fake clock, with the real option defaults applied. */
function probeWith(
  send: ProbeSend,
  overrides: Partial<
    Pick<ProbeOptions, "intervalMs" | "timeoutMs" | "strikes" | "onStateChange">
  > = {},
): { probe: Probe; clock: FakeClock } {
  const clock = new FakeClock();
  const probe = createProbe({ clock, send, ...overrides });
  return { probe, clock };
}

describe("createProbe", () => {
  it("waits one interval before the first round trip, and start() is idempotent", async () => {
    const probeState: ProbeState[] = [];
    const { probe, clock } = probeWith(() => Promise.resolve({ ok: true }), {
      onStateChange: (state) => probeState.push(state),
    });

    probe.start();
    probe.start();
    expect(clock.pending()).toBe(1);
    clock.advance(9_999);
    expect(clock.pending()).toBe(1);
    clock.advance(1);
    await flush();

    expect(probe.strikes()).toBe(0);
    expect(probe.state()).toBe("alive");
    // Starting alive and staying alive is not a state change.
    expect(probeState).toEqual([]);
  });

  it("reports suspect after one failure and keeps probing", async () => {
    const sentAt: number[] = [];
    const { probe, clock } = probeWith(() => {
      sentAt.push(clock.now());
      // The first attempt fails; the second stays open so the timer, not a
      // settlement, is what the assertions below are watching.
      if (sentAt.length === 1) return Promise.resolve({ ok: false });
      return new Promise<{ ok: boolean }>(() => {});
    });

    probe.start();
    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);
    expect(clock.pending()).toBe(1);

    clock.advance(10_000);
    expect(sentAt).toEqual([10_000, 20_000]);
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);
  });

  it("declares the connection dead at the strike limit and stops sending", async () => {
    const states: Array<{ state: ProbeState; at: number }> = [];
    let sends = 0;
    const { probe, clock } = probeWith(
      () => {
        sends += 1;
        return Promise.resolve({ ok: false });
      },
      { onStateChange: (state, at) => states.push({ state, at }) },
    );

    probe.start();
    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("suspect");

    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("dead");
    expect(probe.strikes()).toBe(2);
    expect(states).toEqual([
      { state: "suspect", at: 10_000 },
      { state: "dead", at: 20_000 },
    ]);
    expect(clock.pending()).toBe(0);

    clock.advance(1_000_000);
    await flush();
    expect(sends).toBe(2);
  });

  it("returns to alive and clears the counter when a round trip succeeds", async () => {
    const answers = [false, true, false];
    let next = 0;
    const { probe, clock } = probeWith(() => {
      const ok = answers[next] ?? false;
      next += 1;
      return Promise.resolve({ ok });
    });

    probe.start();
    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);

    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("alive");
    expect(probe.strikes()).toBe(0);

    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);
  });

  it("counts a timeout as one strike and ignores the abandoned answer", async () => {
    const resolvers: Array<(answer: { ok: boolean }) => void> = [];
    let sends = 0;
    const { probe, clock } = probeWith(() => {
      sends += 1;
      return new Promise<{ ok: boolean }>((resolve) => resolvers.push(resolve));
    });

    probe.start();
    clock.advance(10_000);
    expect(sends).toBe(1);
    clock.advance(7_999);
    expect(probe.state()).toBe("alive");

    // The timeout fires here: one strike, and the attempt is abandoned.
    clock.advance(1);
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);

    resolvers[0]?.({ ok: true });
    await flush();
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);
    expect(sends).toBe(1);

    // The next attempt is still on schedule, measured from the settlement.
    clock.advance(10_000);
    expect(sends).toBe(2);
    expect(clock.now()).toBe(28_000);
  });

  it("skips ticks while a round trip is open instead of queueing them", () => {
    let sends = 0;
    const { probe, clock } = probeWith(
      () => {
        sends += 1;
        return new Promise<{ ok: boolean }>(() => {});
      },
      { intervalMs: 100, timeoutMs: 1_000 },
    );

    probe.start();
    clock.advance(100);
    expect(sends).toBe(1);

    // Ticks at 200, 300, 400 and 500 all land on an open round trip.
    clock.advance(400);
    expect(sends).toBe(1);

    // The attempt times out at 1_100; nothing was queued to fire with it.
    clock.advance(600);
    expect(probe.strikes()).toBe(1);
    expect(sends).toBe(1);

    clock.advance(100);
    expect(sends).toBe(2);
  });

  it("takes 36_000 ms to detect a disconnect that follows a successful answer", () => {
    let sends = 0;
    const { probe, clock } = probeWith(() => {
      sends += 1;
      return new Promise<{ ok: boolean }>(() => {});
    });

    // The connection answers successfully at t=0.
    probe.start();

    // First attempt leaves at 10_000 and times out at 18_000.
    clock.advance(10_000);
    expect(sends).toBe(1);
    expect(probe.state()).toBe("alive");
    clock.advance(8_000);
    expect(clock.now()).toBe(18_000);
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);

    // Second attempt leaves at 28_000 and times out at 36_000.
    clock.advance(10_000);
    expect(sends).toBe(2);
    clock.advance(7_999);
    expect(clock.now()).toBe(35_999);
    expect(probe.state()).toBe("suspect");

    clock.advance(1);
    expect(clock.now()).toBe(36_000);
    expect(probe.state()).toBe("dead");
    expect(probe.strikes()).toBe(2);
  });

  it("stop() leaves no timer behind and drops the in-flight round trip", async () => {
    const resolvers: Array<(answer: { ok: boolean }) => void> = [];
    let sends = 0;
    const { probe, clock } = probeWith(() => {
      sends += 1;
      return new Promise<{ ok: boolean }>((resolve) => resolvers.push(resolve));
    });

    probe.start();
    clock.advance(10_000);
    expect(sends).toBe(1);
    expect(clock.pending()).toBeGreaterThan(0);

    probe.stop();
    expect(clock.pending()).toBe(0);

    resolvers[0]?.({ ok: true });
    await flush();
    expect(probe.state()).toBe("alive");
    expect(probe.strikes()).toBe(0);

    clock.advance(1_000_000);
    await flush();
    expect(sends).toBe(1);
    expect(clock.pending()).toBe(0);

    // Stopping before the first tick is equally quiet.
    probe.start();
    probe.stop();
    expect(clock.pending()).toBe(0);
  });

  it("treats a rejected round trip as a failure instead of throwing", async () => {
    const { probe, clock } = probeWith(() => Promise.reject(new Error("transport broke")));

    probe.start();
    clock.advance(10_000);
    await flush();
    expect(probe.state()).toBe("suspect");
    expect(probe.strikes()).toBe(1);
  });

  it("honours a custom strike limit", async () => {
    const { probe, clock } = probeWith(() => Promise.resolve({ ok: false }), { strikes: 3 });

    probe.start();
    for (const expected of [1, 2]) {
      clock.advance(10_000);
      await flush();
      expect(probe.strikes()).toBe(expected);
      expect(probe.state()).toBe("suspect");
    }

    clock.advance(10_000);
    await flush();
    expect(probe.strikes()).toBe(3);
    expect(probe.state()).toBe("dead");
    expect(clock.pending()).toBe(0);
  });
});
