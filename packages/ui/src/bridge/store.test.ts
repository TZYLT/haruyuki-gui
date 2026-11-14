/// <reference types="vite/client" />

/**
 * Tests for the external frame store.
 *
 * Requirement source: the React binding contract of `useSyncExternalStore`.
 * The corpus is the recorded one under `fixtures/bridge/`, read as raw text and
 * fed to the real `FrameEntry`, so these are not tests of a store in front of a
 * stub -- they run against the same payloads a socket delivers.
 *
 * Why the reference assertions use `toBe`
 *   `useSyncExternalStore` compares snapshots with `Object.is` on every render.
 *   A store that returned a fresh object per call would look changed every time,
 *   and React would re-render until it gave up with "The result of getSnapshot
 *   should be cached". `toEqual` would pass for exactly that broken store, so
 *   identity has to be asserted directly.
 *
 * Why `import.meta.glob` with `?raw` rather than `node:fs`
 *   `@haruyuki/ui` may not import a Node builtin (rule R4), and the bundler
 *   route is also closer to production: the entry's contract is a string
 *   payload, and the glob hands over strings.
 */

import { describe, expect, it, vi } from "vitest";

import { createFrameEntry } from "./entry.js";
import type { FrameEntry, FrameEntryOptions } from "./entry.js";
import { createFrameStore } from "./store.js";
import type { FrameStore } from "./store.js";

/* ------------------------------------------------------------------ */
/* corpus                                                              */
/* ------------------------------------------------------------------ */

/** Every bridge fixture, as raw text, keyed by the path the glob produced. */
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
 * @param name corpus member file name
 * @returns the non-header lines, in file order
 */
function framesOf(name: string): string[] {
  const entry = Object.entries(CORPUS).find(([path]) => path.endsWith(`/${name}`));

  if (entry === undefined) {
    throw new Error(`bridge corpus member ${name} was not collected by the glob`);
  }

  const lines = entry[1].split("\n").filter((line) => line.trim() !== "");

  // The first line is the frozen `kind: "frames"` header, not a frame.
  return lines.slice(1);
}

/** Options matching the corpus. */
function corpusOptions(overrides: Partial<FrameEntryOptions> = {}): FrameEntryOptions {
  return {
    expectedBridgeVersion: CORPUS_BRIDGE_VERSION,
    frameProtocolVersion: CORPUS_PROTOCOL_VERSION,
    ...overrides,
  };
}

/** A store plus the entry behind it, so a test can drive one and read the other. */
interface Harness {
  entry: FrameEntry;
  store: FrameStore;
}

/**
 * Build a harness over a fresh entry.
 *
 * @param options entry options; corpus defaults
 * @returns the entry and the store wrapping it
 */
function harness(options: FrameEntryOptions = corpusOptions()): Harness {
  const entry = createFrameEntry(options);

  return { entry, store: createFrameStore(entry) };
}

/** Feed every payload of one corpus member to a harness's entry. */
function playFixture(target: Harness, name: string): void {
  for (const payload of framesOf(name)) {
    target.entry.handle(payload);
  }
}

/* ------------------------------------------------------------------ */
/* reference stability                                                 */
/* ------------------------------------------------------------------ */

describe("getSnapshot reference stability", () => {
  it("returns the same reference on repeated reads with no change", () => {
    const { store } = harness();

    // The core correctness property, and the reason this store exists at all: a
    // fresh object per call is what makes `useSyncExternalStore` loop forever.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("keeps returning one reference while many payloads arrive", () => {
    const target = harness();

    playFixture(target, "three-channels.jsonl");

    // Reading is what materialises the cache; a second read must not rebuild it.
    const first = target.store.getSnapshot();

    expect(target.store.getSnapshot()).toBe(first);
  });

  it("returns a new reference after a change, and only once", () => {
    const target = harness();
    const before = target.store.getSnapshot();

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    const after = target.store.getSnapshot();

    // A change must be visible as a new object, or React would never re-render.
    expect(after).not.toBe(before);

    // ... and then the new object is itself stable.
    expect(target.store.getSnapshot()).toBe(after);
  });

  it("reflects the change in the new snapshot", () => {
    const target = harness();

    expect(target.store.getSnapshot()).toEqual({
      bridge: { state: "waiting" },
      lastSeq: 0,
      perChannel: { control: 0, stream: 0, bulk: 0 },
      violations: 0,
    });

    playFixture(target, "three-channels.jsonl");

    expect(target.store.getSnapshot()).toEqual(target.entry.snapshot());
    expect(target.store.getSnapshot().perChannel).toEqual({ control: 1, stream: 4, bulk: 2 });
    expect(target.store.getSnapshot().bridge.state).toBe("accepted");
  });

  it("iterates: every payload that changes something yields exactly one new reference", () => {
    const target = harness();
    const seen = new Set<object>([target.store.getSnapshot()]);

    for (const payload of framesOf("handshake-accept.jsonl")) {
      target.entry.handle(payload);
      seen.add(target.store.getSnapshot());
    }

    // Three payloads, three distinct snapshots (the fifth read of a given state
    // would repeat the previous reference, which the set would hide). The point
    // is that a change is not silently flattened into the old object.
    expect(seen.size).toBe(4);
  });

  it("gives two stores over the same entry their own caches", () => {
    const target = harness();
    const twin = createFrameStore(target.entry);

    // Independent caches are not an optimisation detail: two consumers created
    // at different times must be able to read the same state.
    expect(twin.getSnapshot()).not.toBe(target.store.getSnapshot());
    expect(twin.getSnapshot()).toEqual(target.store.getSnapshot());
  });
});

