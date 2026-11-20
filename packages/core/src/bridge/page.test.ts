/**
 * Tests for the bulk pager.
 *
 * The cases below are grouped around the four claims the implementation makes,
 * because each of them is a place where a "reasonable" pager would be wrong:
 *
 *   1. BYTES ARE EXACT. `PageResult.bytes` is compared against
 *      `Buffer.byteLength(JSON.stringify(page.items))` -- never against
 *      `String#length`, which counts UTF-16 code units and therefore disagrees
 *      with the wire for any non-ASCII text.
 *   2. ONE PASS FILLS THE PAGE. After a page, both sides of the boundary hold:
 *      the page fits, and the page plus its next item does not. A halving
 *      strategy fails the second half of that pair by underfilling.
 *   3. AN OVERSIZED ITEM IS AN EMPTY PAGE, NOT AN EXCEPTION. `items: []` with
 *      `more: true` is the pager's whole answer for "this one item cannot be
 *      paged", and the matching call at `offset + 1` still makes progress.
 *   4. PAGES TILE THE SNAPSHOT. Walking a snapshot page by page yields every
 *      item exactly once, in order, and finishes.
 */

import { describe, expect, it } from "vitest";

import type { BulkFrame } from "@haruyuki/protocol";

import {
  BULK_OVER_LIMIT,
  DEFAULT_PAGE_BUDGET_BYTES,
  createPager,
  type PageResult,
  type Pager,
} from "./page";

/**
 * The frame cursor's `more` field, taken from the protocol package rather than
 * restated here. A page's `more` is what a `bulk.page` frame publishes, so the
 * two must stay assignable to each other; the check runs at compile time and
 * costs nothing at run time.
 */
type CursorMore = BulkFrame["page"]["more"];

/**
 * The empty page's byte count, spelled out here rather than imported: the test
 * should fail if the implementation changes what it reports for a page that
 * consumed nothing.
 */
const EMPTY_BYTES = 2;

/** The byte length the wire will carry: UTF-8 bytes, not UTF-16 code units. */
function wireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Exact byte length of one page as `PageResult.bytes` promises to report it. */
function pageBytes<T>(page: PageResult<T>): number {
  return wireBytes(page.items);
}

/** Drain a snapshot through a pager, returning every page in order. */
function drainAll<T>(pager: Pager, items: readonly T[]): PageResult<T>[] {
  const pages: PageResult<T>[] = [];
  let offset = 0;

  // Bounded on purpose: a pager that stops making progress would otherwise make
  // a broken implementation hang the suite instead of failing it.
  for (let guard = 0; guard <= items.length + 1; guard += 1) {
    const page = pager.paginate(items, offset);
    pages.push(page);

    if (!page.more) {
      return pages;
    }

    // An empty page with `more` is legal (an oversized item), so the loop must
    // advance past it explicitly; that is what the caller does in production.
    offset += Math.max(page.items.length, 1);
  }

  throw new Error("pager did not terminate");
}

describe("BULK_OVER_LIMIT", () => {
  it("is the frozen contract's literal", () => {
    expect(BULK_OVER_LIMIT).toBe("BULK_OVER_LIMIT");
  });

  it("defaults the budget to one megabyte", () => {
    expect(DEFAULT_PAGE_BUDGET_BYTES).toBe(1024 * 1024);
  });

  it("publishes a `more` a bulk frame's cursor accepts", () => {
    const page = createPager(8).paginate(["aaaa", "bbbb"], 0);
    const cursorMore: CursorMore = page.more;

    // `cursorMore` is a compile-time proof that `more` is a boolean. Asserting
    // `cursorMore === page.more` proved nothing beyond that -- the two are the
    // same value by construction, so the case could not fail. What is worth
    // pinning is the runtime side a cursor actually carries.
    expect(typeof cursorMore).toBe("boolean");
    expect(page.more).toBe(true);

    // The last page must say `false`, or a consumer waits for a page that will
    // never come.
    const last = createPager(8).paginate(["aaaa"], 0);

    expect(last.more as CursorMore).toBe(false);
  });
});

