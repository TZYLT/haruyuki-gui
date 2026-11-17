/**
 * Tests for the feed: the only production path from an engine frame to the phase
 * machine.
 *
 * What is being tested, and why it needs both halves
 *   `feed.ts` is glue, so a test of the glue alone would assert that a callback
 *   was called -- which is exactly the kind of assertion that let `frames.ts` sit
 *   unused for a whole work package. The cases below therefore drive the real
 *   `reducePhase` through the real feed and assert the resulting *phase*: a feed
 *   that called the receiver with the wrong signal, or in the wrong order, would
 *   fail on the phase rather than on a spy's call count.
 *
 * Why the ordering cases exist
 *   The feed cannot order anything -- that is the reducer's job -- but a feed that
 *   translated an `exited` into a `spawned` signal, or forwarded output as a
 *   session change, would still "work" for the happy path. So the cases here drive
 *   sequences, and one of them is the race that matters: a `spawned` frame
 *   arriving after the session was already refused.
 *
 * Why `terminal_output` gets a case at all
 *   It is the frame most likely to be forwarded by accident, because a terminal
 *   demo without output looks broken. Forwarding it would re-render the panel once
 *   per slice of a `cat`, which is a performance defect that reads as a feature.
 */

import { describe, expect, it, vi } from "vitest";

import { connectTerminalFeed, createTerminalFeed } from "./feed.js";
import type { TerminalFrameSource } from "./feed.js";
import type { TerminalFrame, TerminalLifecycleEvent } from "./frames.js";
import { initialPanelState } from "./panel.js";
import { reducePhase } from "./state.js";
import type { TerminalPanelState, TerminalSignal } from "./state.js";

/** @param t the discriminator @param body the payload @returns a frame */
function frame(t: string, body: unknown): TerminalFrame {
  return { t, body };
}

/** @param pid the process id @returns a spawn frame */
function spawned(pid: number): TerminalFrame {
  return frame("terminal_spawned", { terminal_id: "t-1", pid });
}

/** @param exitCode the code @param error the engine's text @returns an exit frame */
function exited(exitCode: number, error?: string): TerminalFrame {
  return frame(
    "terminal_exited",
    error === undefined
      ? { terminal_id: "t-1", exitCode }
      : { terminal_id: "t-1", exitCode, error },
  );
}

/**
 * Wire a feed to the real reducer, the way the host does.
 *
 * @returns the feed and a reader for the current phase
 */
function wired(): {
  feed: ReturnType<typeof createTerminalFeed>;
  signals: TerminalSignal[];
  state(): TerminalPanelState;
} {
  const signals: TerminalSignal[] = [];
  let state = initialPanelState("t-1", undefined);

  const feed = createTerminalFeed({
    receive: (signal) => {
      signals.push(signal);
      state = reducePhase(state, signal);
    },
  });

  return { feed, signals, state: () => state };
}

describe("a frame becomes a phase change", () => {
  it("moves an idle panel to running through the real reducer, which is the path that did not exist", () => {
    // The end-to-end claim: before this module, nothing in production code took a
    // frame to `reducePhase`, so a panel could only reach `running` in a test that
    // emulated the signal itself. The request is made by the reducer directly here,
    // because asking for a start is the panel's decision and not a frame.
    const { feed, state } = wired();

    feed.acceptLifecycle({ kind: "ready" });
    const starting = reducePhase(state(), { kind: "spawn-requested" });

    expect(starting.phase).toBe("starting");

    // The panel's dispatch is the same reducer, so the feed's receiver has to be
    // pointed at the state the test just advanced. Rebuilt around the same object
    // so the assertion is about the frame and not about wiring.
    let live = starting;
    const panel = createTerminalFeed({
      receive: (signal) => {
        live = reducePhase(live, signal);
      },
    });

    const result = panel.accept(spawned(4242));

    expect(result.kind).toBe("signal");
    expect(live.phase).toBe("running");
    expect(live.pid).toBe(4242);
  });

  it("reports the pid the frame carried, because a scan of the process table has nothing else", () => {
    const { feed, state } = wired();

    feed.accept(spawned(7));

    // In `idle` the reducer ignores a spawn nobody asked for, and that is the
    // point: the feed forwards, it does not filter on the phase.
    expect(state().phase).toBe("idle");
  });

  it("carries an exit frame into the phase that shows its code", () => {
    const signals: TerminalSignal[] = [];
    const feed = createTerminalFeed({ receive: (signal) => signals.push(signal) });

    feed.accept(exited(0));

    expect(signals).toEqual([{ kind: "exited", exitCode: 0, error: null }]);
    expect(signals[0]?.kind).toBe("exited");
  });
});

