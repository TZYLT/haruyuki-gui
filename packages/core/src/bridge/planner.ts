/**
 * planner.ts - how one bulk frame becomes the pages that go on the wire.
 *
 * Why this is its own module
 *   It was the bulk half of `sender.ts`, and `sender.ts` was at 973 of the 1000
 *   lines a new file may not exceed. The split is not cosmetic: this half is a
 *   pure function from "one snapshot plus a budget" to "the pages to emit", it
 *   owns no queue, no timer and no sequence number, and it is the only place
 *   that knows what a page costs. `sender.ts` keeps the policy around it --
 *   numbering, staging, pumping -- and asks this module where a page ends.
 *
 * The budget covers the whole frame, not just the items
 *   `page.ts` measures `JSON.stringify(page.items)`, which is the right unit for
 *   a pager that knows nothing about envelopes. It is the wrong unit for the
 *   contract, which says a `bulk` page must be at most 1 MB *on the wire*. The
 *   difference is not academic: a page repeats the snapshot-level body fields on
 *   every one of its pages, and the envelope adds `v`, `ch`, `seq`, `t` and the
 *   cursor. A perfectly legal 1 MB slice of items therefore produced a frame well
 *   over the cap, and nothing measured the value that actually crossed the
 *   boundary.
 *
 *   So this module budgets the frame. The fixed part (everything except the
 *   items) is serialized once per snapshot and charged to every page; each item
 *   is then charged its own serialized size plus one separator byte. That is
 *   still one pass and still exact for `JSON.stringify`, because a JSON array's
 *   size is exactly brackets + separator-per-gap + the members.
 *
 * Page count first, pages second
 *   The caller has to know how many emissions a snapshot will produce *before*
 *   it can decide whether the unit fits its backlog. Materializing four thousand
 *   page objects to answer that question costs hundreds of megabytes and seconds
 *   for an answer that a walk of the items gives in milliseconds, so counting and
 *   building are separate calls. Both are pure.
 */

import type { Frame } from "@haruyuki/protocol";

import { BULK_OVER_LIMIT, DEFAULT_PAGE_BUDGET_BYTES } from "./page";

/**
 * The error code for a snapshot no page sequence can carry.
 *
 * Re-exported so this module's refusal is the same literal the contract names,
 * without the caller importing two modules to catch one failure.
 */
export { BULK_OVER_LIMIT };

/** Bytes of `[]`, i.e. the size of an array with no members. */
const EMPTY_ARRAY_BYTES = 2;

/** Bytes of the separator between two array members. */
const SEPARATOR_BYTES = 1;

/**
 * Bytes reserved for the envelope fields that surround every page.
 *
 * The sequence number is the only envelope field whose width varies, and it is
 * bounded by `Number.MAX_SAFE_INTEGER`'s 16 characters. Reserving the widest
 * possible value keeps the measurement an upper bound rather than an estimate
 * that a long-running process eventually outgrows.
 */
const MAX_SEQ_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

/** Everything a page's framing costs before any item is written. */
const FRAMING_BYTES = 128;

/**
 * One page to emit: its body and its `more` flag.
 *
 * Deliberately not the wire value: the sequence number does not exist yet at
 * planning time, and assigning one to a page that is later refused would spend
 * numbers on frames nobody sends.
 */
export interface PlannedPage {
  /** The page body: the snapshot's other fields plus this page's items. */
  readonly body: unknown;
  /** `true` when at least one item follows this page. */
  readonly more: boolean;
}

/** A caller-supplied snapshot cursor, with unusable halves widened to `null`. */
export interface SnapshotCursor {
  readonly watermark: number | null;
  readonly token: string | null;
}

/** The planner's view of one bulk frame, before any page exists. */
export interface BulkPlan {
  /** The pages to emit, in snapshot order; never empty. */
  readonly pages: readonly PlannedPage[];
  /** The cursor the caller supplied, when it supplied a usable one. */
  readonly cursor: SnapshotCursor | null;
}

/** The pure half of sending a snapshot. */
export interface BulkPlanner {
  /**
   * How many pages this frame will produce.
   *
   * Cheap: walks the items to measure them and never builds a page body, so a
   * caller can refuse an oversized unit before paying for it.
   *
   * @param frame a frame already known to be on the bulk channel
   * @returns the page count, at least 1
   * @throws {BulkOverLimitError} when one item cannot fit a page on its own
   */
  countPages(frame: Frame): number;