describe("createPager: empty and exhausted snapshots", () => {
  it("returns an empty page for an empty array", () => {
    const page = createPager().paginate([], 0);

    expect(page.items).toEqual([]);
    expect(page.bytes).toBe(wireBytes([]));
    expect(page.bytes).toBe(2);
    expect(page.more).toBe(false);
  });

  it("reports an exhausted snapshot at the exact end", () => {
    const items = ["a", "b"];
    const page = createPager().paginate(items, 2);

    expect(page.items).toEqual([]);
    expect(page.bytes).toBe(2);
    expect(page.more).toBe(false);
  });

  it("reports an exhausted snapshot past the end", () => {
    const page = createPager().paginate([1, 2, 3], 99);

    expect(page.items).toEqual([]);
    expect(page.more).toBe(false);
    expect(page.bytes).toBe(wireBytes([]));
  });
});

describe("createPager: a single page", () => {
  it("holds every item when the budget is generous", () => {
    const items = [1, 2, 3, 4, 5];
    const page = createPager(1024).paginate(items, 0);

    expect(page.items).toEqual(items);
    expect(page.more).toBe(false);
    expect(page.bytes).toBe(wireBytes(items));
  });

  it("does not mutate the snapshot and returns a fresh array", () => {
    const items = ["a", "b", "c"];
    const page = createPager(1024).paginate(items, 0);

    page.items.push("d");

    expect(items).toEqual(["a", "b", "c"]);
    expect(page.items).not.toBe(items);
  });

  it("is pure: two identical calls agree", () => {
    const pager = createPager(32);
    const items = ["alpha", "beta", "gamma", "delta"];

    expect(pager.paginate(items, 0)).toEqual(pager.paginate(items, 0));
    expect(pager.paginate(items, 1)).toEqual(pager.paginate(items, 1));
  });
});

describe("createPager: both sides of the page boundary", () => {
  // 1000 items of 2009 chars each: a 1 MB page holds 521 of them and the 522nd
  // would overflow. 521, not the 500 that "overflow then halve" produces -- the
  // underfill that motivated the one-pass scan.
  const items = Array.from({ length: 1000 }, () => "x".repeat(2009));
  const budget = DEFAULT_PAGE_BUDGET_BYTES;

  it("fills the page as far as it can go", () => {
    const page = createPager().paginate(items, 0);

    expect(page.items.length).toBe(521);
    expect(page.bytes).toBe(wireBytes(page.items));
  });

  it("asserts the page fits the budget", () => {
    const page = createPager().paginate(items, 0);

    expect(page.bytes).toBeLessThanOrEqual(budget);
    expect(page.bytes).toBe(pageBytes(page));
  });

  it("asserts one more item would overflow the budget", () => {
    const page = createPager().paginate(items, 0);
    const withNext = wireBytes(items.slice(0, page.items.length + 1));

    expect(withNext).toBeGreaterThan(budget);
    // The one-pass fill is maximal, so a halving strategy's 500 is not enough.
    expect(page.items.length).toBeGreaterThan(items.length / 2);
  });

  it("resumes exactly at the item that overflowed", () => {
    const pager = createPager();
    const first = pager.paginate(items, 0);
    const second = pager.paginate(items, first.items.length);

    expect(second.items[0]).toBe(items[first.items.length]);
    expect(second.bytes).toBeLessThanOrEqual(budget);
    // The remainder is smaller than a full page, so the second page finishes
    // the snapshot -- the overflow item is its head and nothing is skipped.
    expect(second.items.length).toBe(items.length - first.items.length);
    expect(second.more).toBe(false);
  });

  it("fits exactly when the budget equals the page size", () => {
    const exact = ["aaa", "bbb", "ccc"];
    const exactBytes = wireBytes(exact);
    const pager = createPager(exactBytes);
    const page = pager.paginate(exact, 0);

    expect(page.items).toEqual(exact);
    expect(page.bytes).toBe(exactBytes);
    expect(page.more).toBe(false);
  });

  it("drops the last item when the budget is one byte short", () => {
    const exact = ["aaa", "bbb", "ccc"];
    const pager = createPager(wireBytes(exact) - 1);
    const page = pager.paginate(exact, 0);

    expect(page.items).toEqual(["aaa", "bbb"]);
    expect(page.bytes).toBe(wireBytes(["aaa", "bbb"]));
    expect(page.more).toBe(true);
  });

  it("accepts a budget too small to hold even the brackets", () => {
    // 1 byte cannot hold "[]" (2 bytes), so nothing ever fits. The answer is an
    // empty page with `more: true`, not a throw: the pager is honest about it.
    const page = createPager(1).paginate(["a"], 0);

    expect(page.items).toEqual([]);
    expect(page.bytes).toBe(EMPTY_BYTES);
    expect(page.more).toBe(true);
  });
});

