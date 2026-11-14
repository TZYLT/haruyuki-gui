/**
 * Tests for the producer-side sender.
 *
 * These cases test the ASSEMBLY, not the parts. `./validate`, `./sequencer`,
 * `./queue`, `./page` and `./batch` each have their own suite; what can go wrong
 * here is the wiring -- a check in the wrong order, a policy applied to the wrong
 * channel, a counter that counts the wrong thing, or a state that a failure
 * leaves half-settled. So the assertions are about what the transport received,
 * in what order, and which of the four codes was raised.
 *
 * The transport is always an injected function that collects payloads. Nothing
 * here opens a socket or waits for a timer: every payload this layer emits for
 * the five registered types is delivered synchronously inside `send`, which is a
 * property of the wiring rather than an accident of the test.
 *
 * Multi-page snapshots are built from items larger than half the 1 MB page
 * budget, because the frozen options carry no page-budget field: one item per
 * page is the only way a caller can ask this sender for a specific page count.
 *
 * Sequence numbers are asserted as an OFFSET from `currentSeq()` rather than as
 * absolute values. The issuer is a module-level singleton shared by the whole
 * process by design, so a hard-coded `1` would only encode "this file ran
 * first" -- and the claim under test is "consecutive and gap-free", which is
 * exactly what an offset preserves.
 */

import { describe, expect, it } from "vitest";

import { FRAME_PROTOCOL_VERSION } from "@haruyuki/protocol";
import type { BulkFrame, Frame } from "@haruyuki/protocol";

import { BULK_OVER_LIMIT } from "./page";
import { BRIDGE_QUEUE_OVERFLOW, BridgeQueueOverflowError } from "./queue";
import { currentSeq } from "./sequencer";
import { UNREGISTERED_FRAME_TYPE, UnregisteredFrameTypeError, createFrameSender } from "./sender";
import type { FrameSender, FrameSenderOptions } from "./sender";
import { FRAME_NOT_SERIALIZABLE, FrameSerializationError } from "./validate";

/** One payload the fake transport accepted, decoded back into a frame. */
interface Delivered {
  v: number;
  ch: string;
  seq: number;
  t: string;
  body: Record<string, unknown>;
  page?: { watermark: number; token: string; more: boolean };
}

/** A transport plus everything it received, and a switch to make it fail. */
interface FakeTransport {
  readonly received: Delivered[];
  readonly payloads: string[];
  /** When `true`, the next delivery records the payload and then throws. */
  failNext: boolean;
  readonly send: (payload: string) => void;
}

/**
 * A transport that decodes what it is given and can be made to fail.
 *
 * Recording BEFORE the throw is deliberate: it proves the sender did not retry,
 * so a test can tell "delivered once" from "delivered twice because the failure
 * was mistaken for a retryable condition".
 */
function fakeTransport(): FakeTransport {
  const received: Delivered[] = [];
  const payloads: string[] = [];

  const state: FakeTransport = {
    received,
    payloads,
    failNext: false,
    send(payload: string): void {
      payloads.push(payload);
      received.push(JSON.parse(payload) as Delivered);

      if (state.failNext) {
        state.failNext = false;

        throw new Error("transport refused the payload");
      }
    },
  };

  return state;
}

/** The value of `code` on anything thrown, so an assertion cannot crash on a type. */
function codeOf(thrown: unknown): unknown {
  if (typeof thrown !== "object" || thrown === null) {
    return undefined;
  }

  return (thrown as { code?: unknown }).code;
}

/**
 * Run `action` and return what it threw.
 *
 * The frozen contract says the four rejections THROW rather than return a
 * verdict. A case that quietly returned would pass a loose assertion otherwise,
 * so this helper fails the test in exactly that situation.
 */
function thrownBy(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }

  throw new Error("expected the call to throw, but it returned normally");
}

/** A control frame with the fields a real one carries. */
function controlFrame(overrides: Partial<Frame> = {}): Frame {
  return {
    v: FRAME_PROTOCOL_VERSION,
    ch: "control",
    seq: 0,
    t: "bridge.ready",
    body: { appVersion: "0.1.0", bridgeVersion: 1 },
    ...overrides,
  };
}

/** A stream frame: one terminal slice. */
function streamFrame(text = "slice"): Frame {
  return {
    v: FRAME_PROTOCOL_VERSION,
    ch: "stream",
    seq: 0,
    t: "term.output",
    body: { index: 1, text },
  };
}

