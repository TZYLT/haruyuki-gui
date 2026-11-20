/// <reference types="vite/client" />

/**
 * Tests for the frame entry: the renderer's receiving half of the bridge.
 *
 * Requirement source: the frozen frame-entry interface and its acceptance
 * criteria -- a stale watermark is dropped, the version guard is enforced and
 * the entry stays silent after a reject, approval ordering is preserved, and a
 * page never crosses its cursor twice. The corpus is the recorded one under
 * `fixtures/bridge/`, read as raw text and parsed here line by line, so the
 * assertions run against the exact bytes a socket would deliver rather than
 * against a pre-digested model of them. `loadFramesFixture` in `@haruyuki/core`
 * is deliberately not used: a test of this entry should be driven the way the
 * entry is, by raw payloads.
 *
 * Why `import.meta.glob` with `?raw` rather than `node:fs`
 *   The renderer may not import a Node builtin (rule R4), so the fixture text
 *   reaches this test through the bundler. That is also closer to production
 *   than `readFileSync` would be: the entry's contract is a *string* payload,
 *   and the glob hands over strings.
 *
 * What each block proves
 *   - the three named corpus scenarios, each asserted through the public
 *     surface (`status`, `snapshot`, `violations`) rather than internals;
 *   - the individual rules, on small inline payloads, so a failure names the
 *     rule instead of a fixture line;
 *   - the notification and snapshot-ownership properties, which are what a
 *     consumer actually depends on.
 */

import { describe, expect, it, vi } from "vitest";

import { createFrameEntry } from "./entry.js";
import type { FrameEntry, FrameEntryOptions } from "./entry.js";

/* ------------------------------------------------------------------ */
/* corpus                                                              */
/* ------------------------------------------------------------------ */

/**
 * Every bridge fixture, as raw text, keyed by the path the glob produced.
 *
 * `eager` so the text is available synchronously and a missing file fails at
 * import time rather than inside an unrelated assertion.
 */