/* ------------------------------------------------------------------ */
/* subscription                                                        */
/* ------------------------------------------------------------------ */

describe("subscribe", () => {
  it("calls a listener after a change", () => {
    const target = harness();
    const listener = vi.fn();

    target.store.subscribe(listener);

    // No call on subscription itself: a consumer reads the snapshot instead.
    expect(listener).not.toHaveBeenCalled();

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not call a listener when a payload changes nothing", () => {
    const target = harness();
    const listener = vi.fn();

    playFixture(target, "version-mismatch.jsonl");
    target.store.subscribe(listener);

    // The entry is rejected and silent after the verdict, so the ledger cannot
    // grow and neither can the notification count.
    for (const payload of framesOf("three-channels.jsonl").slice(1)) {
      target.entry.handle(payload);
    }

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops calling a listener after it unsubscribes", () => {
    const target = harness();
    const listener = vi.fn();

    const unsubscribe = target.store.subscribe(listener);

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    target.entry.handle(framesOf("handshake-accept.jsonl")[1] as string);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("tolerates unsubscribing twice", () => {
    const target = harness();
    const listener = vi.fn();

    const unsubscribe = target.store.subscribe(listener);
    unsubscribe();

    // The second call is a no-op rather than an error, because React may tear
    // down the same subscription through two paths.
    expect(() => unsubscribe()).not.toThrow();

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);
    expect(listener).not.toHaveBeenCalled();
  });

  it("calls every listener registered at the moment of the change", () => {
    const target = harness();
    const first = vi.fn();
    const second = vi.fn();
    const third = vi.fn();

    target.store.subscribe(first);
    target.store.subscribe(second);
    target.store.subscribe(third);

    playFixture(target, "bulk-single-page.jsonl");

    // Two payloads that change something (ready and the page), so two
    // notifications each.
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
    expect(third).toHaveBeenCalledTimes(2);
  });

  it("contains a throwing listener so the others still run", () => {
    const target = harness();
    const before = vi.fn();
    const after = vi.fn();

    target.store.subscribe(before);
    target.store.subscribe(() => {
      throw new Error("listener bug");
    });
    target.store.subscribe(after);

    expect(() =>
      target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string),
    ).not.toThrow();

    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("lets a listener read the new state during the notification", () => {
    const target = harness();
    const observed: number[] = [];

    target.store.subscribe(() => {
      // The cache is invalidated before listeners run, so a read inside one sees
      // the change, not the snapshot from before it.
      observed.push(target.store.getSnapshot().perChannel.stream);
    });

    playFixture(target, "coalesce.jsonl");

    // The fixture is ready, two stream frames, a third stream frame, then a bulk
    // page: the counter climbs to 3 and the page that follows changes the
    // snapshot without changing this channel, which is why the last entry
    // repeats.
    expect(observed).toEqual([0, 1, 2, 3, 3]);
  });

  it("gives every listener in one notification the same new reference", () => {
    const target = harness();
    const seen: object[] = [];

    target.store.subscribe(() => {
      seen.push(target.store.getSnapshot());
    });
    target.store.subscribe(() => {
      seen.push(target.store.getSnapshot());
    });

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("does not skip listeners when one unsubscribes another during a notification", () => {
    const target = harness();
    const calls: string[] = [];

    const unsubscribeSecond = target.store.subscribe(() => {
      calls.push("second");
    });

    target.store.subscribe(() => {
      calls.push("first");
      unsubscribeSecond();
    });

    target.store.subscribe(() => {
      calls.push("third");
    });

    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    // Everyone registered when the notification began is called once; the
    // removal takes effect for the next change.
    expect(calls).toEqual(["second", "first", "third"]);

    target.entry.handle(framesOf("handshake-accept.jsonl")[1] as string);

    expect(calls).toEqual(["second", "first", "third", "first", "third"]);
  });
});

/* ------------------------------------------------------------------ */
/* laziness and lifetime                                               */
/* ------------------------------------------------------------------ */

describe("cache behaviour", () => {
  it("does not read the entry until somebody reads the store", () => {
    const entry = createFrameEntry(corpusOptions());
    const snapshot = vi.spyOn(entry, "snapshot");

    const store = createFrameStore(entry);

    expect(snapshot).not.toHaveBeenCalled();

    store.getSnapshot();

    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it("coalesces several changes into one rebuild on the next read", () => {
    const target = harness();

    target.store.getSnapshot();

    const counted = vi.spyOn(target.entry, "snapshot");

    // Three changes with no read in between: the cache is already invalid, and
    // re-invalidating it must not do the work early.
    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);
    target.entry.handle(framesOf("handshake-accept.jsonl")[1] as string);
    target.entry.handle(framesOf("handshake-accept.jsonl")[2] as string);

    expect(counted).not.toHaveBeenCalled();

    target.store.getSnapshot();

    expect(counted).toHaveBeenCalledTimes(1);
  });

  it("keeps the cache current even while nothing is subscribed", () => {
    const target = harness();

    target.store.getSnapshot();

    // No listener at all: an unmounted tree is the normal case, and the next
    // mount reads before React has subscribed, so the cache must still see this.
    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    expect(target.store.getSnapshot().bridge.state).toBe("accepted");
  });

  it("reports a store per entry, not a singleton", () => {
    const first = harness();
    const second = harness();

    playFixture(first, "three-channels.jsonl");

    expect(first.store.getSnapshot().perChannel.bulk).toBe(2);
    expect(second.store.getSnapshot().perChannel.bulk).toBe(0);
  });
});