/** A bulk frame whose body holds `items` under the recorded corpus shape. */
function bulkFrame(
  items: readonly unknown[],
  page: BulkFrame["page"] = { watermark: 12, token: "snap-multi", more: true },
): BulkFrame {
  return {
    v: FRAME_PROTOCOL_VERSION,
    ch: "bulk",
    seq: 0,
    t: "bulk.page",
    body: { page: 1, items },
    page,
  };
}

/**
 * Items sized so exactly one fits a default page: more than half of the 1 MB
 * budget, so two of them never share a page.
 */
function singlePageItems(count: number): string[] {
  const filler = "x".repeat(600 * 1024);

  return Array.from({ length: count }, (_unused, index) => `${filler}${String(index)}`);
}

/**
 * The numbers a run of payloads must carry: consecutive, starting one past the
 * last one this process issued before the measured call.
 */
function nextNumbers(count: number): number[] {
  const base = currentSeq();

  return Array.from({ length: count }, (_unused, index) => base + index + 1);
}

/** Create a sender over a fake transport. */
function senderWith(
  transport: FakeTransport,
  options: Partial<Omit<FrameSenderOptions, "transport">> = {},
): FrameSender {
  return createFrameSender({ transport: transport.send, ...options });
}

describe("the four rejection codes", () => {
  it("throws FRAME_NOT_SERIALIZABLE, with the field path, for a value JSON would rewrite", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // A `Date` is the first rejected class: `JSON.stringify` would silently
    // replace it with a string and the peer would decode something else.
    const error = thrownBy(() => {
      sender.send(controlFrame({ body: { createdAt: new Date(0) } }));
    });

    expect(codeOf(error)).toBe(FRAME_NOT_SERIALIZABLE);
    expect(error).toBeInstanceOf(FrameSerializationError);
    expect((error as FrameSerializationError).path).toBe("body.createdAt");
    expect(transport.received).toHaveLength(0);
    expect(sender.stats.sent).toBe(0);
  });

  it("throws UNREGISTERED_FRAME_TYPE for a `t` with no table row", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    const error = thrownBy(() => {
      sender.send(controlFrame({ t: "bridge.readyy" }));
    });

    expect(codeOf(error)).toBe(UNREGISTERED_FRAME_TYPE);
    expect(error).toBeInstanceOf(UnregisteredFrameTypeError);
    expect((error as UnregisteredFrameTypeError).t).toBe("bridge.readyy");
    expect(transport.received).toHaveLength(0);
  });

  it("throws BULK_OVER_LIMIT for one item that cannot fit a page on its own", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // One byte past the 1 MB page budget, so no page sequence can cover it. The
    // pager answers with an empty page rather than throwing; the sender owns the
    // decision, and therefore the code.
    const oversized = "x".repeat(1024 * 1024 + 1);
    const error = thrownBy(() => {
      sender.send(bulkFrame(["alpha", oversized]));
    });

    expect(codeOf(error)).toBe(BULK_OVER_LIMIT);
    expect(transport.received).toHaveLength(0);
    expect(sender.stats.sent).toBe(0);
  });

  it("throws BRIDGE_QUEUE_OVERFLOW when the channel may not buffer at all", () => {
    const transport = fakeTransport();
    // A limit of 0 is the honest way to say "this channel buffers nothing", and
    // it makes the overflow reachable without faking a slow consumer.
    const sender = senderWith(transport, { limits: { stream: 0 } });

    const error = thrownBy(() => {
      sender.send(streamFrame());
    });

    expect(codeOf(error)).toBe(BRIDGE_QUEUE_OVERFLOW);
    expect(error).toBeInstanceOf(BridgeQueueOverflowError);
    expect((error as BridgeQueueOverflowError).channel).toBe("stream");
    expect(transport.received).toHaveLength(0);
    expect(sender.stats.overflows).toBe(1);
  });
});