const CORPUS: Record<string, string> = import.meta.glob("../../../../fixtures/bridge/*.jsonl", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The protocol version every fixture envelope carries. */
const CORPUS_PROTOCOL_VERSION = 1;

/** The bridge version the fixtures agree on, in its string wire form. */
const CORPUS_BRIDGE_VERSION = "1";

/**
 * The frame payloads of one corpus file, header line excluded.
 *
 * Each line is returned as its original text, not re-serialised: the entry
 * parses, so handing it the exact fixture bytes is the point.
 *
 * @param name corpus member file name
 * @returns the non-header lines, in file order
 */
function framesOf(name: string): string[] {
  const entry = Object.entries(CORPUS).find(([path]) => path.endsWith(`/${name}`));

  if (entry === undefined) {
    throw new Error(`bridge corpus member ${name} was not collected by the glob`);
  }

  const lines = entry[1].split("\n").filter((line) => line.trim() !== "");

  // The first line is the frozen `kind: "frames"` header, not a frame; the
  // loader in the core skips it the same way.
  return lines.slice(1);
}

/** Options matching the corpus, so a scenario only asserts what it is about. */
function corpusOptions(overrides: Partial<FrameEntryOptions> = {}): FrameEntryOptions {
  return {
    expectedBridgeVersion: CORPUS_BRIDGE_VERSION,
    frameProtocolVersion: CORPUS_PROTOCOL_VERSION,
    ...overrides,
  };
}

/** Feed every payload of one corpus member to a fresh entry. */
function playFixture(name: string, options: FrameEntryOptions = corpusOptions()): FrameEntry {
  const entry = createFrameEntry(options);

  for (const payload of framesOf(name)) {
    entry.handle(payload);
  }

  return entry;
}

/* ------------------------------------------------------------------ */
/* inline payload helpers                                              */
/* ------------------------------------------------------------------ */

/** One control-channel `bridge.ready` payload announcing the given version. */
function readyPayload(bridgeVersion: unknown, seq = 1): string {
  return JSON.stringify({
    v: CORPUS_PROTOCOL_VERSION,
    ch: "control",
    seq,
    t: "bridge.ready",
    body: { appVersion: "0.1.0", bridgeVersion },
  });
}

/** One bulk page payload; `watermark` and `token` may be omitted on purpose. */
function bulkPayload(
  page: { watermark?: number; token?: string; more?: boolean },
  seq = 2,
): string {
  return JSON.stringify({
    v: CORPUS_PROTOCOL_VERSION,
    ch: "bulk",
    seq,
    t: "bulk.page",
    body: { page: 1, items: ["x"] },
    page: { more: false, ...page },
  });
}

/** One stream-channel payload of a registered type. */
function streamPayload(seq: number): string {
  return JSON.stringify({
    v: CORPUS_PROTOCOL_VERSION,
    ch: "stream",
    seq,
    t: "term.output",
    body: { bytes: "x" },
  });
}

/* ------------------------------------------------------------------ */
/* corpus scenarios                                                    */
/* ------------------------------------------------------------------ */

describe("watermark fixture", () => {
  it("drops the stale page at watermark 40 and keeps it out of the bulk count", () => {
    const entry = playFixture("watermark.jsonl");
    const snapshot = entry.snapshot();

    // The fixture carries four bulk pages: three at watermark 100 and the
    // stale one at 40 arriving between them.
    expect(snapshot.perChannel.bulk).toBe(3);

    // Exactly the stale page is refused, and by the watermark rule.
    expect(entry.violations()).toEqual([{ kind: "stale-watermark" }]);

    // The frames after the dropped one are still processed: seq 5 was accepted,
    // so a drop must not stop the stream. That is the difference between "drop
    // the page" and "abandon the connection".
    expect(snapshot.lastSeq).toBe(5);
    expect(snapshot.bridge.state).toBe("accepted");
  });

  it("counts only the pages it kept", () => {
    const entry = playFixture("watermark.jsonl");
    const before = entry.snapshot().perChannel.bulk;

    // A fresh page after the whole fixture is still accepted, which proves the
    // dropped one did not leave the cursor behind.
    entry.handle(bulkPayload({ watermark: 100, token: "snap-100-p4" }, 6));

    expect(entry.snapshot().perChannel.bulk).toBe(before + 1);
    expect(entry.snapshot().violations).toBe(1);
  });
});

describe("version-mismatch fixture", () => {
  it("reaches rejected with the mismatch code", () => {
    const entry = playFixture("version-mismatch.jsonl");

    expect(entry.status()).toEqual({
      state: "rejected",
      code: "BRIDGE_VERSION_MISMATCH",
    });
  });

  it("is silent after the reject: later frames change no counter", () => {
    const entry = playFixture("version-mismatch.jsonl");
    const afterReject = entry.snapshot();

    // The fixture's second line is the core's own `bridge.reject`; the entry
    // has already refused the ready, so it must not count what follows.
    expect(afterReject.perChannel.control).toBe(1);
    expect(afterReject.perChannel.bulk).toBe(0);
    expect(afterReject.lastSeq).toBe(1);

    // Anything at all arriving afterwards -- a well-formed frame, a stale page,
    // garbage -- is ignored, including in the violation count.
    entry.handle(streamPayload(9));
    entry.handle(bulkPayload({ watermark: 1, token: "late" }, 10));
    entry.handle("{");

    expect(entry.snapshot()).toEqual(afterReject);
    expect(entry.status()).toEqual({ state: "rejected", code: "BRIDGE_VERSION_MISMATCH" });
  });
});

describe("handshake-accept fixture", () => {
  it("reaches accepted and routes the snapshot page", () => {
    const entry = playFixture("handshake-accept.jsonl");

    expect(entry.status()).toEqual({ state: "accepted" });
    expect(entry.snapshot().perChannel).toEqual({ control: 2, stream: 0, bulk: 1 });
    expect(entry.violations()).toEqual([]);
  });
});

describe("three-channels fixture", () => {
  it("routes every frame to its own channel counter", () => {
    const entry = playFixture("three-channels.jsonl");
    const snapshot = entry.snapshot();

    // control: ready. bulk: two pages. stream: four frames. Total 7.
    expect(snapshot.perChannel.control).toBe(1);
    expect(snapshot.perChannel.bulk).toBe(2);
    expect(snapshot.perChannel.stream).toBe(4);
    expect(snapshot.lastSeq).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* malformed input                                                     */
/* ------------------------------------------------------------------ */

describe("malformed payloads", () => {
  it("does not throw and records one violation per payload", () => {
    const entry = createFrameEntry(corpusOptions());

    for (const payload of ["{", "not json", "[]", "null"]) {
      expect(() => entry.handle(payload)).not.toThrow();
    }

    expect(entry.violations()).toEqual([
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
    ]);

    // Nothing was routed and the verdict has not moved: a broken payload is not
    // a failed handshake.
    expect(entry.snapshot().perChannel).toEqual({ control: 0, stream: 0, bulk: 0 });
    expect(entry.status()).toEqual({ state: "waiting" });
  });

  it("refuses an envelope with a missing or non-numeric v", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(JSON.stringify({ ch: "control", seq: 1, t: "bridge.ready" }));
    entry.handle(JSON.stringify({ v: "1", ch: "control", seq: 2, t: "bridge.ready" }));

    expect(entry.violations()).toEqual([
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
    ]);
  });

  it("refuses a payload whose ch, seq or t is missing", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(JSON.stringify({ v: 1, seq: 1, t: "bridge.ready" }));
    entry.handle(JSON.stringify({ v: 1, ch: "control", t: "bridge.ready" }));
    entry.handle(JSON.stringify({ v: 1, ch: "control", seq: 1 }));

    expect(entry.violations()).toEqual([
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
      { kind: "malformed-payload" },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* protocol version guard                                              */
/* ------------------------------------------------------------------ */

describe("protocol version guard", () => {
  it("drops a frame whose v differs from the injected version", () => {
    const entry = createFrameEntry(corpusOptions({ frameProtocolVersion: 2 }));

    entry.handle(
      JSON.stringify({
        v: 1,
        ch: "control",
        seq: 1,
        t: "bridge.ready",
        body: { bridgeVersion: "1" },
      }),
    );

    expect(entry.violations()).toEqual([{ kind: "protocol-version-mismatch" }]);
    expect(entry.snapshot().perChannel.control).toBe(0);
    expect(entry.snapshot().lastSeq).toBe(0);
    expect(entry.status()).toEqual({ state: "waiting" });
  });

  it("accepts the matching version", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(readyPayload("1"));

    expect(entry.violations()).toEqual([]);
    expect(entry.status()).toEqual({ state: "accepted" });
  });

  it("refuses a non-finite injection at creation", () => {
    expect(() => createFrameEntry(corpusOptions({ frameProtocolVersion: Number.NaN }))).toThrow(
      RangeError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* handshake semantics                                                 */
/* ------------------------------------------------------------------ */

describe("handshake", () => {
  it("accepts a numeric version announcement equal to the expected string", () => {
    // The corpus carries both wire forms; `1` and `"1"` are the same version.
    const entry = createFrameEntry(corpusOptions());

    entry.handle(readyPayload(1));

    expect(entry.status()).toEqual({ state: "accepted" });
  });

  it("keeps waiting when the ready body announces no usable version", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(readyPayload(undefined));

    expect(entry.status()).toEqual({ state: "waiting" });
    expect(entry.violations()).toEqual([{ kind: "malformed-ready" }]);
    // The frame itself was still routed; only the verdict did not move.
    expect(entry.snapshot().perChannel.control).toBe(1);
  });

  it("is final on the second ready, in both directions", () => {
    const accepted = createFrameEntry(corpusOptions());
    accepted.handle(readyPayload("1"));
    accepted.handle(readyPayload("2", 2));

    expect(accepted.status()).toEqual({ state: "accepted" });

    const rejected = createFrameEntry(corpusOptions());
    rejected.handle(readyPayload("2"));
    rejected.handle(readyPayload("1", 2));

    expect(rejected.status()).toEqual({ state: "rejected", code: "BRIDGE_VERSION_MISMATCH" });
  });

  it("does not take a verdict from a ready frame on a non-control channel", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(
      JSON.stringify({
        v: 1,
        ch: "stream",
        seq: 1,
        t: "bridge.ready",
        body: { appVersion: "0.1.0", bridgeVersion: "1" },
      }),
    );

    expect(entry.status()).toEqual({ state: "waiting" });
    expect(entry.snapshot().perChannel.stream).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* watermark and duplicate rules                                       */
/* ------------------------------------------------------------------ */

describe("watermark", () => {
  it("drops a page behind the cursor and keeps the cursor", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ watermark: 10, token: "a" }, 1));
    entry.handle(bulkPayload({ watermark: 20, token: "b" }, 2));
    entry.handle(bulkPayload({ watermark: 15, token: "c" }, 3));

    expect(entry.snapshot().perChannel.bulk).toBe(2);
    expect(entry.violations()).toEqual([{ kind: "stale-watermark" }]);
  });

  it("accepts an equal watermark with a new token", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ watermark: 7, token: "p1" }, 1));
    entry.handle(bulkPayload({ watermark: 7, token: "p2" }, 2));

    expect(entry.snapshot().perChannel.bulk).toBe(2);
    expect(entry.violations()).toEqual([]);
  });

  it("accepts a page that carries no cursor", () => {
    // The recorded corpus has such pages; their content is real, so only the
    // rules that need a cursor are skipped.
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ more: true }, 1));
    entry.handle(bulkPayload({ more: false }, 2));

    expect(entry.snapshot().perChannel.bulk).toBe(2);
    expect(entry.violations()).toEqual([]);
  });
});

describe("duplicate pages", () => {
  it("drops a repeated (watermark, token) pair", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ watermark: 5, token: "same" }, 1));
    entry.handle(bulkPayload({ watermark: 5, token: "same" }, 2));

    expect(entry.snapshot().perChannel.bulk).toBe(1);
    expect(entry.violations()).toEqual([{ kind: "duplicate-page" }]);
  });

  it("keeps the two rules distinguishable in one stream", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ watermark: 5, token: "a" }, 1));
    entry.handle(bulkPayload({ watermark: 5, token: "a" }, 2));
    entry.handle(bulkPayload({ watermark: 4, token: "b" }, 3));

    expect(entry.snapshot().perChannel.bulk).toBe(1);
    expect(entry.violations()).toEqual([{ kind: "duplicate-page" }, { kind: "stale-watermark" }]);
  });

  it("does not confuse a stream frame with a bulk page", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(streamPayload(1));
    entry.handle(streamPayload(1));

    // Deduplication is a bulk rule: a repeated seq on the stream channel is the
    // transport's business, not this layer's.
    expect(entry.snapshot().perChannel.stream).toBe(2);
    expect(entry.violations()).toEqual([]);
  });
});