describe("createPager: multiple pages tile the snapshot", () => {
  it("drains every item exactly once, in order", () => {
    const items = Array.from({ length: 250 }, (_, index) => ({
      id: index,
      label: `item-${index}`,
    }));
    const pages = drainAll(createPager(600), items);
    const collected = pages.flatMap((page) => page.items);

    expect(collected.length).toBe(items.length);
    expect(collected).toEqual(items);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("keeps every page within the budget, except an oversized item", () => {
    const items = Array.from({ length: 120 }, (_, index) => `record-${index}`);
    const budget = 128;
    const pages = drainAll(createPager(budget), items);

    for (const page of pages) {
      if (page.items.length === 0) {
        continue;
      }

      expect(page.bytes).toBeLessThanOrEqual(budget);
      expect(page.bytes).toBe(pageBytes(page));
    }
  });

  it("sets more=false on the final page only", () => {
    const items = Array.from({ length: 40 }, (_, index) => `v${index}`);
    const pages = drainAll(createPager(48), items);

    pages.forEach((page, index) => {
      expect(page.more).toBe(index < pages.length - 1);
    });
  });

  it("reports more=true for a page that ends before the snapshot does", () => {
    const page = createPager(16).paginate(["aaaa", "bbbb", "cccc"], 0);

    expect(page.items).toEqual(["aaaa", "bbbb"]);
    expect(page.more).toBe(true);
  });
});

describe("createPager: an item larger than the budget", () => {
  // 2 MB of text against the 1 MB default budget: no page can ever hold it.
  const oversized = "y".repeat(2 * 1024 * 1024);

  it("returns an empty page with more=true instead of throwing", () => {
    const pager = createPager();
    const page = pager.paginate(["small", oversized, "small-again"], 1);

    expect(page.items).toEqual([]);
    expect(page.bytes).toBe(2);
    expect(page.more).toBe(true);
    expect(() => pager.paginate([oversized], 0)).not.toThrow();
  });

  it("keeps the item at offset untouched, so the caller can special-case it", () => {
    const items = [oversized];
    const page = createPager().paginate(items, 0);

    expect(items[0]).toBe(oversized);
    expect(wireBytes([items[0]])).toBeGreaterThan(DEFAULT_PAGE_BUDGET_BYTES);
  });

  it("makes progress when the caller advances past the oversized item", () => {
    const items = ["first", oversized, "last"];
    const pager = createPager();
    const blocked = pager.paginate(items, 1);

    expect(blocked.items).toEqual([]);

    const next = pager.paginate(items, 2);
    expect(next.items).toEqual(["last"]);
    expect(next.more).toBe(false);
  });

  it("drains a snapshot that contains an oversized item without looping", () => {
    const items = ["a", oversized, "b"];
    const pages = drainAll(createPager(), items);

    expect(pages.length).toBe(3);
    expect(pages.map((page) => page.items.length)).toEqual([1, 0, 1]);
    expect(pages.flatMap((page) => page.items)).toEqual(["a", "b"]);
    expect(pages[2]?.more).toBe(false);
  });

  it("treats an item exactly at the budget as fitting", () => {
    // A one-item page costs 2 brackets + item bytes, so an item of
    // `budget - 2` bytes is the largest that fits on its own.
    const payload = "z".repeat(98);
    const itemBytes = wireBytes([payload]);
    const page = createPager(itemBytes).paginate([payload], 0);

    expect(page.bytes).toBe(itemBytes);
    expect(page.items).toEqual([payload]);
    expect(page.more).toBe(false);
  });
});

describe("createPager: bytes match JSON.stringify exactly", () => {
  const samples: readonly { name: string; value: readonly unknown[] }[] = [
    { name: "empty array", value: [] },
    { name: "pure ASCII", value: ["alpha", "beta", "gamma"] },
    {
      name: "escapes",
      value: ['quote " backslash \\ slash/', "tab\tnul\u0000"],
    },
    {
      name: "multi-byte text",
      value: ["\u4e2d\u6587", "\u65e5\u672c\u8a9e", "emoji \u{1f600}"],
    },
    { name: "newlines", value: ["line\r\nbreak", "lf\nonly", "cr\ronly"] },
    { name: "numbers and nulls", value: [0, -1, 3.5, true, false, null] },
    {
      name: "objects",
      value: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    },
    { name: "values without a JSON form", value: [undefined, null] },
  ];

  for (const sample of samples) {
    it(`reports the exact size for ${sample.name}`, () => {
      const pager = createPager(DEFAULT_PAGE_BUDGET_BYTES);
      const page = pager.paginate(sample.value, 0);
      const encoded = new TextEncoder().encode(JSON.stringify(sample.value));

      expect(page.items).toEqual(sample.value);
      expect(page.bytes).toBe(Buffer.byteLength(JSON.stringify(sample.value), "utf8"));
      // The independent check: a full UTF-8 encode, not `String#length`.
      expect(page.bytes).toBe(encoded.byteLength);
      expect(page.more).toBe(false);
    });
  }

  it("differs from String#length for multi-byte text", () => {
    const items = ["\u4e2d\u6587"];
    const page = createPager(DEFAULT_PAGE_BUDGET_BYTES).paginate(items, 0);

    // Three code points, six UTF-8 bytes, so a `.length`-based pager would
    // under-count by four bytes here and overfill real pages.
    expect(JSON.stringify(items).length).not.toBe(page.bytes);
    expect(page.bytes).toBe(wireBytes(items));
  });

  it("reports the escaped size, not the source size", () => {
    const items = ["\u0000\u0001\u001f"];
    const page = createPager(DEFAULT_PAGE_BUDGET_BYTES).paginate(items, 0);

    expect(JSON.stringify(items).length).toBe(page.bytes);
    expect(encodeURIComponent(JSON.stringify(items)).length).toBeGreaterThan(page.bytes);
  });

  it("counts one separator byte between items", () => {
    const single = createPager(1024).paginate(["ab"], 0);
    const pair = createPager(1024).paginate(["ab", "cd"], 0);

    // Growing a page from one item to two adds the second item plus exactly one
    // comma; the brackets are already counted, so they are removed again here.
    expect(pair.bytes - single.bytes).toBe(wireBytes(["cd"]) - EMPTY_BYTES + 1);
  });

  it("reports the exact size of a page read from the middle", () => {
    const items = ["\u4e2d", "abc", "\u{1f600}x", "tail", "more"];
    const page = createPager(1024).paginate(items, 2);

    expect(page.items).toEqual(["\u{1f600}x", "tail", "more"]);
    expect(page.bytes).toBe(wireBytes(page.items));
  });
});

describe("createPager: invalid budgets", () => {
  const invalid: readonly { name: string; budget: number }[] = [
    { name: "zero", budget: 0 },
    { name: "negative", budget: -1 },
    { name: "fractional", budget: 1.5 },
    { name: "NaN", budget: Number.NaN },
    { name: "Infinity", budget: Number.POSITIVE_INFINITY },
    { name: "unsafe integer", budget: Number.MAX_SAFE_INTEGER + 2 },
  ];

  for (const sample of invalid) {
    it(`rejects a ${sample.name} budget with RangeError`, () => {
      expect(() => createPager(sample.budget)).toThrow(RangeError);
    });
  }

  it("names the offending budget in the message", () => {
    expect(() => createPager(0)).toThrow(/invalid page budget: 0/);
    expect(() => createPager(-12)).toThrow(/invalid page budget: -12/);
  });
});

describe("createPager: invalid offsets", () => {
  it("rejects a negative offset", () => {
    expect(() => createPager().paginate(["a"], -1)).toThrow(RangeError);
  });

  it("rejects a fractional offset", () => {
    expect(() => createPager().paginate(["a"], 0.5)).toThrow(RangeError);
  });

  it("rejects a non-finite offset", () => {
    expect(() => createPager().paginate(["a"], Number.NaN)).toThrow(RangeError);
    expect(() => createPager().paginate(["a"], Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