describe("the order the checks run in", () => {
  it("reports a body that is both invalid and oversized as a serialization failure", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // Unsendable for two reasons: the field path is the more actionable answer,
    // so the serialization check must be the one that decides.
    const error = thrownBy(() => {
      sender.send(bulkFrame([new Map([["a", 1]]), "x".repeat(1024 * 1024 + 1)]));
    });

    expect(codeOf(error)).toBe(FRAME_NOT_SERIALIZABLE);
  });

  it("reports an unregistered type before the page size matters", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    const error = thrownBy(() => {
      sender.send({ ...bulkFrame(["x".repeat(1024 * 1024 + 1)]), t: "nope.page" });
    });

    expect(codeOf(error)).toBe(UNREGISTERED_FRAME_TYPE);
  });

  it("refuses a channel outside the three, which would have no backlog limit", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // `FrameChannel` is exhaustive at compile time, but `ch` arrives from
    // JavaScript callers too, and a fourth channel would be an unbudgeted
    // backlog: the hard cap has to hold at runtime, not just in the types.
    const error = thrownBy(() => {
      sender.send({ ...controlFrame(), ch: "sideband" as unknown as Frame["ch"] });
    });

    expect(error).toBeInstanceOf(RangeError);
    expect(transport.received).toHaveLength(0);
  });

  it("does not spend a sequence number on a refused frame", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    const expected = nextNumbers(2);

    sender.send(controlFrame());
    expect(transport.received[0]?.seq).toBe(expected[0]);

    // Three different refusals, none of which may consume a number: `seq` stays
    // an exact count of the frames this process emitted.
    thrownBy(() => {
      sender.send(controlFrame({ body: { at: new Date(0) } }));
    });
    thrownBy(() => {
      sender.send(controlFrame({ t: "bridge.readyy" }));
    });
    thrownBy(() => {
      sender.send(bulkFrame(["x".repeat(1024 * 1024 + 1)]));
    });

    sender.send(controlFrame());

    expect(transport.received).toHaveLength(2);
    expect(transport.received[1]?.seq).toBe(expected[1]);
  });
});

describe("stats", () => {
  it("counts every payload the transport accepted", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    expect(sender.stats.sent).toBe(0);

    sender.send(controlFrame());
    expect(sender.stats.sent).toBe(1);

    sender.send(controlFrame({ t: "bridge.accept" }));
    expect(sender.stats.sent).toBe(2);

    // Three items, one per page: `sent` counts PAYLOADS, not frames.
    sender.send(bulkFrame(singlePageItems(3)));
    expect(sender.stats.sent).toBe(5);
    expect(transport.received).toHaveLength(5);
  });

  it("does not count a payload the transport refused", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    transport.failNext = true;

    expect(() => {
      sender.send(controlFrame());
    }).toThrow("transport refused the payload");

    // "sent" answers "how many strings the transport took"; a throw is precisely
    // the case where this module cannot know whether the bytes crossed.
    expect(sender.stats.sent).toBe(0);
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("reports the per-channel backlog left by an interrupted transport", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    transport.failNext = true;

    // Three pages, one failed delivery: the page that failed is gone (a
    // duplicate is worse than a loss on an ordered stream) and the two the
    // transport was never offered stay queued.
    expect(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    }).toThrow("transport refused the payload");

    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 2 });
    expect(sender.stats.sent).toBe(0);

    sender.flush();

    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
    expect(sender.stats.sent).toBe(2);
  });

  it("hands out a fresh stats object, so a caller cannot edit the counters", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(controlFrame());

    const first = sender.stats;
    first.queued.bulk = 99;

    expect(sender.stats.queued.bulk).toBe(0);
    expect(sender.stats).not.toBe(first);
  });

  it("counts overflow refusals, and refuses the unit atomically", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport, { limits: { bulk: 2 } });

    // Three pages, a limit of two: the snapshot cannot fit, so none of it is
    // staged and the refusal arrives on the caller's `send`.
    const error = thrownBy(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    });

    expect(codeOf(error)).toBe(BRIDGE_QUEUE_OVERFLOW);
    expect(sender.stats.overflows).toBe(1);
    expect(sender.stats.sent).toBe(0);

    sender.flush();

    // Nothing was half-applied: two of the three pages were never delivered.
    expect(transport.received).toHaveLength(0);
  });
});

describe("per-channel policy", () => {
  it("delivers a control frame immediately, inside send", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(controlFrame());

    // No flush, no timer: an acknowledgement that waited for anything would
    // break request/response correlation.
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.ch).toBe("control");
  });

  it("delivers a stream frame immediately, without a batching window", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(streamFrame());

    // `term.output` loses data if a frame waits: the bytes are a stream, and the
    // window is not configured to touch it.
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.t).toBe("term.output");
  });

  it("budgets the channels independently", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport, { limits: { bulk: 0, control: 0 } });

    // A refused bulk channel does not stop a control frame, and vice versa; a
    // shared budget would let one stalled channel take the others down.
    thrownBy(() => {
      sender.send(bulkFrame(["alpha"]));
    });

    expect(transport.received).toHaveLength(0);
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });

    // `stream` keeps its default budget, so it still works.
    sender.send(streamFrame());

    expect(transport.received).toHaveLength(1);
    expect(sender.stats.overflows).toBe(1);
  });
});

