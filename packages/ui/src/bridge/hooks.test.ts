/// <reference types="vite/client" />

/**
 * Tests for the React bindings over the frame store.
 *
 * Requirement source: `useSyncExternalStore`'s contract, exercised through
 * `renderHook` so the assertions run the same path a component does -- render,
 * subscribe, notify, re-read -- rather than calling the hooks in a vacuum. The
 * state is driven by real payloads from the recorded corpus, so a re-render is
 * caused by a frame and not by a mock.
 *
 * Why the corpus is read with `import.meta.glob` and `?raw`
 *   `@haruyuki/ui` may not import a Node builtin (rule R4), so the fixture text
 *   reaches this test through the bundler. The entry's contract is a string
 *   payload, and the glob hands over strings, which is also what a socket does.
 *
 * Why there is a server-render test
 *   The third `useSyncExternalStore` argument is easy to omit and impossible to
 *   notice while the tests only ever run in a DOM. Rendering through
 *   `renderToString` is what fails when it is missing, so the claim in the
 *   implementation's comment is asserted here rather than trusted.
 *
 * Why `createElement` rather than JSX
 *   This file is `.ts`: JSX is syntax that the TypeScript compiler only accepts
 *   in `.tsx` (`TS17004`), and the module surface is fixed by the work package.
 */

// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createFrameEntry } from "./entry.js";
import type { FrameEntry, FrameEntryOptions } from "./entry.js";
import { useFrameChannel, useFrameSnapshot } from "./hooks.js";
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

/**
 * Offer one payload the way a host would: inside `act`, so React flushes the
 * subscription notification before the assertion reads the result.
 *
 * @param target the harness to drive
 * @param payload one raw frame
 */
function drive(target: Harness, payload: string): void {
  act(() => {
    target.entry.handle(payload);
  });
}

/**
 * Offer every payload of one corpus member, each in its own `act`, so the
 * intermediate states are flushed the way a live socket would flush them.
 *
 * @param target the harness to drive
 * @param name corpus member file name
 */
function playFixture(target: Harness, name: string): void {
  for (const payload of framesOf(name)) {
    drive(target, payload);
  }
}

/* ------------------------------------------------------------------ */
/* useFrameSnapshot                                                    */
/* ------------------------------------------------------------------ */

describe("useFrameSnapshot", () => {
  it("returns the store's current snapshot on the first render", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameSnapshot(target.store));

    expect(result.current).toEqual({
      bridge: { state: "waiting" },
      lastSeq: 0,
      perChannel: { control: 0, stream: 0, bulk: 0 },
      violations: 0,
    });

    // The hook must hand back the store's object, not a copy: a copy per render
    // is the infinite-loop defect the store exists to prevent.
    expect(result.current).toBe(target.store.getSnapshot());
  });

  it("re-renders with the new value after a frame is handled", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameSnapshot(target.store));

    drive(target, framesOf("handshake-accept.jsonl")[0] as string);

    expect(result.current.bridge.state).toBe("accepted");
    expect(result.current.perChannel.control).toBe(1);
    expect(result.current.lastSeq).toBe(1);
  });

  it("re-renders at every change of a whole fixture", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameSnapshot(target.store));

    playFixture(target, "three-channels.jsonl");

    // The fixture's own shape, read through the hook: one control ready, four
    // stream frames and two bulk pages.
    expect(result.current.perChannel).toEqual({ control: 1, stream: 4, bulk: 2 });
    expect(result.current.lastSeq).toBe(4);
    expect(result.current.bridge).toEqual({ state: "accepted" });
    expect(result.current).toEqual(target.entry.snapshot());
  });

  it("keeps the same reference across renders that change nothing", () => {
    const target = harness();
    const { result, rerender } = renderHook(() => useFrameSnapshot(target.store));
    const first = result.current;

    rerender();

    // A re-render caused by the parent must not produce a new snapshot, or every
    // consumer below it would re-render for no reason.
    expect(result.current).toBe(first);
  });

  it("reflects a rejected handshake", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameSnapshot(target.store));

    playFixture(target, "version-mismatch.jsonl");

    expect(result.current.bridge).toEqual({
      state: "rejected",
      code: "BRIDGE_VERSION_MISMATCH",
    });

    // Silent after the reject: the counter does not follow the peer.
    expect(result.current.perChannel.control).toBe(1);
  });

  it("does not warn about an uncached snapshot when a change predates the mount", () => {
    const target = harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // Swallowed so the assertion below is the verdict, not printed noise.
    });

    // A change between the first read and the mount is exactly the case a
    // `useEffect`-based store misses; `useSyncExternalStore` must not.
    target.store.getSnapshot();
    target.entry.handle(framesOf("handshake-accept.jsonl")[0] as string);

    const { result } = renderHook(() => useFrameSnapshot(target.store));

    expect(result.current.perChannel.control).toBe(1);
    expect(errors).not.toHaveBeenCalled();

    errors.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* useFrameChannel                                                     */
/* ------------------------------------------------------------------ */

