/**
 * The view state table, pinned from four sides.
 *
 * The failure this suite is written against is a table keyed by the conversation
 * instead of by the tab. It is a one-word change, it type-checks, every simple
 * round trip still passes, and its only symptom is what the user sees: two tabs
 * on one conversation share one scroll position and overwrite each other. So the
 * tabs below carry their conversation in their instance id (`conv#tab`), and the
 * central assertion reads two of those back independently. Keying by conversation
 * is then a red test here rather than a bug report later - which is also how the
 * mutation was verified.
 *
 * The other three sides are the ones a table like this can get wrong quietly:
 * a release that forgets to decrement, a bound that is declared but not enforced,
 * and an eviction that removes *an* entry rather than *the oldest* one.
 */

import type { ViewState } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { VIEW_STATE_LIMIT, createViewStateStore } from "./view-state.js";

/**
 * A tab instance id for a tab on a conversation.
 *
 * The store only ever receives an instance id; the conversation is part of it
 * here so that a table reading the prefix instead of the whole string - the
 * mutation this suite exists to catch - collides two tabs that must not collide.
 */
function tab(conversationId: string, name: string): string {
  return `${conversationId}#${name}`;
}

/** A state anchored at one id, with the groups named in `collapsed`. */
function state(anchorId: string, offset: number, collapsed: readonly string[] = []): ViewState {
  return { anchor: { id: anchorId, offset }, collapsed };
}

describe("view state: isolation", () => {
  it("keeps two tabs on different conversations apart", () => {
    const store = createViewStateStore();

    store.set(tab("conv-a", "left"), state("block-a1", 120));
    store.set(tab("conv-b", "left"), state("block-b1", 0));

    expect(store.get(tab("conv-a", "left"))).toEqual(state("block-a1", 120));
    expect(store.get(tab("conv-b", "left"))).toEqual(state("block-b1", 0));
    expect(store.size).toBe(2);
  });

  it("keeps two tabs on the same conversation apart", () => {
    const store = createViewStateStore();

    // Same conversation, two tabs: the user ruling is that each remembers its
    // own position. A conversation-keyed table returns the second value twice.
    const first = tab("conv-shared", "first");
    const second = tab("conv-shared", "second");

    store.set(first, state("block-1", 10, ["group-1"]));
    store.set(second, state("block-9", 640, ["group-2", "group-3"]));

    expect(store.get(first)).toEqual(state("block-1", 10, ["group-1"]));
    expect(store.get(second)).toEqual(state("block-9", 640, ["group-2", "group-3"]));
    expect(store.size).toBe(2);

    // Updating one must not move the other either.
    store.set(first, state("block-2", 20));
    expect(store.get(first)).toEqual(state("block-2", 20));
    expect(store.get(second)).toEqual(state("block-9", 640, ["group-2", "group-3"]));
  });

  it("hands back the value it was given, not a rewrite", () => {
    const store = createViewStateStore();
    const written: ViewState = state("block-1", 10, ["group-1"]);

    store.set(tab("conv-a", "left"), written);

    // Identity, not merely equality: this table stores state, it does not own a
    // second opinion about what that state is.
    expect(store.get(tab("conv-a", "left"))).toBe(written);
  });

  it("returns null for a tab that never wrote anything", () => {
    const store = createViewStateStore();

    expect(store.get(tab("conv-a", "unknown"))).toBeNull();
  });
});

describe("view state: release", () => {
  it("drops one entry and leaves the rest alone", () => {
    const store = createViewStateStore();

    store.set(tab("conv-a", "left"), state("block-a1", 0));
    store.set(tab("conv-b", "left"), state("block-b1", 0));
    expect(store.size).toBe(2);

    store.release(tab("conv-a", "left"));

    expect(store.size).toBe(1);
    expect(store.get(tab("conv-a", "left"))).toBeNull();
    expect(store.get(tab("conv-b", "left"))).toEqual(state("block-b1", 0));
  });

  it("treats releasing an unknown instance id as a no-op", () => {
    const store = createViewStateStore();

    store.set(tab("conv-a", "left"), state("block-a1", 0));
    store.release(tab("conv-a", "never-written"));

    expect(store.size).toBe(1);
    // A release is not a use, so it evicts nothing and changes no recency.
    expect(store.evicted).toBe(0);
  });

  it("forgets everything a released tab had, including its recency", () => {
    const store = createViewStateStore(2);

    store.set(tab("conv-a", "left"), state("block-a1", 0));
    store.set(tab("conv-a", "right"), state("block-a2", 0));
    store.release(tab("conv-a", "left"));

    // The table is not over its bound, so nothing was evicted on the way out.
    expect(store.size).toBe(1);
    expect(store.evicted).toBe(0);

    store.set(tab("conv-b", "left"), state("block-b1", 0));

    // A release frees a slot rather than counting as an eviction; otherwise
    // every tab close would read as a leak in the diagnostic count.
    expect(store.size).toBe(2);
    expect(store.evicted).toBe(0);
    expect(store.get(tab("conv-b", "left"))).toEqual(state("block-b1", 0));
  });
});

