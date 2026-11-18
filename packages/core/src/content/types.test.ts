/**
 * Tests for the content model's shared shapes and pure helpers.
 *
 * The ids and the content key are the only things here a caller can observe
 * before any parser exists, so they get direct coverage: id shape and the
 * ordinal pass-through, keys that survive key reordering and cycles, and the
 * limit normaliser's rejection rules.
 */

import { describe, expect, it } from "vitest";

import {
  blockIdFor,
  contentKey,
  DEFAULT_MAX_IN_FLIGHT_MESSAGES,
  DEFAULT_MAX_TOOLS_PER_MESSAGE,
  makeToolBlockId,
  normalizeLimit,
  reasoningBlockId,
} from "./types.js";

const HEX_KEY = /^[0-9a-f]{8}$/;

describe("blockIdFor", () => {
  it("builds the message-scoped positional shape", () => {
    expect(blockIdFor("msg-1", "text", 0)).toBe("msg-1:text:0");
    expect(blockIdFor("msg-1", "code", 3)).toBe("msg-1:code:3");
    expect(blockIdFor("msg-1", "unknown", 1)).toBe("msg-1:unknown:1");
  });

  it("keeps the message id verbatim, including its own colons", () => {
    expect(blockIdFor("conv:42", "text", 0)).toBe("conv:42:text:0");
  });

  it("passes invalid ordinals through instead of clamping or rounding", () => {
    expect(blockIdFor("m", "text", -1)).toBe("m:text:-1");
    expect(blockIdFor("m", "text", 1.5)).toBe("m:text:1.5");
  });

  it("separates types that share an ordinal", () => {
    expect(blockIdFor("m", "text", 2)).not.toBe(blockIdFor("m", "code", 2));
  });
});

describe("reasoningBlockId", () => {
  it("names the parent message and the segment", () => {
    expect(reasoningBlockId("msg-9", 0)).toBe("msg-9:reasoning:0");
    expect(reasoningBlockId("msg-9", 2)).toBe("msg-9:reasoning:2");
  });

  it("does not collide with a positional text block", () => {
    expect(reasoningBlockId("msg-9", 0)).not.toBe(blockIdFor("msg-9", "text", 0));
  });
});

describe("makeToolBlockId", () => {
  it("uses one namespace for every call", () => {
    expect(makeToolBlockId("call_abc")).toBe("tool:call_abc");
    expect(makeToolBlockId("call_abc")).toBe(makeToolBlockId("call_abc"));
  });

  it("does not collide with a positional block id", () => {
    expect(makeToolBlockId("t")).not.toBe(blockIdFor("t", "tool_call", 0));
  });
});

describe("contentKey", () => {
  it("returns eight lowercase hex characters", () => {
    expect(contentKey({ any: "thing" })).toMatch(HEX_KEY);
  });

  it("is idempotent for the same value", () => {
    const value = { alpha: 1, beta: [true, null, "x"] };

    expect(contentKey(value)).toBe(contentKey(value));
  });

  it("is independent of object key order, at every depth", () => {
    expect(contentKey({ a: 1, b: 2 })).toBe(contentKey({ b: 2, a: 1 }));
    expect(contentKey({ outer: { a: 1, b: { c: 3, d: 4 } } })).toBe(
      contentKey({ outer: { b: { d: 4, c: 3 }, a: 1 } }),
    );
  });

  it("keeps array order significant", () => {
    expect(contentKey([1, 2])).not.toBe(contentKey([2, 1]));
  });

  it("distinguishes values by type and by content", () => {
    expect(contentKey("1")).not.toBe(contentKey(1));
    expect(contentKey(null)).not.toBe(contentKey("null"));
    expect(contentKey({ a: 1 })).not.toBe(contentKey({ a: 2 }));
    expect(contentKey({ a: 1 })).not.toBe(contentKey({ b: 1 }));
  });

  it("keeps an explicit undefined distinct from an absent key", () => {
    expect(contentKey({ a: undefined })).not.toBe(contentKey({}));
  });

  it("gives undefined, functions and symbols stable tokens", () => {
    const fn = () => 1;

    expect(contentKey(undefined)).toBe(contentKey(undefined));
    expect(contentKey(undefined)).not.toBe(contentKey(null));
    expect(contentKey(fn)).toBe(contentKey(fn));
    expect(contentKey(fn)).not.toBe(contentKey(undefined));
    expect(contentKey(fn)).not.toBe(contentKey(Symbol("a")));
    expect(contentKey(Symbol("a"))).toBe(contentKey(Symbol("b")));
  });

  it("gives each non-finite number its own token", () => {
    expect(contentKey(Number.NaN)).toBe(contentKey(Number.NaN));
    expect(contentKey(Number.NaN)).not.toBe(contentKey(Number.POSITIVE_INFINITY));
    expect(contentKey(Number.POSITIVE_INFINITY)).not.toBe(contentKey(Number.NEGATIVE_INFINITY));
    expect(contentKey(Number.POSITIVE_INFINITY)).not.toBe(contentKey(0));
  });

  it("does not throw on a cycle and is stable across isomorphic cycles", () => {
    const first: Record<string, unknown> = { label: "loop" };
    first.self = first;
    const second: Record<string, unknown> = { label: "loop" };
    second.self = second;

    expect(() => contentKey(first)).not.toThrow();
    expect(contentKey(first)).toBe(contentKey(second));
    expect(contentKey(first)).not.toBe(contentKey({ label: "loop" }));
  });

  it("serialises a shared, non-cyclic reference twice without calling it a cycle", () => {
    const shared = { n: 7 };

    expect(() => contentKey({ left: shared, right: shared })).not.toThrow();
    expect(contentKey({ left: shared, right: shared })).toBe(
      contentKey({ left: { n: 7 }, right: { n: 7 } }),
    );
  });
});

describe("normalizeLimit", () => {
  it("keeps positive integers", () => {
    expect(normalizeLimit(1, 256)).toBe(1);
    expect(normalizeLimit(256, 256)).toBe(256);
  });

  it("falls back for zero, negatives, fractions and non-numbers", () => {
    expect(normalizeLimit(0, 256)).toBe(256);
    expect(normalizeLimit(-5, 256)).toBe(256);
    expect(normalizeLimit(1.5, 256)).toBe(256);
    expect(normalizeLimit(Number.NaN, 256)).toBe(256);
    expect(normalizeLimit(Number.POSITIVE_INFINITY, 256)).toBe(256);
  });

  it("falls back when the value is absent and returns the fallback untouched", () => {
    expect(normalizeLimit(undefined, 256)).toBe(256);
    expect(normalizeLimit(undefined, 9)).toBe(9);
  });

  it("defaults both in-flight bounds to 256", () => {
    expect(DEFAULT_MAX_IN_FLIGHT_MESSAGES).toBe(256);
    expect(DEFAULT_MAX_TOOLS_PER_MESSAGE).toBe(256);
  });
});