describe("useFrameChannel", () => {
  it("returns the channel's current count", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameChannel(target.store, "bulk"));

    expect(result.current).toBe(0);
  });

  it("updates when that channel's count changes", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameChannel(target.store, "stream"));

    drive(target, framesOf("coalesce.jsonl")[1] as string);

    expect(result.current).toBe(1);
  });

  it("does not re-render when a different channel changes", () => {
    const target = harness();
    let renders = 0;
    let observed = -1;

    renderHook(() => {
      renders += 1;
      observed = useFrameChannel(target.store, "bulk");
    });

    const afterMount = renders;

    // Only stream frames: the bulk counter never moves, so this consumer must
    // not render again. `coalesce.jsonl`'s control frame and its three stream
    // frames are exactly that case.
    for (const payload of framesOf("coalesce.jsonl").slice(0, 4)) {
      drive(target, payload);
    }

    expect(observed).toBe(0);
    expect(renders).toBe(afterMount);

    // The proof that it is a real subscription and not a dead one: the channel
    // it does watch moves, and the consumer renders.
    drive(target, framesOf("coalesce.jsonl")[4] as string);

    expect(observed).toBe(1);
    expect(renders).toBeGreaterThan(afterMount);
  });

  it("counts only the channel it was given, over a full fixture", () => {
    const target = harness();
    const bulkHook = renderHook(() => useFrameChannel(target.store, "bulk"));
    const streamHook = renderHook(() => useFrameChannel(target.store, "stream"));
    const controlHook = renderHook(() => useFrameChannel(target.store, "control"));

    playFixture(target, "three-channels.jsonl");

    expect(controlHook.result.current).toBe(1);
    expect(streamHook.result.current).toBe(4);
    expect(bulkHook.result.current).toBe(2);
  });

  it("stays on the last value after a rejected handshake stops the counters", () => {
    const target = harness();
    const { result } = renderHook(() => useFrameChannel(target.store, "control"));

    playFixture(target, "version-mismatch.jsonl");
    const afterReject = result.current;

    for (const payload of framesOf("three-channels.jsonl").slice(1)) {
      drive(target, payload);
    }

    expect(result.current).toBe(afterReject);
    expect(result.current).toBe(1);
  });

  it("follows the store when the channel argument changes", () => {
    const target = harness();
    playFixture(target, "three-channels.jsonl");

    const { result, rerender } = renderHook(
      (props: { channel: "bulk" | "stream" }) => useFrameChannel(target.store, props.channel),
      { initialProps: { channel: "bulk" } },
    );

    expect(result.current).toBe(2);

    rerender({ channel: "stream" });

    // A new channel means a new selector, so the hook re-reads rather than
    // keeping the previous channel's number.
    expect(result.current).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* lifetime                                                            */
/* ------------------------------------------------------------------ */

describe("unmounting", () => {
  it("unsubscribes from the store and stops updating", () => {
    const target = harness();
    const unsubscribed = vi.fn();
    const subscribe = target.store.subscribe.bind(target.store);

    // Wrapping `subscribe` is the only way to see the teardown React performs
    // from outside: `useSyncExternalStore` calls the returned function on
    // unmount, and a store that never saw it would be a leak.
    const spy = vi.spyOn(target.store, "subscribe").mockImplementation((listener: () => void) => {
      const unsubscribe = subscribe(listener);

      return () => {
        unsubscribed();
        unsubscribe();
      };
    });

    const { result, unmount } = renderHook(() => useFrameSnapshot(target.store));
    const last = result.current;

    expect(spy).toHaveBeenCalled();

    unmount();

    expect(unsubscribed).toHaveBeenCalled();

    // Frames arriving after the tree is gone must not reach it.
    playFixture(target, "three-channels.jsonl");

    expect(result.current).toBe(last);

    spy.mockRestore();
  });

  it("leaves no update-after-unmount warning", () => {
    const target = harness();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      // Collected, not printed; the assertion below is the verdict.
    });

    const { unmount } = renderHook(() => useFrameChannel(target.store, "bulk"));

    unmount();

    playFixture(target, "three-channels.jsonl");

    expect(errors).not.toHaveBeenCalled();

    errors.mockRestore();
  });
});

/* ------------------------------------------------------------------ */
/* server rendering                                                    */
/* ------------------------------------------------------------------ */

describe("server rendering", () => {
  it("renders through renderToString rather than throwing about a missing server snapshot", () => {
    const target = harness();
    playFixture(target, "handshake-accept.jsonl");

    /**
     * A page reading both hooks, so the server path is exercised for each.
     *
     * @returns the rendered node
     */
    function Page(): ReactElement {
      const value = useFrameSnapshot(target.store);
      const bulk = useFrameChannel(target.store, "bulk");

      return createElement("span", null, `${value.bridge.state}:${value.lastSeq}:${bulk}`);
    }

    // Without a `getServerSnapshot`, React throws here instead of returning
    // markup. The three payloads are a ready, an accept and a page, so the
    // counters and `lastSeq` are all non-zero and the assertion is not trivially
    // satisfied by the initial state.
    const markup = renderToString(createElement(Page));

    expect(markup).toContain("accepted:3:1");
  });
});
