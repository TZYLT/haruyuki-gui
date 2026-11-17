/**
 * Tests for gap detection after a replay.
 *
 * Each case is a single fact about the comparison between the cursor and the
 * page that came back, so the suite doubles as the list of what the module is
 * allowed to claim. `detectedAt` is always supplied by the test, never read from
 * a clock: the module has no clock to read.
 */

import { describe, expect, it } from "vitest";

import { detectHistoryGap, streamTruncated } from "./gaps";

const STAMP = "2024-03-01T10:30:00.000Z";

describe("detectHistoryGap", () => {
  it("reports nothing on a first load, because there is no earlier conversation", () => {
    expect(
      detectHistoryGap({
        cursor: null,
        replayed: ["m1", "m2", "m3"],
        hasMore: true,
        detectedAt: STAMP,
      }),
    ).toBeNull();
  });

  it("reports nothing when the page contains the cursor, however much follows it", () => {
    expect(
      detectHistoryGap({
        cursor: "m2",
        replayed: ["m1", "m2", "m3", "m4", "m5"],
        hasMore: false,
        detectedAt: STAMP,
      }),
    ).toBeNull();
  });

  it("reports a history gap from the cursor to the oldest id replayed", () => {
    expect(
      detectHistoryGap({
        cursor: "m2",
        replayed: ["m7", "m8", "m9"],
        hasMore: false,
        detectedAt: STAMP,
      }),
    ).toEqual({
      kind: "history-gap",
      at: "m2",
      // `replayed[0]` is the oldest id, so it is the near end of the hole; the
      // last id would bound a hole the module never observed.
      range: { from: "m2", to: "m7" },
      detectedAt: STAMP,
    });
  });

  it("passes the caller's stamp through unchanged", () => {
    const detectedAt = "2025-12-31T23:59:59.000Z";
    const gap = detectHistoryGap({
      cursor: "m2",
      replayed: ["m9"],
      hasMore: false,
      detectedAt,
    });
    expect(gap?.detectedAt).toBe(detectedAt);
  });

  it("reports nothing for an empty page, which proves no boundary at all", () => {
    // An empty answer may mean "no new messages" or "the engine has nothing";
    // neither tells us where a hole would start or end, so the module refuses to
    // invent the boundary and says nothing happened.
    expect(
      detectHistoryGap({
        cursor: "m2",
        replayed: [],
        hasMore: true,
        detectedAt: STAMP,
      }),
    ).toBeNull();
  });

  it("treats hasMore alone as no gap when the cursor came back", () => {
    // Older messages existing is not the same fact as messages being missing.
    expect(
      detectHistoryGap({
        cursor: "m2",
        replayed: ["m1", "m2"],
        hasMore: true,
        detectedAt: STAMP,
      }),
    ).toBeNull();
  });

  it("is deterministic for the same input", () => {
    const input = {
      cursor: "m2",
      replayed: ["m3"],
      hasMore: true,
      detectedAt: STAMP,
    } as const;
    expect(detectHistoryGap(input)).toEqual(detectHistoryGap(input));
  });
});

describe("streamTruncated", () => {
  it("always reports a null range, because a cut stream has no other end", () => {
    // There is no "to": the answer stopped mid-stream, so a range would claim a
    // boundary that was never observed. `null` is the only honest value.
    expect(streamTruncated("m4", STAMP)).toEqual({
      kind: "stream-truncated",
      at: "m4",
      range: null,
      detectedAt: STAMP,
    });
    expect(streamTruncated("m4", STAMP).range).toBeNull();
  });

  it("keeps a null position when the caller does not know where it stopped", () => {
    expect(streamTruncated(null, STAMP)).toEqual({
      kind: "stream-truncated",
      at: null,
      range: null,
      detectedAt: STAMP,
    });
  });
});