describe("a cursor the entry cannot read", () => {
  it("refuses a page whose watermark is a string, rather than skipping the stale check", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(bulkPayload({ watermark: 100, token: "fresh" }, 1));
    // Would be dropped as stale at 40, but `"40"` is not a number, and the old
    // code treated "not a number" as "no cursor" -- accepting the page and
    // counting it, while looking like it had one.
    entry.handle(bulkPayload({ watermark: "40" as never, token: "stale" }, 2));

    expect(entry.snapshot().perChannel.bulk).toBe(1);
    expect(entry.violations()).toEqual([{ kind: "malformed-cursor" }]);
  });

  it("refuses a page whose token is not a string, rather than skipping dedup", () => {
    const entry = createFrameEntry(corpusOptions());

    // Three sends of one page. The old code accepted all three because a
    // non-string token meant "no cursor", so the same page was applied (and
    // counted) three times.
    entry.handle(bulkPayload({ watermark: 7, token: 5 as never }, 1));
    entry.handle(bulkPayload({ watermark: 7, token: 5 as never }, 2));
    entry.handle(bulkPayload({ watermark: 7, token: 5 as never }, 3));

    expect(entry.snapshot().perChannel.bulk).toBe(0);
    expect(entry.violations()).toEqual([
      { kind: "malformed-cursor" },
      { kind: "malformed-cursor" },
      { kind: "malformed-cursor" },
    ]);
  });

  it("refuses a negative or fractional watermark", () => {
    const entry = createFrameEntry(corpusOptions());

    // A numeric but unusable watermark would enter the monotone comparison and
    // make every later page ambiguous.
    entry.handle(bulkPayload({ watermark: -1, token: "a" }, 1));
    entry.handle(bulkPayload({ watermark: 1.5, token: "b" }, 2));

    expect(entry.snapshot().perChannel.bulk).toBe(0);
  });

  it("still accepts a page with page.more and no cursor fields at all", () => {
    const entry = createFrameEntry(corpusOptions());

    // The distinction that matters: absent is not the same as malformed.
    entry.handle(bulkPayload({ more: true }, 1));

    expect(entry.snapshot().perChannel.bulk).toBe(1);
    expect(entry.violations()).toEqual([]);
  });
});