describe("view state: bound and least-recently-used eviction", () => {
  it("defaults to the documented bound", () => {
    const store = createViewStateStore();

    for (let index = 0; index < VIEW_STATE_LIMIT + 5; index += 1) {
      store.set(tab("conv-a", `tab-${String(index)}`), state(`block-${String(index)}`, index));
    }

    expect(store.size).toBe(VIEW_STATE_LIMIT);
    expect(store.evicted).toBe(5);
  });

  it("evicts the oldest entries, not arbitrary ones", () => {
    const store = createViewStateStore();

    const ids = Array.from({ length: VIEW_STATE_LIMIT + 5 }, (_unused, index) =>
      tab("conv-a", `tab-${String(index)}`),
    );
    for (const [index, id] of ids.entries()) {
      store.set(id, state(`block-${String(index)}`, index));
    }

    // The first five went, in order; the rest are still readable.
    for (const [index, id] of ids.entries()) {
      if (index < 5) {
        expect(store.get(id)).toBeNull();
      } else {
        expect(store.get(id)).toEqual(state(`block-${String(index)}`, index));
      }
    }
    expect(store.evicted).toBe(5);
  });

  it("refreshes recency on a read, so the touched entry survives the next eviction", () => {
    const store = createViewStateStore();

    const ids = Array.from({ length: VIEW_STATE_LIMIT }, (_unused, index) =>
      tab("conv-a", `tab-${String(index)}`),
    );
    for (const [index, id] of ids.entries()) {
      store.set(id, state(`block-${String(index)}`, index));
    }
    expect(store.size).toBe(VIEW_STATE_LIMIT);

    // Second oldest is the one about to age out; reading it is using it.
    const touched = ids[1];
    const oldest = ids[0];
    expect(touched).toBeDefined();
    expect(oldest).toBeDefined();
    if (touched === undefined || oldest === undefined) {
      throw new Error("test fixture is too small");
    }
    store.get(touched);

    store.set(tab("conv-a", "extra"), state("block-extra", 0));

    // Red if the read did not refresh the order: the table would evict
    // `touched` (the second oldest) instead of `oldest`.
    expect(store.evicted).toBe(1);
    expect(store.get(oldest)).toBeNull();
    expect(store.get(touched)).toEqual(state("block-1", 1));
    expect(store.size).toBe(VIEW_STATE_LIMIT);

    // And the next eviction takes the following oldest, so the refresh moved one
    // key rather than exempting it forever.
    const following = ids[2];
    if (following === undefined) {
      throw new Error("test fixture is too small");
    }
    store.set(tab("conv-a", "extra-2"), state("block-extra-2", 0));
    expect(store.evicted).toBe(2);
    expect(store.get(following)).toBeNull();
    expect(store.get(touched)).toEqual(state("block-1", 1));
  });

  it("refreshes recency when an existing entry is updated", () => {
    const store = createViewStateStore(3);

    const [first, second, third] = [tab("c", "1"), tab("c", "2"), tab("c", "3")];
    store.set(first, state("block-1", 0));
    store.set(second, state("block-2", 0));
    store.set(third, state("block-3", 0));

    // `first` is the oldest; writing it again must make `second` the oldest.
    store.set(first, state("block-1", 42));
    store.set(tab("c", "4"), state("block-4", 0));

    expect(store.evicted).toBe(1);
    expect(store.get(second)).toBeNull();
    expect(store.get(first)).toEqual(state("block-1", 42));
    expect(store.size).toBe(3);
  });

  it("honours a caller's bound rather than the default", () => {
    const store = createViewStateStore(2);

    for (const name of ["1", "2", "3", "4"]) {
      store.set(tab("conv-a", name), state(`block-${name}`, 0));
    }

    // Red against an unbounded implementation: the table would hold four.
    expect(store.size).toBe(2);
    expect(store.evicted).toBe(2);
    expect(store.get(tab("conv-a", "1"))).toBeNull();
    expect(store.get(tab("conv-a", "2"))).toBeNull();
    expect(store.get(tab("conv-a", "4"))).toEqual(state("block-4", 0));
  });

  it("corrects a nonsense bound instead of evicting on every write", () => {
    for (const bound of [0, -1, 2.5, Number.NaN]) {
      const store = createViewStateStore(bound);

      store.set(tab("conv-a", "left"), state("block-a1", 0));
      store.set(tab("conv-a", "right"), state("block-a2", 0));

      expect(store.size).toBe(2);
      expect(store.evicted).toBe(0);
      expect(VIEW_STATE_LIMIT).toBeGreaterThan(2);
    }
  });

  it("counts every eviction, including a long run of writes", () => {
    const store = createViewStateStore(4);

    for (let index = 0; index < 40; index += 1) {
      store.set(tab("conv-a", `tab-${String(index)}`), state(`block-${String(index)}`, index));
    }

    // 40 writes, a bound of 4: 36 entries left by eviction, and nothing else
    // could have removed them.
    expect(store.size).toBe(4);
    expect(store.evicted).toBe(36);
  });
});
