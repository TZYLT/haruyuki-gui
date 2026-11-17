import { describe, expect, it } from "vitest";

import { createStateMachine } from "./state-machine";
import type { ReconnectStatus } from "./types";

/** A clock whose timers only fire when the test walks it forward. */
function fakeClock(start = 1_000_000) {
  let now = start;
  let timers: Array<{ at: number; fn: () => void }> = [];

  return {
    now: () => now,
    setTimer(fn: () => void, ms: number): () => void {
      const entry = { at: now + ms, fn };
      timers.push(entry);
      return () => {
        timers = timers.filter((candidate) => candidate !== entry);
      };
    },
    advance(ms: number): void {
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
    pending: () => timers.length,
  };
}

function build(options: { degradedAfterMs?: number } = {}) {
  const clock = fakeClock();
  const seen: ReconnectStatus[] = [];
  const machine = createStateMachine({
    agentId: "agent-a",
    clock,
    ...(options.degradedAfterMs === undefined ? {} : { degradedAfterMs: options.degradedAfterMs }),
    onChange: (status) => seen.push(status),
  });
  return { clock, machine, seen };
}

describe("reconnect state machine", () => {
  it("starts ready, with nothing to retry and sending allowed", () => {
    const { machine } = build();

    expect(machine.status()).toMatchObject({ state: "ready", attempt: 0, cause: null });
    expect(machine.canSend()).toBe(true);
  });

  it("moves to reconnecting on a close, and refuses to send there", () => {
    const { clock, machine, seen } = build();

    machine.transportClosed("reset");

    expect(machine.status()).toMatchObject({ state: "reconnecting", attempt: 1, cause: "reset" });
    expect(machine.status().since).toBe(new Date(clock.now()).toISOString());
    expect(machine.canSend()).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it("gives up after the window and reports degraded", () => {
    const { clock, machine } = build({ degradedAfterMs: 12_000 });

    machine.transportClosed("reset");
    clock.advance(11_999);
    expect(machine.status().state).toBe("reconnecting");

    clock.advance(1);
    expect(machine.status().state).toBe("degraded");
    expect(machine.canSend()).toBe(false);
  });

  it("uses the shipped window when the caller names none", () => {
    // The tests above pass the window in, so they would stay green if the default
    // changed to a minute. This one does not name it: it pins the value the
    // product actually ships.
    const { clock, machine } = build();

    machine.transportClosed("reset");
    clock.advance(11_999);
    expect(machine.status().state).toBe("reconnecting");

    clock.advance(1);
    expect(machine.status().state).toBe("degraded");
  });

  it("comes back to ready when the recovery finishes, and stops the timer", () => {
    const { clock, machine } = build();

    machine.transportClosed("silent");
    clock.advance(2_000);
    machine.recoveryStarted();
    expect(machine.status().state).toBe("replaying");

    machine.recoveryFinished();
    expect(machine.status()).toMatchObject({ state: "ready", attempt: 0, cause: null });
    expect(machine.canSend()).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("counts attempts, and a failed attempt does not extend the window", () => {
    const { clock, machine } = build({ degradedAfterMs: 12_000 });

    machine.transportClosed("reset");
    clock.advance(5_000);
    machine.recoveryStarted();
    machine.recoveryFailed();
    expect(machine.status()).toMatchObject({ state: "reconnecting", attempt: 2 });

    // The window is measured from the loss, not from the last attempt: 7 s more
    // reaches the 12 s mark even though the second attempt started at 5 s.
    clock.advance(7_000);
    expect(machine.status().state).toBe("degraded");
  });

  it("lets the user retry from degraded, and the retry can succeed", () => {
    const { clock, machine } = build({ degradedAfterMs: 1_000 });

    machine.transportClosed("reset");
    clock.advance(1_000);
    expect(machine.status().state).toBe("degraded");

    machine.retry();
    expect(machine.status()).toMatchObject({
      state: "reconnecting",
      attempt: 1,
      cause: "user-retry",
    });

    machine.recoveryStarted();
    machine.recoveryFinished();
    expect(machine.status().state).toBe("ready");
  });

  it("treats a changed endpoint as its own cause", () => {
    const { machine } = build();

    machine.endpointChanged();

    expect(machine.status()).toMatchObject({ state: "reconnecting", cause: "endpoint-changed" });
  });

  it("ignores a close that arrives while already degraded", () => {
    const { clock, machine } = build({ degradedAfterMs: 1_000 });
    machine.transportClosed("reset");
    clock.advance(1_000);
    const degradedSince = machine.status().since;

    machine.transportClosed("silent");

    expect(machine.status().state).toBe("degraded");
    expect(machine.status().since).toBe(degradedSince);
  });

  it("carries the stale count, and reports it once per value", () => {
    const { machine, seen } = build();
    const before = seen.length;

    machine.noteStale(1);
    expect(machine.status().staleCount).toBe(1);
    expect(seen).toHaveLength(before + 1);

    machine.noteStale(1);
    expect(seen).toHaveLength(before + 1);

    machine.noteStale(0);
    expect(machine.status().staleCount).toBe(0);
    expect(seen).toHaveLength(before + 2);
  });

  it("stops transitioning after dispose", () => {
    const { clock, machine, seen } = build();
    machine.transportClosed("reset");
    const afterClose = seen.length;

    machine.dispose();
    clock.advance(60_000);
    machine.retry();

    expect(machine.status().state).toBe("reconnecting");
    expect(seen).toHaveLength(afterClose);
    expect(clock.pending()).toBe(0);
  });
});