describe("bulk paging", () => {
  it("gives every page its own sequence number, consecutively", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    const expected = nextNumbers(3);

    sender.send(bulkFrame(singlePageItems(3)));

    // Consecutive numbers are what makes the pages read as one snapshot on a
    // channel where cross-channel order is not promised (INV-A3-8).
    expect(transport.received.map((frame) => frame.seq)).toEqual(expected);
  });

  it("keeps a single-page snapshot on one frame with the caller's token", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(bulkFrame(["alpha"], { watermark: 7, token: "snap-single", more: false }));

    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.page).toEqual({
      watermark: 7,
      token: "snap-single",
      more: false,
    });
  });

  it("reports more as false when the snapshot really is complete", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // The caller said `more: true`, but nothing follows: the cursor describes the
    // snapshot, so the sender's answer wins.
    sender.send(bulkFrame(["alpha", "beta"], { watermark: 4, token: "snap", more: true }));

    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.page?.more).toBe(false);
  });

  it("mints a per-page token, because the renderer deduplicates on the pair", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(bulkFrame(singlePageItems(3), { watermark: 12, token: "snap-multi", more: true }));

    const tokens = transport.received.map((frame) => frame.page?.token);

    // C5-R07 and `packages/ui/src/bridge/entry.ts`: the dedup key is
    // `${watermark}:${token}`, and every page of one snapshot shares the
    // watermark, so a shared token would make the renderer drop pages 2..n as
    // duplicates of page 1.
    expect(tokens).toEqual(["snap-multi#1", "snap-multi#2", "snap-multi#3"]);
    expect(new Set(tokens).size).toBe(3);
  });

  it("sends an empty snapshot as one empty page rather than nothing", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(bulkFrame([], { watermark: 3, token: "snap-empty", more: true }));

    // Silence is indistinguishable from a stuck sender.
    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.body["items"]).toEqual([]);
    expect(transport.received[0]?.page?.more).toBe(false);
  });

  it("mints a watermark when the caller supplied no usable one", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    const expected = nextNumbers(1);

    sender.send(bulkFrame(["alpha"], { watermark: Number.NaN, token: "", more: true }));

    // The snapshot's first `seq` stands in for a missing watermark, and the
    // token follows it, so a newer snapshot compares strictly greater.
    expect(transport.received[0]?.page?.watermark).toBe(expected[0]);
    expect(transport.received[0]?.page?.token).toBe(`snap-${String(expected[0])}`);
  });

  it("delivers a body that is not a list as one whole page", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send({ ...bulkFrame([]), body: { summary: "no list here" } });

    expect(transport.received).toHaveLength(1);
    expect(transport.received[0]?.body).toEqual({ summary: "no list here" });
    expect(transport.received[0]?.page?.more).toBe(false);
  });

  it("does not mutate the caller's frame", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);
    const frame = bulkFrame(["alpha", "beta"]);

    sender.send(frame);

    expect(frame.seq).toBe(0);
    expect(frame.page).toEqual({ watermark: 12, token: "snap-multi", more: true });
    expect(frame.body).toEqual({ page: 1, items: ["alpha", "beta"] });
  });
});

describe("flush", () => {
  it("delivers what an interrupted transport left behind", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    transport.failNext = true;
    expect(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    }).toThrow();

    sender.flush();
    sender.flush();

    expect(transport.received).toHaveLength(3);

    // Delivered in the order they were staged, with no duplicate of the page
    // that failed.
    expect(transport.received.map((frame) => frame.body["page"])).toEqual([1, 2, 3]);
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("is a no-op on an idle sender", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.flush();

    expect(transport.received).toHaveLength(0);
    expect(sender.stats.sent).toBe(0);
  });
});

describe("close", () => {
  it("delivers what was already accepted", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    transport.failNext = true;
    expect(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    }).toThrow();

    sender.close();

    expect(transport.received).toHaveLength(3);
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("refuses every later send, including after a second close", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send(controlFrame());
    sender.close();
    sender.close();

    expect(() => {
      sender.send(controlFrame());
    }).toThrow(/closed/);

    expect(transport.received).toHaveLength(1);
  });

  it("stays closed when the final flush fails, so a retry cannot look safe", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    transport.failNext = true;
    expect(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    }).toThrow();

    transport.failNext = true;

    // The transport is still broken, so `close` propagates the failure...
    expect(() => {
      sender.close();
    }).toThrow("transport refused the payload");

    // ...and the sender is nevertheless closed: nothing can be produced into a
    // dead edge. What the interrupted pump left can still go out.
    expect(() => {
      sender.send(controlFrame());
    }).toThrow(/closed/);

    sender.flush();
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
  });
});

