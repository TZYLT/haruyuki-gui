/**
 * Tests for the outbound dedupe table.
 *
 * Contract: docs/26 §5.1 `V-9` (bounded at 4096, LRU eviction), §1.2 facts 6 and
 * 8, §6.7 (all three tables must be bounded) and the `D-09` ruling: the caller
 * owns intent, the client owns "this one call is not sent twice", `request_id` is
 * the only interchange, and the engine's `client_message_id` layer must not be
 * copied.
 *
 * Every case names the one deliberate change that turns it red.
 */

import { describe, expect, it } from "vitest";

import { DEDUPE_LIMIT, OutboundDedupe } from "./dedupe";

describe("bounded memory", () => {
  it("never grows past its limit", () => {
    // Red when: the eviction loop is removed, or its bound becomes a comparison
    // that never fires (`>` vs `<`, or `size >= limit` before the insert).
    const table = new OutboundDedupe(8);

    for (let index = 0; index < 100; index += 1) {
      table.claim(`req-${String(index)}`);
    }

    expect(table.size).toBe(8);
    expect(table.capacity).toBe(8);
  });

  it("defaults to the contract's 4096", () => {
    // Red when: the default drifts from the ruled value.
    expect(new OutboundDedupe().capacity).toBe(DEDUPE_LIMIT);
    expect(DEDUPE_LIMIT).toBe(4096);
  });

  it("holds exactly the limit when fed exactly the limit", () => {
    // The off-by-one: a table whose loop fires at `size > limit` must still hold
    // `limit` entries, not `limit - 1`.
    const table = new OutboundDedupe(4);

    for (let index = 0; index < 4; index += 1) {
      table.claim(`req-${String(index)}`);
    }

    expect(table.size).toBe(4);
    for (let index = 0; index < 4; index += 1) {
      expect(table.has(`req-${String(index)}`)).toBe(true);
    }
  });
});

describe("LRU, not FIFO", () => {
  it("evicts the least recently used, not the oldest inserted", () => {
    // Red when: the table uses insertion order without refreshing on a hit. A
    // FIFO table evicts `a`, which is exactly the entry a retry would reuse.
    const table = new OutboundDedupe(3);

    table.claim("a");
    table.claim("b");
    table.claim("c");

    // Touch `a` so it becomes the most recently used, then overflow.
    expect(table.claim("a")).toEqual({ kind: "duplicate" });
    table.claim("d");

    expect(table.has("a"), "a was used most recently and must survive").toBe(true);
    expect(table.has("b"), "b became the least recently used").toBe(false);
    expect(table.has("c")).toBe(true);
    expect(table.has("d")).toBe(true);
  });

  it("keeps a constantly repeated id in the table forever", () => {
    // The failure this guards is subtle: if a hit did not refresh the order, a
    // hot id would age out and its next retry would look like a first send.
    const table = new OutboundDedupe(2);

    table.claim("hot");
    table.claim("cold");

    for (let index = 0; index < 10; index += 1) {
      expect(table.claim("hot")).toEqual({ kind: "duplicate" });
      table.claim(`filler-${String(index)}`);
    }

    expect(table.has("hot")).toBe(true);
  });
});

describe("three verdicts, not a boolean", () => {
  it("reports first then duplicate for the same id", () => {
    // Red when: every claim reports the same verdict.
    const table = new OutboundDedupe();

    expect(table.claim("req-1")).toEqual({ kind: "first" });
    expect(table.claim("req-1")).toEqual({ kind: "duplicate" });
    expect(table.claim("req-1")).toEqual({ kind: "duplicate" });
  });

  it("reports untracked for a command with no request id", () => {
    // Red when: `claim(undefined)` enters the table. The 5 commands whose wire
    // has no request-id field must never be deduplicated - two terminal-input
    // frames carrying `a` are two keystrokes, not one sent twice.
    const table = new OutboundDedupe();

    expect(table.claim(undefined)).toEqual({ kind: "untracked" });
    expect(table.claim(undefined)).toEqual({ kind: "untracked" });
    expect(table.size, "an untracked command takes no slot").toBe(0);
  });

  it("does not let an untracked command consume another id's slot", () => {
    const table = new OutboundDedupe(2);

    table.claim("a");
    table.claim(undefined);
    table.claim(undefined);
    table.claim("b");

    expect(table.size).toBe(2);
    expect(table.has("a")).toBe(true);
    expect(table.has("b")).toBe(true);
  });

  it("treats an empty string as a real id, not as absent", () => {
    // `""` is falsy but it is a value the caller stated. Collapsing it into
    // `undefined` would silently move a command into the untracked class.
    const table = new OutboundDedupe();

    expect(table.claim("")).toEqual({ kind: "first" });
    expect(table.claim("")).toEqual({ kind: "duplicate" });
  });
});

describe("isolation between ids", () => {
  it("does not confuse two different ids", () => {
    const table = new OutboundDedupe();

    table.claim("req-1");
    expect(table.claim("req-2")).toEqual({ kind: "first" });
  });

  it("distinguishes ids that differ only in case or suffix", () => {
    const table = new OutboundDedupe();

    table.claim("req-1");
    expect(table.claim("REQ-1")).toEqual({ kind: "first" });
    expect(table.claim("req-10")).toEqual({ kind: "first" });
  });
});

describe("read-only query", () => {
  it("does not refresh the order when asked whether an id is present", () => {
    // `has` answers a question; it is not a use. If it refreshed, a diagnostic
    // read would silently change which id gets evicted next.
    const table = new OutboundDedupe(3);

    table.claim("a");
    table.claim("b");
    table.claim("c");

    expect(table.has("a")).toBe(true);
    table.claim("d");

    expect(table.has("a"), "a was only read, so it is still the oldest").toBe(false);
  });
});

describe("argument checks", () => {
  it("rejects a limit that is not a positive integer", () => {
    // Red when: the guard is dropped, which turns a 0-capacity table into one
    // that evicts everything it inserts.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new OutboundDedupe(bad), `limit ${String(bad)}`).toThrow(TypeError);
    }
  });
});

describe("clear", () => {
  it("forgets everything, so a fresh session is not judged by the old one", () => {
    const table = new OutboundDedupe();

    table.claim("req-1");
    table.clear();

    expect(table.size).toBe(0);
    expect(table.claim("req-1")).toEqual({ kind: "first" });
  });
});