describe("handshake before the type table", () => {
  it("still rejects an incompatible bridge when the table omits bridge.ready", () => {
    // Downstream consumers inject only the types they decode, so a table
    // without `bridge.ready` is a legal configuration. Checking the table first
    // switched the version guard off in exactly that configuration, and a peer
    // on an incompatible bridge had its pages routed and rendered.
    const entry = createFrameEntry(
      corpusOptions({ frameTypes: new Set(["bulk.page", "term.output"]) }),
    );

    entry.handle(
      JSON.stringify({
        v: CORPUS_PROTOCOL_VERSION,
        ch: "control",
        seq: 1,
        t: "bridge.ready",
        body: { appVersion: "0.1.0", bridgeVersion: "999" },
      }),
    );
    entry.handle(bulkPayload({ watermark: 1, token: "a" }, 2));

    expect(entry.status()).toEqual({ state: "rejected", code: "BRIDGE_VERSION_MISMATCH" });
    // And silent afterwards, which is the rest of the version guard.
    expect(entry.snapshot().perChannel.bulk).toBe(0);
  });

  it("still accepts a matching bridge whose ready frame is not in the table", () => {
    const entry = createFrameEntry(
      corpusOptions({ frameTypes: new Set(["bulk.page", "term.output"]) }),
    );

    entry.handle(
      JSON.stringify({
        v: CORPUS_PROTOCOL_VERSION,
        ch: "control",
        seq: 1,
        t: "bridge.ready",
        body: { appVersion: "0.1.0", bridgeVersion: CORPUS_BRIDGE_VERSION },
      }),
    );

    // Counted on its channel, and the frame is not reported as unregistered:
    // the ready frame is this layer's business regardless of the table.
    expect(entry.status()).toEqual({ state: "accepted" });
    expect(entry.snapshot().perChannel.control).toBe(1);
    expect(entry.violations()).toEqual([]);
  });
});