describe("options", () => {
  it("replaces the accepted frame types when the caller injects a set", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport, { frameTypes: new Set(["custom.event"]) });

    sender.send(controlFrame({ t: "custom.event" }));

    expect(transport.received).toHaveLength(1);

    // The injected set is the whole registration story: the default table is
    // replaced, not extended.
    const error = thrownBy(() => {
      sender.send(controlFrame());
    });

    expect(codeOf(error)).toBe(UNREGISTERED_FRAME_TYPE);
  });

  it("copies the injected set, so a later mutation cannot widen it", () => {
    const transport = fakeTransport();
    const types = new Set(["custom.event"]);
    const sender = senderWith(transport, { frameTypes: types });

    types.add("bridge.ready");

    const error = thrownBy(() => {
      sender.send(controlFrame());
    });

    expect(codeOf(error)).toBe(UNREGISTERED_FRAME_TYPE);
  });

  it("applies custom per-channel limits", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport, { limits: { bulk: 2 } });

    // Two pages fit the limit; three do not, so the same snapshot is refused
    // wholesale rather than split into "two now, one never".
    sender.send(bulkFrame(singlePageItems(2)));
    expect(transport.received).toHaveLength(2);

    const error = thrownBy(() => {
      sender.send(bulkFrame(singlePageItems(3)));
    });

    expect(codeOf(error)).toBe(BRIDGE_QUEUE_OVERFLOW);
    expect(transport.received).toHaveLength(2);
  });

  it("refuses a window length outside the accepted range, without clamping", () => {
    const transport = fakeTransport();

    expect(() => senderWith(transport, { windowMs: 4 })).toThrow(RangeError);
    expect(() => senderWith(transport, { windowMs: 65 })).toThrow(RangeError);
    expect(() => senderWith(transport, { windowMs: 8 })).not.toThrow();
    expect(() => senderWith(transport, { windowMs: 64 })).not.toThrow();
  });

  it("refuses a transport that is not a function", () => {
    expect(() =>
      createFrameSender({ transport: undefined as unknown as (payload: string) => void }),
    ).toThrow(TypeError);
  });
});

describe("end to end", () => {
  it("turns one bulk frame with a three-page body into three transport payloads", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    // The three-page boundary of `fixtures/bridge/bulk-multi-page.jsonl`:
    // one snapshot, one watermark, `more` true / true / false, the last frame
    // closing the snapshot.
    const expected = nextNumbers(3);

    sender.send(bulkFrame(singlePageItems(3), { watermark: 12, token: "snap-multi", more: true }));

    const delivered = transport.received;

    expect(delivered).toHaveLength(3);
    expect(delivered.map((frame) => frame.page?.more)).toEqual([true, true, false]);
    expect(delivered.map((frame) => frame.page?.watermark)).toEqual([12, 12, 12]);
    expect(delivered.map((frame) => frame.body["page"])).toEqual([1, 2, 3]);
    expect(delivered.map((frame) => frame.v)).toEqual([1, 1, 1]);
    expect(delivered.map((frame) => frame.ch)).toEqual(["bulk", "bulk", "bulk"]);
    expect(delivered.map((frame) => frame.t)).toEqual(["bulk.page", "bulk.page", "bulk.page"]);
    expect(delivered.map((frame) => frame.seq)).toEqual(expected);

    // The payloads tile the snapshot: every item exactly once, in order.
    const items = delivered.flatMap((frame) => frame.body["items"] as unknown[]);

    expect(items).toEqual(singlePageItems(3));
    expect(sender.stats.sent).toBe(3);
    expect(sender.stats.queued).toEqual({ control: 0, stream: 0, bulk: 0 });
  });

  it("keeps the snapshot's own body fields on every page", () => {
    const transport = fakeTransport();
    const sender = senderWith(transport);

    sender.send({
      ...bulkFrame(singlePageItems(2)),
      body: { page: 1, token: "snap-multi", items: singlePageItems(2) },
    });

    // A page is independently resumable, so it repeats the snapshot-level
    // fields instead of referring to a frame the peer may never have seen.
    for (const frame of transport.received) {
      expect(frame.body["token"]).toBe("snap-multi");
      expect(Array.isArray(frame.body["items"])).toBe(true);
    }

    expect(transport.received).toHaveLength(2);
  });
});