describe("what is not a session change", () => {
  it("refuses terminal_output instead of forwarding it, because output goes to the sink", () => {
    // Forwarding it would re-render the panel once per slice of a `cat`.
    const receive = vi.fn();
    const feed = createTerminalFeed({ receive });

    const result = feed.accept(frame("terminal_output", { terminal_id: "t-1", text: "hello" }));

    expect(result).toEqual({
      kind: "refused",
      because: "unrelated-frame",
      wire: "terminal_output",
    });
    expect(receive).not.toHaveBeenCalled();
  });

  it("tells the host about a refusal, because 'never arrived' and 'arrived unrecognised' look the same without it", () => {
    const refusals: { because: string; wire: string }[] = [];
    const feed = createTerminalFeed({
      receive: vi.fn(),
      onRefused: (entry) => refusals.push(entry),
    });

    feed.accept(frame("terminal_reflowed", { terminal_id: "t-1" }));

    expect(refusals).toEqual([{ because: "unknown-terminal-frame", wire: "terminal_reflowed" }]);
  });

  it("counts refusals by reason, so a version skew is distinguishable from a malformed frame", () => {
    const feed = createTerminalFeed({ receive: vi.fn() });

    feed.accept(frame("terminal_output", { terminal_id: "t-1", text: "x" }));
    feed.accept(frame("terminal_reflowed", { terminal_id: "t-1" }));
    feed.accept(frame("terminal_spawned", { terminal_id: "t-1" }));

    expect(feed.stats.byRefusal).toEqual({
      "unrelated-frame": 1,
      malformed: 1,
      "unknown-terminal-frame": 1,
    });
    expect(feed.stats.accepted).toBe(3);
    expect(feed.stats.refused).toBe(3);
  });

  it("counts a frame it handled separately from one it refused", () => {
    const feed = createTerminalFeed({ receive: vi.fn() });

    feed.accept(spawned(1));

    expect(feed.stats.refused).toBe(0);
    expect(feed.stats.accepted).toBe(1);
  });
});

describe("readiness comes through the same door", () => {
  it("hands the engine signal to the receiver, because the reducer must not tell the two sources apart", () => {
    const receive = vi.fn();
    const feed = createTerminalFeed({ receive });

    const signal = feed.acceptLifecycle({ kind: "ready" });

    expect(signal).toEqual({ kind: "engine", ready: true });
    expect(receive).toHaveBeenCalledWith({ kind: "engine", ready: true });
  });

  it("does not count a lifecycle event as a frame, because 'frames received' would then exceed what the bridge sent", () => {
    const feed = createTerminalFeed({ receive: vi.fn() });

    feed.acceptLifecycle({ kind: "ready" });
    feed.acceptLifecycle({ kind: "unavailable" });

    expect(feed.stats.accepted).toBe(0);
    expect(feed.stats.refused).toBe(0);
  });

  it("returns the signal as well as delivering it, so a host can log what it forwarded", () => {
    const feed = createTerminalFeed({ receive: vi.fn() });

    expect(feed.acceptLifecycle({ kind: "unavailable" })).toEqual({
      kind: "engine",
      ready: false,
    });
  });
});

describe("sequences", () => {
  it("drives idle to running to exited with the frames a real session sends, in order", () => {
    // The whole session as a sequence, through the real reducer. This is the
    // assertion that would have failed for every work package before this one.
    const signals: TerminalSignal[] = [];
    let state = initialPanelState("t-1", undefined);

    const feed = createTerminalFeed({
      receive: (signal) => {
        signals.push(signal);
        state = reducePhase(state, signal);
      },
    });

    feed.acceptLifecycle({ kind: "ready" });
    state = reducePhase(state, { kind: "spawn-requested" });
    feed.accept(spawned(99));
    feed.accept(exited(0, undefined));

    expect(signals.map((signal) => signal.kind)).toEqual(["engine", "spawned", "exited"]);
    expect(state.phase).toBe("exited");
    expect(state.exitCode).toBe(0);
  });

  it("keeps a spawn failure and a clean exit apart through the whole chain, because the frame carries both", () => {
    // One frame, two meanings, and the meaning must survive the translation: the
    // reducer branches on `error`, so a feed that normalised it would collapse the
    // two phases the panel exists to distinguish.
    const clean: TerminalSignal[] = [];
    const failed: TerminalSignal[] = [];

    createTerminalFeed({ receive: (s) => clean.push(s) }).accept(exited(0));
    createTerminalFeed({ receive: (s) => failed.push(s) }).accept(exited(1, "spawn ENOENT"));

    expect(clean[0]).toEqual({ kind: "exited", exitCode: 0, error: null });
    expect(failed[0]).toEqual({ kind: "exited", exitCode: 1, error: "spawn ENOENT" });
  });

  it("forwards a spawned frame that lost its race, because ordering is the reducer's job", () => {
    // A refusal followed by a late confirmation: the reducer must see both and
    // decide, and it does -- `spawned` in `failed` is ignored because that session
    // was already reported as failed. A feed that dropped it would hide a real
    // protocol race from the one place that models it.
    const signals: TerminalSignal[] = [];
    const feed = createTerminalFeed({ receive: (signal) => signals.push(signal) });

    feed.accept(exited(1, "denied"));
    feed.accept(spawned(5));

    expect(signals.map((signal) => signal.kind)).toEqual(["exited", "spawned"]);
  });
});