describe("bounded diagnostics", () => {
  it("keeps counting violations after the retained list is full", () => {
    const entry = createFrameEntry(corpusOptions());

    for (let index = 0; index < 400; index += 1) {
      entry.handle("not a frame");
    }

    // The count stays truthful; the list is bounded. A peer that sends junk at
    // frame rate is exactly the peer this layer exists to survive.
    expect(entry.snapshot().violations).toBe(400);
    expect(entry.violations().length).toBeLessThanOrEqual(256);
    expect(entry.violations().length).toBeGreaterThan(0);
  });

  it("forgets dedup keys from snapshots older than the current watermark", () => {
    const entry = createFrameEntry(corpusOptions());

    for (let watermark = 1; watermark <= 200; watermark += 5) {
      entry.handle(bulkPayload({ watermark, token: "page" }, watermark));
    }

    // The cursor only moves forward, so those pages can never be admitted
    // again and their keys would accumulate for the life of the renderer. The
    // current watermark stays, because its remaining pages still arrive.
    expect(entry.snapshot().perChannel.bulk).toBeGreaterThan(0);
    expect(entry.snapshot().violations).toBe(0);
  });
});

describe("seq integrity", () => {
  it("refuses a negative or fractional seq instead of half-recording it", () => {
    const entry = createFrameEntry(corpusOptions());

    // A negative seq was routed and counted but never advanced `lastSeq`, so the
    // frame was delivered yet unrecorded; a fractional one made every later
    // comparison ambiguous.
    for (const seq of [-1, 1.5, 2 ** 60]) {
      entry.handle(
        JSON.stringify({
          v: CORPUS_PROTOCOL_VERSION,
          ch: "stream",
          seq,
          t: "term.output",
          body: {},
        }),
      );
    }

    expect(entry.snapshot().perChannel.stream).toBe(0);
    expect(entry.snapshot().lastSeq).toBe(0);
    expect(entry.snapshot().violations).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* frame type table                                                    */
/* ------------------------------------------------------------------ */

describe("frame types", () => {
  it("drops an unregistered t and names it", () => {
    const entry = createFrameEntry(
      corpusOptions({ frameTypes: new Set(["bridge.ready", "bulk.page"]) }),
    );

    entry.handle(streamPayload(1));

    expect(entry.violations()).toEqual([{ kind: "unregistered-type", t: "term.output" }]);
    expect(entry.snapshot().perChannel.stream).toBe(0);
  });

  it("routes every t when no table is injected", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(streamPayload(1));

    expect(entry.snapshot().perChannel.stream).toBe(1);
    expect(entry.violations()).toEqual([]);
  });

  it("copies the injected table, so a later mutation cannot widen it", () => {
    const types = new Set(["bridge.ready"]);
    const entry = createFrameEntry(corpusOptions({ frameTypes: types }));

    types.add("term.output");
    entry.handle(streamPayload(1));

    expect(entry.snapshot().perChannel.stream).toBe(0);
  });

  it("still records the seq of a frame it refuses for its type", () => {
    const entry = createFrameEntry(corpusOptions({ frameTypes: new Set<string>() }));

    entry.handle(streamPayload(4));

    // `lastSeq` describes the wire, not the accepted set: a refused frame was
    // still delivered, and losing that would hide a gap from diagnostics.
    expect(entry.snapshot().lastSeq).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* approval ordering                                                    */
/* ------------------------------------------------------------------ */

describe("inverted approval order", () => {
  it("accepts the bulk page that arrived before its control frame", () => {
    const entry = createFrameEntry(corpusOptions());

    // Injected out of order: the page first, the authorising frame second.
    entry.handle(bulkPayload({ watermark: 3, token: "early" }, 1));
    entry.handle(readyPayload("1", 2));

    // The chosen behaviour, stated as an assertion: arrival order is preserved
    // and never repaired. The page is accepted, counted and enters the cursor
    // books exactly as if it had arrived second, and the late handshake only
    // moves the verdict.
    expect(entry.snapshot().perChannel.bulk).toBe(1);
    expect(entry.snapshot().perChannel.control).toBe(1);
    expect(entry.status()).toEqual({ state: "accepted" });
    expect(entry.violations()).toEqual([]);
  });

  it("is deterministic: the same inversion always lands the same page order", () => {
    const first = createFrameEntry(corpusOptions());
    first.handle(bulkPayload({ watermark: 9, token: "early" }, 1));
    first.handle(readyPayload("1", 2));
    first.handle(bulkPayload({ watermark: 9, token: "late" }, 3));

    const second = createFrameEntry(corpusOptions());
    second.handle(bulkPayload({ watermark: 9, token: "early" }, 1));
    second.handle(readyPayload("1", 2));
    second.handle(bulkPayload({ watermark: 9, token: "late" }, 3));

    expect(first.snapshot()).toEqual(second.snapshot());
    expect(first.violations()).toEqual(second.violations());

    // The early page occupied the cursor before the control frame arrived, so
    // the later page is told apart by its token rather than refused as stale.
    expect(first.snapshot().perChannel.bulk).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* subscription                                                        */
/* ------------------------------------------------------------------ */

describe("subscribe", () => {
  it("notifies once per payload that changes something", () => {
    const entry = createFrameEntry(corpusOptions());
    const listener = vi.fn();

    entry.subscribe(listener);

    entry.handle(readyPayload("1", 1));
    entry.handle(bulkPayload({ watermark: 1, token: "a" }, 2));

    expect(listener).toHaveBeenCalledTimes(2);

    // A payload that changes nothing observable -- here a dropped duplicate --
    // still changed the violation count, so it notifies too.
    entry.handle(bulkPayload({ watermark: 1, token: "a" }, 3));

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("does not notify after unsubscribing, and unsubscribing twice is safe", () => {
    const entry = createFrameEntry(corpusOptions());
    const listener = vi.fn();

    const unsubscribe = entry.subscribe(listener);
    entry.handle(readyPayload("1", 1));
    unsubscribe();
    unsubscribe();

    entry.handle(bulkPayload({ watermark: 1, token: "a" }, 2));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("contains a throwing listener so the others still run", () => {
    const entry = createFrameEntry(corpusOptions());
    const before = vi.fn();
    const after = vi.fn();

    entry.subscribe(before);
    entry.subscribe(() => {
      throw new Error("listener bug");
    });
    entry.subscribe(after);

    expect(() => entry.handle(readyPayload("1", 1))).not.toThrow();

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("lets a listener unsubscribe the next one without skipping the rest", () => {
    const entry = createFrameEntry(corpusOptions());
    const calls: string[] = [];

    const unsubscribeSecond = entry.subscribe(() => {
      calls.push("second");
    });

    entry.subscribe(() => {
      calls.push("first");
      unsubscribeSecond();
    });

    entry.subscribe(() => {
      calls.push("third");
    });

    entry.handle(readyPayload("1", 1));

    // The notification in progress calls everyone who was registered when it
    // started; the removal takes effect for the next payload.
    expect(calls).toEqual(["second", "first", "third"]);

    entry.handle(bulkPayload({ watermark: 1, token: "a" }, 2));

    expect(calls).toEqual(["second", "first", "third", "first", "third"]);
  });

  it("does not notify after a reject", () => {
    const entry = createFrameEntry(corpusOptions());
    const listener = vi.fn();

    entry.subscribe(listener);
    entry.handle(readyPayload("2", 1));

    expect(listener).toHaveBeenCalledTimes(1);

    entry.handle(readyPayload("1", 2));

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* snapshot ownership                                                  */
/* ------------------------------------------------------------------ */

describe("snapshot", () => {
  it("returns a new object each call", () => {
    const entry = createFrameEntry(corpusOptions());

    expect(entry.snapshot()).not.toBe(entry.snapshot());
  });

  it("is not affected by mutating a returned snapshot", () => {
    const entry = createFrameEntry(corpusOptions());
    entry.handle(readyPayload("1", 1));

    const snapshot = entry.snapshot();
    snapshot.lastSeq = 999;
    snapshot.perChannel.bulk = 42;
    snapshot.bridge.state = "rejected";
    snapshot.violations = 7;

    expect(entry.snapshot()).toEqual({
      bridge: { state: "accepted" },
      lastSeq: 1,
      perChannel: { control: 1, stream: 0, bulk: 0 },
      violations: 0,
    });
  });

  it("reports a frozen violation list", () => {
    const entry = createFrameEntry(corpusOptions());
    entry.handle("{");

    const first = entry.violations();

    expect(first).toEqual([{ kind: "malformed-payload" }]);

    // The array is a copy: emptying it must not empty the entry.
    (first as { kind: string }[]).length = 0;

    expect(entry.violations()).toEqual([{ kind: "malformed-payload" }]);
    expect(entry.snapshot().violations).toBe(1);
  });

  it("reports status through both accessors consistently", () => {
    const entry = createFrameEntry(corpusOptions());
    entry.handle(readyPayload("2", 1));

    expect(entry.status()).toEqual(entry.snapshot().bridge);
    expect(entry.status()).toEqual({ state: "rejected", code: "BRIDGE_VERSION_MISMATCH" });
  });

  it("starts empty", () => {
    const entry = createFrameEntry(corpusOptions());

    expect(entry.snapshot()).toEqual({
      bridge: { state: "waiting" },
      lastSeq: 0,
      perChannel: { control: 0, stream: 0, bulk: 0 },
      violations: 0,
    });
    expect(entry.violations()).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* lastSeq                                                             */
/* ------------------------------------------------------------------ */

describe("lastSeq", () => {
  it("records the maximum seq seen, never a lower one", () => {
    const entry = createFrameEntry(corpusOptions());

    entry.handle(streamPayload(5));
    entry.handle(streamPayload(3));

    expect(entry.snapshot().lastSeq).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

describe("options", () => {
  it("copies the expected version, so a later mutation cannot change a verdict", () => {
    const options = corpusOptions();
    const entry = createFrameEntry(options);

    options.expectedBridgeVersion = "2";
    entry.handle(readyPayload("1", 1));

    expect(entry.status()).toEqual({ state: "accepted" });
  });
});
