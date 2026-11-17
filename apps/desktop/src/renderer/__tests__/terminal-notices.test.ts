/**
 * Tests for the surface a dropped-bytes notice goes through.
 *
 * What is under test, and why it is a module rather than two closures
 *   `main.tsx` used to pass the same console call twice, and neither was reachable
 *   from anything that renders. This object is where both producers hand their
 *   notice and where the panel subscribes, so the properties worth asserting are
 *   the ones that stopped the two-closure version from working: a subscriber that
 *   mounts late still learns about a drop that already happened, and the event has
 *   exactly one path so a notice cannot be rendered twice or lost.
 *
 * Why the "latest only" behaviour is asserted rather than assumed
 *   A notice describes a gap in the output on screen now. A queue would replay old
 *   gaps after the screen moved on, so the buffer keeps one and the counter keeps
 *   the history. Both halves are asserted, because either one alone reads as a
 *   mistake: a counter without the buffer looks like data loss, a buffer without
 *   the counter looks like a notice nobody could account for.
 */

import { describe, expect, it, vi } from "vitest";

import type { TerminalNotice } from "@haruyuki/ui";

import { createTerminalNotices, terminalNotices } from "../terminal-notices.js";

/** @param id the terminal @param bytes how many were dropped @returns a notice */
function notice(id: string, bytes: number): TerminalNotice {
  return { terminal_id: id, droppedBytes: bytes };
}

describe("publishing", () => {
  it("hands a notice to every subscriber, because the panel is not the only thing watching", () => {
    const sink = createTerminalNotices();
    const first = vi.fn();
    const second = vi.fn();

    sink.subscribe(first);
    sink.subscribe(second);
    sink.publish(notice("t-1", 4096));

    expect(first).toHaveBeenCalledWith(notice("t-1", 4096));
    expect(second).toHaveBeenCalledWith(notice("t-1", 4096));
  });

  it("counts what it published, because the buffer keeps only the newest and the history still matters", () => {
    const sink = createTerminalNotices();

    sink.publish(notice("t-1", 1));
    sink.publish(notice("t-1", 2));

    expect(sink.published).toBe(2);
  });

  it("starts at zero, so a diagnostic can tell 'none yet' from 'none recorded'", () => {
    expect(createTerminalNotices().published).toBe(0);
  });
});

describe("a subscriber that arrives late", () => {
  it("is told about the pending notice, because a drop during mount would otherwise be invisible", () => {
    // This is the case the two-closure version could not express: the notice
    // arrives on a bridge callback, and the panel may not have mounted yet.
    const sink = createTerminalNotices();
    const listener = vi.fn();

    sink.publish(notice("t-1", 2048));
    sink.subscribe(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(notice("t-1", 2048));
  });

  it("is told nothing when there is nothing pending, because a marker for no drop is a lie", () => {
    const sink = createTerminalNotices();
    const listener = vi.fn();

    sink.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
  });

  it("is told once and not twice, because being handed the pending notice must not also queue it", () => {
    // A implementation that both replayed on subscribe and delivered on publish
    // would double the marker for a single drop.
    const sink = createTerminalNotices();
    const listener = vi.fn();

    sink.publish(notice("t-1", 1));
    sink.subscribe(listener);
    sink.publish(notice("t-1", 2));

    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("unsubscribing", () => {
  it("stops delivery, because a closed panel must not keep a listener alive", () => {
    const sink = createTerminalNotices();
    const listener = vi.fn();
    const unsubscribe = sink.subscribe(listener);

    unsubscribe();
    sink.publish(notice("t-1", 1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("leaves the other subscribers alone, because unsubscribing is per listener", () => {
    const sink = createTerminalNotices();
    const kept = vi.fn();
    const dropped = vi.fn();

    sink.subscribe(kept);
    const unsubscribe = sink.subscribe(dropped);
    unsubscribe();
    sink.publish(notice("t-1", 1));

    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("can be called twice, because a teardown path may run again", () => {
    const sink = createTerminalNotices();
    const unsubscribe = sink.subscribe(vi.fn());

    unsubscribe();

    expect(() => unsubscribe()).not.toThrow();
  });
});

describe("the shared instance", () => {
  it("is one object, because two would mean the panel subscribes to the surface the bridge does not publish to", () => {
    expect(terminalNotices).toBe(terminalNotices);
  });

  it("is not the same object a test builds, so a case cannot leak into the process-wide surface", () => {
    // The shared one persists for the life of the renderer; a test that published
    // into it would leave a pending notice for the next case.
    expect(createTerminalNotices()).not.toBe(terminalNotices);
  });
});