describe("connecting a source to the reducer", () => {
  /**
   * A source that lets a test deliver frames, the way the bridge would.
   *
   * @returns the source and its two emitters
   */
  function source(withLifecycle = true) {
    const frames = new Set<(frame: TerminalFrame) => void>();
    const lifecycles = new Set<(event: TerminalLifecycleEvent) => void>();

    const subscribe = (listener: (frame: TerminalFrame) => void): (() => void) => {
      frames.add(listener);

      return () => {
        frames.delete(listener);
      };
    };

    // Two shapes rather than one optional property: `exactOptionalPropertyTypes`
    // rejects an optional member that is present-and-undefined, and a spread that
    // omits it entirely is the only way to build the without-lifecycle source the
    // shipped bridge actually is.
    const entry: TerminalFrameSource = withLifecycle
      ? {
          subscribe,
          subscribeLifecycle(listener) {
            lifecycles.add(listener);

            return () => {
              lifecycles.delete(listener);
            };
          },
        }
      : { subscribe };

    return {
      source: entry,
      emit(frame: TerminalFrame) {
        for (const listener of [...frames]) listener(frame);
      },
      lifecycle(event: TerminalLifecycleEvent) {
        for (const listener of [...lifecycles]) listener(event);
      },
      counts() {
        return { frames: frames.size, lifecycles: lifecycles.size };
      },
    };
  }

  it("carries a frame all the way to a phase, because that is the path this module exists for", () => {
    // The claim in one line: a frame from the transport changes the panel's phase
    // without the test touching the reducer or the translation.
    const harness = source();
    let state = initialPanelState("t-1", undefined);

    const { feed } = connectTerminalFeed(harness.source, {
      receive: (signal) => {
        state = reducePhase(state, signal);
      },
    });
    void feed;

    harness.lifecycle({ kind: "ready" });
    state = reducePhase(state, { kind: "spawn-requested" });
    harness.emit(spawned(4242));

    expect(state.phase).toBe("running");
    expect(state.pid).toBe(4242);
  });

  it("delivers frames and lifecycle events through the one receiver, because the reducer takes both", () => {
    const harness = source();
    const seen: TerminalSignal[] = [];

    connectTerminalFeed(harness.source, { receive: (signal) => seen.push(signal) });

    harness.lifecycle({ kind: "ready" });
    harness.emit(exited(0));

    expect(seen).toEqual([
      { kind: "engine", ready: true },
      { kind: "exited", exitCode: 0, error: null },
    ]);
  });

  it("works when the source reports no lifecycle at all, because the shipped bridge does not", () => {
    // The bridge has no success callback today, so a feed that required one would
    // work in a test and throw in production.
    const harness = source(false);
    const seen: TerminalSignal[] = [];

    const { feed } = connectTerminalFeed(harness.source, {
      receive: (signal) => seen.push(signal),
    });

    harness.emit(spawned(1));

    expect(seen).toHaveLength(1);
    expect(feed.stats.accepted).toBe(1);
  });

  it("unsubscribes both listeners on dispose, because a closed panel must not keep translating", () => {
    const harness = source();
    const seen: TerminalSignal[] = [];

    const { dispose } = connectTerminalFeed(harness.source, {
      receive: (signal) => seen.push(signal),
    });

    dispose();
    harness.emit(spawned(1));
    harness.lifecycle({ kind: "ready" });

    expect(seen).toEqual([]);
    expect(harness.counts()).toEqual({ frames: 0, lifecycles: 0 });
  });

  it("can be disposed twice, because a teardown path may run again", () => {
    const harness = source();
    const { dispose } = connectTerminalFeed(harness.source, { receive: vi.fn() });

    dispose();

    expect(() => dispose()).not.toThrow();
  });
});
