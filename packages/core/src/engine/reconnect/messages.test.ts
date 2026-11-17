/**
 * Tests for the history pager.
 *
 * The pager is thin on purpose, so every case pins one sentence of its contract:
 * how often the engine is asked, which limit wins, what a cursor means, what
 * counts as "there is more", and which failures are values. Nothing is mocked
 * beyond the injected fetch, because that fetch is the module's whole world.
 */

import { describe, expect, it, vi } from "vitest";

import type { MessagePage, MessagePager, PageFetcher, PageResult } from "./controller";
import { createPager } from "./messages";

/** The argument bag `page` takes, read off the contract so the two cannot drift. */
type PageCall = Parameters<MessagePager["page"]>[0];

/** The newest page of one conversation; most cases vary a single field of this. */
const NEWEST: PageCall = { agentId: "agent-1", conversationId: "conv-1", before: null };

/** A page that claims both more history and somewhere to continue from. */
const PAGE: MessagePage = {
  messages: [
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
  ],
  nextBefore: "cursor-2",
  hasMore: true,
};

/** A pager over a stub fetch that always answers `answer`; the mock stays visible. */
function pagerFor(answer: PageResult = { ok: true, page: PAGE }, limit?: number) {
  const spy = vi.fn<PageFetcher>(async () => answer);
  // Omitted rather than passed as `undefined`: optional means absent here.
  const options = limit === undefined ? { fetch: spy } : { fetch: spy, limit };
  return { pager: createPager(options), spy };
}

describe("page", () => {
  it("asks the engine once per call and hands the answer back untouched", async () => {
    const answer: PageResult = { ok: true, page: PAGE };
    const { pager, spy } = pagerFor(answer);

    const result = await pager.page(NEWEST);

    expect(spy).toHaveBeenCalledTimes(1);
    // Same result object, same page object, same `messages` array and order: the
    // caller may treat this as the engine's own answer, not a copy of it.
    expect(result).toBe(answer);
    if (!result.ok) throw new Error("expected a successful page");
    expect(result.page).toBe(PAGE);
    expect(result.page.messages).toBe(PAGE.messages);
  });

  it("never asks for a second page on its own when the answer says there is more", async () => {
    const { pager, spy } = pagerFor();

    await pager.page(NEWEST);

    expect(PAGE.hasMore).toBe(true);
    expect(PAGE.nextBefore).not.toBeNull();
    // One page is one request. How many are worth fetching is the caller's call.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sends exactly the fields the contract names, nothing more", async () => {
    const { pager, spy } = pagerFor();

    await pager.page({ ...NEWEST, limit: 7 });

    expect(spy.mock.calls[0]?.[0]).toEqual({
      agentId: "agent-1",
      conversationId: "conv-1",
      before: null,
      limit: 7,
    });
  });
});

describe("limit resolution", () => {
  it("uses the configured limit, or 50 when nothing was configured", async () => {
    const configured = pagerFor(undefined, 20);
    await configured.pager.page(NEWEST);
    expect(configured.spy.mock.calls[0]?.[0].limit).toBe(20);

    const unconfigured = pagerFor();
    await unconfigured.pager.page(NEWEST);
    expect(unconfigured.spy.mock.calls[0]?.[0].limit).toBe(50);
  });

  it("lets the per-call limit win over the configured one", async () => {
    const { pager, spy } = pagerFor(undefined, 20);

    await pager.page({ ...NEWEST, limit: 3 });

    expect(spy.mock.calls[0]?.[0].limit).toBe(3);
  });

  it("validates the resolved limit, so a per-call limit rescues an unusable default", async () => {
    const silent = pagerFor(undefined, 0);
    expect((await silent.pager.page(NEWEST)).ok).toBe(false);
    expect(silent.spy).not.toHaveBeenCalled();

    // The narrower scope said something usable, so the broken default never runs.
    const overridden = pagerFor(undefined, 0);
    await overridden.pager.page({ ...NEWEST, limit: 2 });
    expect(overridden.spy.mock.calls[0]?.[0].limit).toBe(2);
  });
});

describe("cursor", () => {
  it("sends null for the newest page and passes a cursor through unchanged", async () => {
    const newest = pagerFor();
    await newest.pager.page(NEWEST);
    expect(newest.spy.mock.calls[0]?.[0].before).toBeNull();

    const fromCursor = pagerFor();
    await fromCursor.pager.page({ ...NEWEST, before: "cursor-9" });
    expect(fromCursor.spy.mock.calls[0]?.[0].before).toBe("cursor-9");
  });
});

describe("hasOlder", () => {
  it("reports the last page when hasMore is false, even with a non-null cursor", () => {
    const { pager } = pagerFor();

    // The engine has been seen answering exactly this way. Trusting the cursor
    // instead of `hasMore` would ask for one page too many.
    const page: MessagePage = { messages: [], nextBefore: "cursor-still-here", hasMore: false };

    expect(pager.hasOlder(page)).toBe(false);
  });

  it("reads only hasMore, so a null cursor never decides on its own", () => {
    const { pager } = pagerFor();

    // `hasMore` and the cursor disagree in both directions; only the flag counts.
    expect(pager.hasOlder({ messages: [], nextBefore: null, hasMore: true })).toBe(true);
    expect(pager.hasOlder({ messages: [], nextBefore: null, hasMore: false })).toBe(false);
  });
});

describe("invalid arguments", () => {
  const cases: ReadonlyArray<{ what: string; call: PageCall }> = [
    { what: "an empty agentId", call: { agentId: "", conversationId: "c1", before: null } },
    { what: "a whitespace agentId", call: { agentId: " \t ", conversationId: "c1", before: null } },
    { what: "an empty conversationId", call: { agentId: "a1", conversationId: "", before: null } },
    {
      what: "a blank conversationId",
      call: { agentId: "a1", conversationId: " \n ", before: null },
    },
    { what: "a zero limit", call: { ...NEWEST, limit: 0 } },
    { what: "a negative limit", call: { ...NEWEST, limit: -5 } },
    { what: "a fractional limit", call: { ...NEWEST, limit: 1.5 } },
    { what: "a non-numeric limit", call: { ...NEWEST, limit: Number.NaN } },
  ];

  it.each(cases)("refuses $what without asking the engine", async ({ call }) => {
    const { pager, spy } = pagerFor();

    // A value, not a throw: the caller branches on `ok` once, everywhere.
    const result = await pager.page(call);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).toBeTruthy();
    // The refusal happens before the call, so it cannot be mistaken for a page
    // the engine declined to serve.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetch failure", () => {
  it("returns a rejected fetch as a value, passing the rejection through unchanged", async () => {
    const rejection = { code: "ENGINE_GONE", detail: "the engine stopped answering" };
    const pager = createPager({ fetch: vi.fn<PageFetcher>(() => Promise.reject(rejection)) });

    const result = await pager.page(NEWEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    // Same object, not a wrapped or rewritten one: the caller knows what its own
    // rejection means better than this layer does.
    expect(result.error).toBe(rejection);
  });

  it("returns a synchronous throw from the fetch as a value too", async () => {
    const boom = new Error("the engine is not running");
    const fetch = vi.fn<PageFetcher>(() => {
      throw boom;
    });
    const pager = createPager({ fetch });

    const result = await pager.page(NEWEST);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toBe(boom);
  });
});