  /**
   * Split the frame into the pages to emit.
   *
   * @param frame a frame already known to be on the bulk channel
   * @returns the pages and the cursor
   * @throws {BulkOverLimitError} when one item cannot fit a page on its own
   */
  plan(frame: Frame): BulkPlan;
}

/**
 * Thrown when a single item is larger than a whole page.
 *
 * `code` is the contract's literal; `offset` names the item and `budget` the
 * limit it broke, so a caller can act without parsing the message.
 */
export class BulkOverLimitError extends Error {
  /** Branch on this rather than on `message`. */
  readonly code: typeof BULK_OVER_LIMIT = BULK_OVER_LIMIT;

  /** Index of the first item that did not fit a page on its own. */
  readonly offset: number;

  /** The page budget that was applied, in bytes. */
  readonly budget: number;

  /**
   * @param offset index of the offending item
   * @param budget the page budget in bytes
   */
  constructor(offset: number, budget: number) {
    super(
      `BULK_OVER_LIMIT: the item at offset ${String(offset)} does not fit a page of ` +
        `${String(budget)} bytes even on its own, so no page sequence can cover this snapshot; ` +
        "split that item before sending it as a bulk page",
    );
    this.name = "BulkOverLimitError";
    this.offset = offset;
    this.budget = budget;
  }
}

/** One encoder for the process: constructing a `TextEncoder` per item is waste. */
const UTF8 = new TextEncoder();

/**
 * UTF-8 byte length of one serialised value.
 *
 * `JSON.stringify` returns `undefined` for a value the JSON grammar cannot
 * represent, and an array renders such a value as `null`; both are charged four
 * bytes so the total matches the array that would actually be sent.
 *
 * @param value one snapshot item
 * @returns the bytes this value occupies inside a serialised array
 */
function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);

  return json === undefined ? 4 : UTF8.encode(json).byteLength;
}

/**
 * Read the list of items a bulk body offers for paging.
 *
 * Two shapes are accepted: the body IS the array, or the body carries an
 * `items` array. Anything else has nothing to split and is delivered whole.
 *
 * @param body the caller's bulk body
 * @returns the items, or `null` when this body is not a list
 */
function readPageItems(body: unknown): readonly unknown[] | null {
  if (Array.isArray(body)) {
    return body;
  }

  if (body === null || typeof body !== "object") {
    return null;
  }

  const items = (body as Record<string, unknown>)["items"];

  return Array.isArray(items) ? items : null;
}

/**
 * Read the cursor a caller put on a bulk frame.
 *
 * A caller-supplied watermark and token are optional here: an unusable half is
 * widened to `null` and replaced at emission time. A watermark is only kept when
 * it is a non-negative safe integer, because the renderer's stale-page rule
 * compares watermarks monotonically: a fractional or negative value would either
 * be silently dropped by the peer or poison every later comparison, and neither
 * is a state a producer should be able to reach by typo.
 *
 * @param frame the caller's frame
 * @returns the readable halves, or `null` when the frame carries no cursor
 */
export function readCursor(frame: Frame): SnapshotCursor | null {
  const candidate = (frame as Frame & { readonly page?: unknown }).page;

  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const record = candidate as Record<string, unknown>;
  const watermark = record["watermark"];
  const token = record["token"];

  return {
    watermark:
      typeof watermark === "number" && Number.isSafeInteger(watermark) && watermark >= 0
        ? watermark
        : null,
    token: typeof token === "string" && token.length > 0 ? token : null,
  };
}

/**
 * Build one page's body.
 *
 * Snapshot-level fields are repeated on every page so a page can be read on its
 * own -- a page is independently resumable, and a page that refers to fields it
 * does not carry is not. `page` and `items` are the two keys this layer owns, so
 * the caller's versions of them are replaced rather than inherited.
 *
 * The copy is built with `Object.defineProperty` rather than assignment for one
 * reason: a body that arrived through `JSON.parse` can carry an own `__proto__`
 * key, and `body[key] = value` with that name sets the prototype instead of
 * creating a field. The field would then vanish from the page -- a silent data
 * loss in the one layer whose job is to not have any.
 *
 * @param original the caller's body
 * @param items this page's slice
 * @param page the 1-based page number
 * @returns the body to put on the wire
 */
