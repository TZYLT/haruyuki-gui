/**
 * Tests for the one-shot restart.
 *
 * Every case drives the module through an injected timer, so the budget is
 * walked by hand at the exact millisecond it closes and nothing waits. Stop and
 * start are promises the test settles itself, which is how "concurrent calls
 * share one attempt" and "a failed stop does not skip start" get pinned without
 * a real child process.
 */

import { describe, expect, it } from "vitest";

import { createRestartPort } from "./restart";
import type { RestartPort } from "./restart";

interface Endpoint {
  readonly url: string;
  readonly token: string;
}

const FIRST: Endpoint = { url: "ws://127.0.0.1:9100", token: "token-one" };
const SECOND: Endpoint = { url: "ws://127.0.0.1:9200", token: "token-two" };

/** A timer that only fires when the test walks it forward. */
function fakeClock() {
  interface Timer {
    readonly id: number;
    readonly at: number;
    readonly fn: () => void;
  }
  let time = 0;
  let nextId = 1;
  const timers = new Set<Timer>();

  return {
    setTimer(fn: () => void, ms: number): () => void {
      const timer: Timer = { id: nextId, at: time + ms, fn };
      nextId += 1;
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    /** Fires every due callback, including ones armed during the walk. */
    advance(ms: number): void {
      const target = time + ms;
      for (;;) {
        let due: Timer | null = null;
        for (const timer of timers) {
          if (timer.at > target) continue;
          if (due === null || timer.at < due.at || (timer.at === due.at && timer.id < due.id)) {
            due = timer;
          }
        }
        if (due === null) break;
        timers.delete(due);
        time = due.at;
        due.fn();
      }
      time = target;
    },
    pending: (): number => timers.size,
  };
}

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Lets the promise chain of one stop/start settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

interface Handlers {
  readonly stop?: () => Promise<void>;
  readonly start?: () => Promise<Endpoint>;
  readonly timeoutMs?: number;
}

/**
 * A port over recording steps. `state` is mutable so a case can change what the
 * next attempt does without building a second port: "a failed start does not
 * poison the next attempt" is exactly a change of behaviour between two calls.
 */
function harness(handlers: Handlers = {}) {
  const clock = fakeClock();
  const calls: string[] = [];
  const state = {
    stop: handlers.stop ?? (async (): Promise<void> => {}),
    start: handlers.start ?? (async (): Promise<Endpoint> => FIRST),
  };
  const ports = {
    stop: (): Promise<void> => {
      calls.push("stop");
      return state.stop();
    },
    start: (): Promise<Endpoint> => {
      calls.push("start");
      return state.start();
    },
  };
  const timer = { setTimer: clock.setTimer.bind(clock) };
  const port: RestartPort = createRestartPort(
    ports,
    handlers.timeoutMs === undefined ? timer : { ...timer, timeoutMs: handlers.timeoutMs },
  );
  return { clock, calls, state, port };
}

describe("createRestartPort", () => {
  it("stops the old process before starting a new one, once each", async () => {
    const { calls, port } = harness();

    await expect(port.restart()).resolves.toEqual(FIRST);
    expect(calls).toEqual(["stop", "start"]);
  });

  it("shares the attempt already in flight instead of starting a second process", async () => {
    const gate = deferred<Endpoint>();
    const { calls, port } = harness({ start: () => gate.promise });

    const first = port.restart();
    await flush();
    const second = port.restart();

    expect(second).toBe(first);
    expect(calls).toEqual(["stop", "start"]);

    gate.resolve(FIRST);
    await expect(first).resolves.toEqual(FIRST);
    await expect(second).resolves.toEqual(FIRST);
  });

  it("starts a fresh attempt once the previous one has settled", async () => {
    const { calls, port } = harness();

    await port.restart();
    await port.restart();

    expect(calls).toEqual(["stop", "start", "stop", "start"]);
  });

  it("still starts when the old process cannot be stopped cleanly", async () => {
    const { calls, clock, port } = harness({
      stop: () => Promise.reject(new Error("stop failed")),
    });

    await expect(port.restart()).resolves.toEqual(FIRST);

    expect(calls).toEqual(["stop", "start"]);
    expect(clock.pending()).toBe(0);
  });

  it("rejects with the start error unchanged and allows a later attempt", async () => {
    const failure = new Error("start failed");
    const { calls, clock, port, state } = harness({ start: () => Promise.reject(failure) });

    await expect(port.restart()).rejects.toBe(failure);

    state.start = async () => SECOND;
    await expect(port.restart()).resolves.toEqual(SECOND);

    expect(calls).toEqual(["stop", "start", "stop", "start"]);
    expect(clock.pending()).toBe(0);
  });

  it("rejects once the budget is spent, names it, and clears the timer", async () => {
    const { clock, port } = harness({
      timeoutMs: 5_000,
      start: () => new Promise<Endpoint>(() => {}),
    });

    const pending = port.restart();
    const rejected = expect(pending).rejects.toThrow(/5000 ms budget/);

    clock.advance(5_000);
    await rejected;

    expect(clock.pending()).toBe(0);
  });

  it("defaults to a 30000 ms budget", async () => {
    const { clock, port } = harness({ start: () => new Promise<Endpoint>(() => {}) });

    const outcome = port.restart().then(
      () => "resolved",
      (error: Error) => error.message,
    );

    clock.advance(29_999);
    await flush();
    expect(clock.pending()).toBe(1);

    clock.advance(1);
    expect(await outcome).toContain("30000 ms budget");
    expect(clock.pending()).toBe(0);
  });

  it("counts the stop step against the same budget", async () => {
    const { calls, clock, port } = harness({
      timeoutMs: 2_000,
      stop: () => new Promise<void>(() => {}),
    });

    const pending = port.restart();
    const rejected = expect(pending).rejects.toThrow(/2000 ms budget/);

    clock.advance(2_000);
    await rejected;

    expect(calls).toEqual(["stop"]);
    expect(clock.pending()).toBe(0);
  });

  it("allows a new attempt after a timeout abandoned the previous one", async () => {
    const { calls, clock, port, state } = harness({
      timeoutMs: 1_000,
      start: () => new Promise<Endpoint>(() => {}),
    });

    const pending = port.restart();
    const rejected = expect(pending).rejects.toThrow(/1000 ms budget/);
    clock.advance(1_000);
    await rejected;

    state.start = async () => SECOND;
    await expect(port.restart()).resolves.toEqual(SECOND);

    expect(calls).toEqual(["stop", "start", "stop", "start"]);
  });

  it("clears the budget on dispose and refuses to restart afterwards", async () => {
    const { calls, clock, port } = harness();

    port.dispose();
    port.dispose();

    expect(clock.pending()).toBe(0);
    await expect(port.restart()).rejects.toThrow(/disposed/);
    expect(calls).toEqual([]);
  });

  it("clears the budget of an attempt already in flight when disposed", async () => {
    const gate = deferred<Endpoint>();
    const { clock, port } = harness({ start: () => gate.promise });

    const pending = port.restart();
    await flush();
    expect(clock.pending()).toBe(1);

    port.dispose();
    expect(clock.pending()).toBe(0);

    gate.resolve(SECOND);
    await expect(pending).resolves.toEqual(SECOND);
    await expect(port.restart()).rejects.toThrow(/disposed/);
  });
});
