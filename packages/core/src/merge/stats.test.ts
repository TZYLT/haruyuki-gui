/**
 * Tests for the bounded statistics tracker.
 *
 * Three properties are checked here and nowhere else: snapshots are copies
 * (a kept snapshot never changes), the unknown-type distribution is bounded
 * and a rebaseline leaves a visible trace.
 */

import { describe, expect, it } from "vitest";

import { createStats } from "./stats.js";

describe("createStats", () => {
  it("counts and snapshots", () => {
    const stats = createStats();

    stats.count("orderedFrames");
    stats.count("duplicates", 3);

    const snapshot = stats.snapshot();

    expect(snapshot.orderedFrames).toBe(1);
    expect(snapshot.duplicates).toBe(3);
    expect(snapshot.resetAt).toBeNull();
    expect(snapshot.resetReason).toBeNull();
  });

  it("returns a copy that later counts cannot change", () => {
    const stats = createStats();
    const before = stats.snapshot();

    stats.count("orderedFrames", 5);

    expect(before.orderedFrames).toBe(0);
    expect(stats.snapshot().orderedFrames).toBe(5);
  });

  it("records a gap range", () => {
    const stats = createStats();

    stats.noteGap(4, 6, 99);

    const snapshot = stats.snapshot();

    expect(snapshot.gaps).toBe(1);
    expect(snapshot.missingFrames).toBe(3);
    expect(snapshot.lastGapAt).toBe(99);
    expect(snapshot.lastGapFrom).toBe(4);
    expect(snapshot.lastGapTo).toBe(6);
  });

  it("keeps the unknown-type distribution bounded and folds overflow", () => {
    const stats = createStats(2);

    stats.noteUnknown("alpha");
    stats.noteUnknown("beta");
    stats.noteUnknown("gamma");
    stats.noteUnknown("alpha");

    const counts = stats.unknownTypeCounts();

    expect(stats.snapshot().unknownTypes).toBe(4);
    expect(counts.get("alpha")).toBe(2);
    expect(counts.get("beta")).toBe(1);
    expect(counts.has("gamma")).toBe(false);
    expect(counts.get("other")).toBe(1);
    expect(counts.size).toBeLessThanOrEqual(3);
  });

  it("marks a reset with its reason", () => {
    const stats = createStats();

    stats.markReset("silent", 1234);

    expect(stats.snapshot().resetAt).toBe(1234);
    expect(stats.snapshot().resetReason).toBe("silent");
  });

  it("records a visible rebaseline", () => {
    const stats = createStats();

    stats.noteRebaseline(77);

    expect(stats.snapshot().rebaselines).toBe(1);
    expect(stats.snapshot().lastRebaselineAt).toBe(77);
  });
});
