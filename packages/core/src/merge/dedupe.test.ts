/**
 * Tests for the bounded membership table.
 *
 * The interesting property is not "does it remember an id" but "what does it
 * forget, and when". So the cases pin the eviction order: a repeated add does
 * not grow the table, a hit is refreshed to most recently used, the least
 * recently used id is the one evicted, and `clear` empties it completely. The
 * default bound is checked too, because the table's whole reason to exist is
 * that an endless stream must not grow it forever.
 */

import { describe, expect, it } from "vitest";

import { createDedupe } from "./dedupe.js";

describe("createDedupe", () => {
  it("reports membership and counts distinct ids", () => {
    const dedupe = createDedupe(8);

    expect(dedupe.size()).toBe(0);
    expect(dedupe.seen("a")).toBe(false);

    dedupe.add("a");
    dedupe.add("b");
    dedupe.add("a");

    expect(dedupe.size()).toBe(2);
    expect(dedupe.seen("a")).toBe(true);
    expect(dedupe.seen("b")).toBe(true);
  });

  it("refreshes a hit so the hot id is not the one evicted", () => {
    const dedupe = createDedupe(2);

    dedupe.add("a");
    dedupe.add("b");

    // Reading `a` makes `b` the least recently used id, so `c` must evict `b`.
    expect(dedupe.seen("a")).toBe(true);

    dedupe.add("c");

    expect(dedupe.size()).toBe(2);
    expect(dedupe.seen("b")).toBe(false);
    expect(dedupe.seen("a")).toBe(true);
    expect(dedupe.seen("c")).toBe(true);
  });

  it("evicts the oldest id once the limit is passed", () => {
    const dedupe = createDedupe(2);

    dedupe.add("a");
    dedupe.add("b");
    dedupe.add("c");

    expect(dedupe.size()).toBe(2);
    expect(dedupe.seen("a")).toBe(false);
    expect(dedupe.seen("b")).toBe(true);
    expect(dedupe.seen("c")).toBe(true);
  });

  it("does not grow when the same id is added again", () => {
    const dedupe = createDedupe(2);

    dedupe.add("a");
    dedupe.add("a");
    dedupe.add("a");

    expect(dedupe.size()).toBe(1);
    expect(dedupe.seen("a")).toBe(true);
  });

  it("forgets everything on clear", () => {
    const dedupe = createDedupe(4);

    dedupe.add("a");
    dedupe.add("b");
    dedupe.clear();

    expect(dedupe.size()).toBe(0);
    expect(dedupe.seen("a")).toBe(false);

    dedupe.add("c");

    expect(dedupe.size()).toBe(1);
    expect(dedupe.seen("c")).toBe(true);
  });

  it("defaults to a fixed bound so an endless stream stays bounded", () => {
    const dedupe = createDedupe();

    for (let index = 0; index <= 4096; index += 1) {
      dedupe.add(`id-${index}`);
    }

    expect(dedupe.size()).toBe(4096);
    expect(dedupe.seen("id-0")).toBe(false);
    expect(dedupe.seen("id-4096")).toBe(true);
  });
});