function pageBody(
  original: unknown,
  items: readonly unknown[],
  page: number,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (!Array.isArray(original) && original !== null && typeof original === "object") {
    const record = original as Record<string, unknown>;

    for (const key of Object.keys(record)) {
      if (key !== "items" && key !== "page") {
        Object.defineProperty(body, key, {
          value: record[key],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }

  body["page"] = page;
  body["items"] = items;

  return body;
}

/**
 * Create the planner for one page budget.
 *
 * @param budgetBytes maximum wire bytes of one `bulk` frame;
 *   defaults to {@link DEFAULT_PAGE_BUDGET_BYTES}
 * @returns a planner that never mutates its argument and keeps no state
 * @throws RangeError when the budget is not a positive safe integer
 */
export function createBulkPlanner(budgetBytes: number = DEFAULT_PAGE_BUDGET_BYTES): BulkPlanner {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
    throw new RangeError(
      `invalid page budget: ${String(budgetBytes)}; a page budget must be a positive safe ` +
        "integer number of bytes, because 0 and negative sizes cannot hold a page",
    );
  }

  const budget = budgetBytes;

  /**
   * The wire bytes a page spends before its first item.
   *
   * Measured once per snapshot by serializing the real framing with an empty
   * item list, so every field the caller put in the body is charged exactly
   * once -- including the ones this layer copies onto every page.
   *
   * @param frame the caller's frame
   * @param cursor the cursor the page will carry
   * @returns the fixed cost of one page, in bytes
   */
  function framingBytes(frame: Frame, cursor: SnapshotCursor | null): number {
    const probe = {
      v: frame.v,
      ch: frame.ch,
      seq: 0,
      t: frame.t,
      body: pageBody(frame.body, [], 1),
      page: {
        watermark: cursor === null || cursor.watermark === null ? 0 : cursor.watermark,
        token: cursor === null || cursor.token === null ? "" : cursor.token,
        more: false,
      },
    };

    // The probe writes `seq: 0`; reserve the widest one instead, so the bound
    // holds for the whole life of the process rather than the first few frames.
    return jsonBytes(probe) + (MAX_SEQ_DIGITS - 1) + FRAMING_BYTES;
  }

  /**
   * Walk the items and report where each page ends, without building bodies.
   *
   * @param frame the caller's frame
   * @returns one entry per page: how many items it holds and whether more follow
   * @throws {BulkOverLimitError} when an item does not fit a page on its own
   */
  function boundaries(frame: Frame): { count: number; more: boolean }[] {
    const items = readPageItems(frame.body);

    if (items === null) {
      return [{ count: 0, more: false }];
    }

    if (items.length === 0) {
      return [{ count: 0, more: false }];
    }

    const overhead = framingBytes(frame, readCursor(frame));
    const result: { count: number; more: boolean }[] = [];

    let offset = 0;

    while (offset < items.length) {
      let count = 0;
      let bodyBytes = EMPTY_ARRAY_BYTES;

      for (let index = offset; index < items.length; index += 1) {
        const size = jsonBytes(items[index]);

        // The candidate page is `overhead + brackets + members + separators`.
        // One separator per gap, which is `count` once a member is present.
        const candidate = overhead + bodyBytes + size + (count === 0 ? 0 : SEPARATOR_BYTES);

        if (candidate > budget) {
          break;
        }

        bodyBytes += size + (count === 0 ? 0 : SEPARATOR_BYTES);
        count += 1;
      }

      if (count === 0) {
        // The pager's only empty-with-more answer: the item at `offset` does not
        // fit a page on its own, so no page sequence covers this snapshot.
        throw new BulkOverLimitError(offset, budget);
      }

      offset += count;
      result.push({ count, more: offset < items.length });
    }

    return result;
  }

  return {
    countPages(frame: Frame): number {
      return boundaries(frame).length;
    },

    plan(frame: Frame): BulkPlan {
      const items = readPageItems(frame.body);
      const cursor = readCursor(frame);

      if (items === null) {
        // Nothing to page: deliver the body as it stands, in one frame.
        return { pages: [{ body: frame.body, more: false }], cursor };
      }

      // One walk, then slice. Calling `boundaries` per page would re-measure the
      // whole snapshot once per page.
      const pages: PlannedPage[] = [];
      let start = 0;
      let index = 0;

      for (const boundary of boundaries(frame)) {
        pages.push({
          body: pageBody(frame.body, items.slice(start, start + boundary.count), index + 1),
          more: boundary.more,
        });

        start += boundary.count;
        index += 1;
      }

      return { pages, cursor };
    },
  };
}
