import { describe, expect, it } from "vitest";

import { createReconnectAgent } from "./agent";
import { createProbe } from "./probe";
import { createTransportWatch } from "./watcher";
import type { PageResult } from "./controller";
import type { ReplayGap, ReplaySink, RecoveryStep, ReplayStateKind } from "./types";
import type { EngineTransport } from "../client";

const idle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeClock(start = 1_000_000) {
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

function fakeTransport() {
  const listeners = new Set<(reason: string) => void>();
  const transport: EngineTransport = {
    isOpen: true,
    send: () => ({ ok: true }),
    onFrame: () => () => {},
    onClose: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {},
  };
  return {
    transport,
    drop(reason = "peer went away") {
      for (const listener of [...listeners]) listener(reason);
    },
  };
}

/** Records every call a consumer would receive, so "no clear" is checkable. */
function recordingSink() {
  const calls: string[] = [];
  const sink: ReplaySink = {
    begin: () => calls.push("begin"),
    messages: () => calls.push("messages"),
    states: () => calls.push("states"),
    focus: () => calls.push("focus"),
    end: () => calls.push("end"),
  };
  return { sink, calls };
}

const pageOf = (
  ids: readonly string[],
  hasMore = false,
  nextBefore: string | null = null,
): PageResult => ({
  ok: true,
  page: { messages: ids.map((id) => ({ id })), hasMore, nextBefore },
});

const ALL_STATES: readonly ReplayStateKind[] = ["device", "loop", "queue", "subagent"];

function build(
  overrides: {
    pages?: () => PageResult;
    sync?: () => Promise<{ approvals: readonly string[]; states: readonly ReplayStateKind[] }>;
    cursor?: () => string | null;
    degradedAfterMs?: number;
  } = {},
) {
  const clock = fakeClock();
  const watch = createTransportWatch();
  const steps: RecoveryStep[] = [];
  const gaps: ReplayGap[] = [];
  const recorder = recordingSink();

  const agent = createReconnectAgent({
    agentId: "agent-a",
    clock,
    watch,
    sync: overrides.sync ?? (async () => ({ approvals: [], states: ALL_STATES })),
    page: async () => (overrides.pages ?? (() => pageOf(["m2", "m1"])))(),
    sink: recorder.sink,
    ...(overrides.cursor === undefined ? {} : { cursor: overrides.cursor }),
    ...(overrides.degradedAfterMs === undefined
      ? {}
      : { degradedAfterMs: overrides.degradedAfterMs }),
  });

  agent.onStep((_agent, step) => steps.push(step));
  agent.onGap((_agent, gap) => gaps.push(gap));

  return { agent, clock, watch, steps, gaps, sinkCalls: recorder.calls };
}

describe("assembled reconnect layer", () => {
  it("starts ready, with sending allowed and nothing to retry", () => {
    const { agent } = build();

    expect(agent.status().state).toBe("ready");
    expect(agent.canSend()).toBe(true);
  });

  it("turns a closed socket into a recovery that ends ready", async () => {
    // This is the wiring, not the parts: the watch sees a close, the machine
    // moves, the sequence runs, and the caller is left able to send again.
    const { agent, watch, steps } = build();
    const socket = fakeTransport();
    const states: string[] = [];
    agent.onStatus((status) => states.push(status.state));

    watch.attach("agent-a", socket.transport);
    socket.drop();

    expect(agent.status().state).toBe("reconnecting");
    expect(agent.canSend()).toBe(false);

    await idle();

    expect(states).toContain("reconnecting");
    expect(states).toContain("replaying");
    expect(agent.status().state).toBe("ready");
    expect(agent.canSend()).toBe(true);
    expect(steps.map((step) => step.step)).toEqual(["sync", "messages", "states"]);
  });

  it("never asks the consumer to clear what it shows", async () => {
    const { agent, sinkCalls } = build();

    await agent.recover();

    expect(sinkCalls).toEqual(["begin", "states", "end"]);
  });

  it("goes degraded when the window runs out, refuses to send, and recovers on retry", async () => {
    // A resync that never answers keeps the layer in the reconnect window, which
    // is how a real dead engine looks from here.
    const { agent, clock, watch } = build({
      degradedAfterMs: 1_000,
      sync: () => new Promise(() => {}),
    });
    const socket = fakeTransport();
    watch.attach("agent-a", socket.transport);
    socket.drop();

    clock.advance(1_000);
    expect(agent.status().state).toBe("degraded");
    expect(agent.canSend()).toBe(false);

    // A retry is a decision, and it has to be able to move the layer on.
    agent.retry();
    expect(agent.status().state).toBe("reconnecting");
    expect(agent.status().cause).toBe("user-retry");
  });

  it("reports a gap when the page does not contain where we stopped", async () => {
    const { agent, gaps } = build({
      cursor: () => "m9",
      pages: () => pageOf(["m3", "m2"]),
    });

    await agent.recover();

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      kind: "history-gap",
      at: "m9",
      range: { from: "m9", to: "m3" },
    });
  });

  it("reports no gap when the page contains where we stopped", async () => {
    const { agent, gaps } = build({
      cursor: () => "m2",
      pages: () => pageOf(["m3", "m2"]),
    });

    await agent.recover();

    expect(gaps).toEqual([]);
  });

  it("lets a probe cycle touch nothing the consumer can see", () => {
    // A probe is a liveness check, not a refresh: it may send, and it may change
    // its own verdict, but it must not move the layer's state or hand the consumer
    // a single event. The send count is asserted too -- a probe that does nothing
    // at all would satisfy the rest of this test.
    const { agent, clock, steps, gaps, sinkCalls } = build();
    const sent: number[] = [];
    const statuses: string[] = [];
    agent.onStatus((status) => statuses.push(status.state));

    const probe = createProbe({
      clock,
      send: async () => {
        sent.push(sent.length + 1);
        return { ok: true };
      },
    });

    probe.start();
    clock.advance(10_000);
    clock.advance(10_000);
    probe.stop();

    expect(sent.length).toBeGreaterThan(0);
    expect(statuses).toEqual([]);
    expect(steps).toEqual([]);
    expect(gaps).toEqual([]);
    expect(sinkCalls).toEqual([]);
    expect(agent.status().state).toBe("ready");
  });

  it("stops listening to the watch after dispose", () => {
    const { agent, watch } = build();
    const socket = fakeTransport();
    watch.attach("agent-a", socket.transport);

    agent.dispose();
    socket.drop();

    expect(agent.status().state).toBe("ready");
  });
});
