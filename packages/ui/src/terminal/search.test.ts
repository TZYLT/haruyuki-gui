/**
 * Tests for the search bar's model.
 *
 * What is under test
 *   Not `@xterm/addon-search`. What is under test is the translation this package
 *   owns: the addon answers three questions through one boolean and one event, and
 *   the three answers are only distinguishable here. So the fixture below is a
 *   fake that reproduces the two behaviours that make the translation necessary,
 *   both read from the addon's own source rather than assumed:
 *
 *   - `findNext`/`findPrevious` fire their result event **synchronously**, before
 *     returning. The model reads the counters after the call returns, and that is
 *     only sound because of this ordering.
 *   - the result event fires **only** when the search options carry a
 *     `decorations` object. A model that dropped it would have no counts at all
 *     while the highlighting kept working.
 *
 *   The fixture is written to reject a model that gets either wrong: it withholds
 *   the event when no decorations are present, and it reports `-1` for an
 *   unselected match, so an implementation that assumed 0 fails a case instead of
 *   rendering "Match -1 of 3".
 */

import { describe, expect, it, vi } from "vitest";

import type { ISearchOptions } from "@xterm/addon-search";

import { en } from "../i18n/locales/en.js";
import { createTerminalSearch, DEFAULT_HIGHLIGHT_LIMIT, positionMessage } from "./search.js";
import type { SearchPosition, SearchPositionMessage, TerminalSearchAddon } from "./search.js";

/**
 * The position a non-empty step carries.
 *
 * `SearchStep` has an `empty` arm with no position, and reaching for `.position`
 * on a step typed as the union is a type error -- which is the type earning its
 * keep. These cases always search a non-empty term, so the assertion fails loudly
 * if one ever becomes empty instead of silently reading nothing.
 */
function positionOf(step: {
  readonly kind: string;
  readonly position?: SearchPosition;
}): SearchPosition {
  if (step.position === undefined) throw new Error(`step has no position: ${step.kind}`);

  return step.position;
}

/**
 * The values a position message carries.
 *
 * The `null` arm has none, so reaching for `.values` on the union is a type
 * error -- which is the union earning its keep. Every case that calls this has
 * already asserted the key is non-null.
 *
 * @param message the message
 * @returns its interpolation values
 */
function valuesOf(message: SearchPositionMessage): { index: number; count: number } {
  if (message.key === null) throw new Error("message has no key");

  return message.values as { index: number; count: number };
}

/** One result-set report, as the addon emits it. */
interface Reported {
  readonly resultIndex: number;
  readonly resultCount: number;
}

/**
 * A search addon double that behaves like the real one where it matters.
 *
 * It records the options it was called with so a case can assert that
 * `decorations` was present -- the failure mode being silent, the assertion has to
 * be explicit rather than inferred from a count that happens to work.
 */
function fakeAddon(): TerminalSearchAddon & {
  setResults(results: Reported): void;
  readonly calls: { term: string; options?: ISearchOptions }[];
  readonly cleared: number;
  readonly listenerCount: number;
} {
  const listeners = new Set<(event: Reported) => void>();
  const calls: { term: string; options?: ISearchOptions }[] = [];
  let pending: Reported = { resultIndex: -1, resultCount: 0 };
  let cleared = 0;

  /**
   * Report a result set the way the addon does, gated on decorations.
   *
   * @param options the options the caller passed
   */
  const report = (options?: ISearchOptions): void => {
    // The real addon returns early from `fireResultsChanged` when decorations are
    // absent, so a model that forgot them would see nothing here.
    if (options?.decorations === undefined) return;

    for (const listener of listeners) listener(pending);
  };

  return {
    // Shaped like xterm's `IEvent`: it returns an `IDisposable`, not a bare
    // unsubscribe function. Matching the real signature is what lets the double
    // stand in for a `SearchAddon` without a cast.
    onDidChangeResults: (listener: (event: Reported) => void) => {
      listeners.add(listener);

      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    },

    findNext: (term: string, options?: ISearchOptions) => {
      calls.push({ term, options });
      report(options);

      return pending.resultCount > 0 && pending.resultIndex >= 0;
    },

    findPrevious: (term: string, options?: ISearchOptions) => {
      calls.push({ term, options });
      report(options);

      return pending.resultCount > 0 && pending.resultIndex >= 0;
    },

    clearDecorations: () => {
      cleared += 1;
    },

    /** Arrange the next result set the addon will report. */
    setResults(results: Reported) {
      pending = results;
    },

    get calls() {
      return calls;
    },

    get cleared() {
      return cleared;
    },

    get listenerCount() {
      return listeners.size;
    },
  };
}

describe("a step reports where it went, not merely whether it moved", () => {
  it("reports the position the addon published, because the boolean cannot express 'twelve exist and I am on the twelfth'", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: 11, resultCount: 12 });

    const step = search.findNext("x");

    expect(step).toEqual({
      kind: "found",
      position: { kind: "at", index: 11, count: 12, capped: false },
    });
  });

  it("reports no match as 'none' rather than as a failed step, because nothing was found and nothing went wrong", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: -1, resultCount: 0 });

    const step = search.findNext("absent");

    expect(step).toEqual({ kind: "exhausted", position: { kind: "none" } });
  });

  it("reports an unselected match set as unanchored rather than as match zero, because -1 is not a position", () => {
    // The addon reports `resultIndex: -1` when it has no selected decoration. A
    // model that clamped it to 0 would tell the user they are on the first match
    // while the terminal highlights none.
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: -1, resultCount: 7 });

    const step = search.findNext("x");

    expect(step).toEqual({
      kind: "exhausted",
      position: { kind: "unanchored", count: 7, capped: false },
    });
  });

  it("tells 'the search refused to move' apart from 'nothing matched', because only one of them means the term is absent", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);

    addon.setResults({ resultIndex: -1, resultCount: 0 });
    const absent = search.findNext("absent");

    addon.setResults({ resultIndex: 4, resultCount: 5 });
    const moved = search.findNext("present");

    expect(positionOf(absent)).toEqual({ kind: "none" });
    expect(positionOf(moved)).not.toEqual({ kind: "none" });
    expect(positionOf(moved)).toMatchObject({ count: 5 });
  });

  it("searches backward through the same path, so the two arrows cannot disagree about what a match is", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: 2, resultCount: 6 });

    const step = search.findPrev("x");

    expect(positionOf(step)).toMatchObject({ kind: "at", index: 2, count: 6 });
  });
});

describe("the count is a lower bound at the addon's ceiling", () => {
  it("marks a count that reached the ceiling, because a saturated count and an exact one look identical", () => {
    // The addon stops collecting at its highlight limit, so 1000 can mean "1000"
    // or "more than 1000". A panel that printed it plainly would be printing a
    // number the user can disprove by pressing the down arrow.
    const addon = fakeAddon();
    const search = createTerminalSearch(addon, { highlightLimit: 1000 });
    addon.setResults({ resultIndex: 0, resultCount: 1000 });

    expect(positionOf(search.findNext("x"))).toMatchObject({ count: 1000, capped: true });
  });

  it("leaves a count below the ceiling uncapped, so only the saturated case is hedged", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon, { highlightLimit: 1000 });
    addon.setResults({ resultIndex: 0, resultCount: 999 });

    expect(positionOf(search.findNext("x"))).toMatchObject({ count: 999, capped: false });
  });

  it("uses the ceiling it was told, not the default, because the addon takes it as a constructor option", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon, { highlightLimit: 50 });
    addon.setResults({ resultIndex: 0, resultCount: 50 });

    expect(positionOf(search.findNext("x"))).toMatchObject({ capped: true });
    expect(DEFAULT_HIGHLIGHT_LIMIT).toBe(1000);
  });

  it("rejects a ceiling that could never mark anything, instead of silently never hedging", () => {
    expect(() => createTerminalSearch(fakeAddon(), { highlightLimit: 0 })).toThrow(RangeError);
    expect(() => createTerminalSearch(fakeAddon(), { highlightLimit: -1 })).toThrow(RangeError);
    expect(() => createTerminalSearch(fakeAddon(), { highlightLimit: Number.NaN })).toThrow(
      RangeError,
    );
  });
});

describe("the result event only arrives when decorations are requested", () => {
  it("passes a decorations object on every search, because without it the addon never reports a count", () => {
    // This is the whole reason the model exists. The real addon returns early from
    // its own result notification when decorations are absent, so the search
    // highlights correctly and the count silently never updates.
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);

    search.findNext("x");
    search.findPrev("x");

    expect(addon.calls).toHaveLength(2);

    for (const call of addon.calls) {
      expect(call.options?.decorations).toBeDefined();
    }
  });

  it("passes decorations on every single call, not just the first, because a search that stops reporting mid-session is worse than one that never did", () => {
    // The variant this pins is the subtle one: a caller that maintains its own
    // counters and passes decorations only on the first search would keep working
    // -- and would be the second source of truth this module exists to avoid.
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);

    for (const term of ["a", "b", "c"]) search.findNext(term);
    for (const term of ["a", "b", "c"]) search.findPrev(term);

    expect(addon.calls).toHaveLength(6);

    for (const [index, call] of addon.calls.entries()) {
      expect(call.options?.decorations, `call ${index}`).toBeDefined();
    }
  });

  it("forwards the case and word options it was built with, because a search that ignores them finds the wrong thing", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon, { caseSensitive: true, wholeWord: true });

    search.findNext("Needle");

    expect(addon.calls[0]?.options).toMatchObject({ caseSensitive: true, wholeWord: true });
  });

  it("defaults to case-insensitive and substring matching, because that is what a find box does", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);

    search.findNext("needle");

    expect(addon.calls[0]?.options).toMatchObject({ caseSensitive: false, wholeWord: false });
  });

  it("lets the theme supply the match colours, because a colour constant here would be invisible on one of the two themes", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon, {
      decorations: { matchBackground: "#ff0", activeMatchBackground: "#0ff" },
    });

    search.findNext("x");

    expect(addon.calls[0]?.options?.decorations).toMatchObject({
      matchBackground: "#ff0",
      activeMatchBackground: "#0ff",
    });
  });
});

describe("closing the bar clears the decorations", () => {
  it("clears them, because they are painted into the terminal and outlive the bar", () => {
    // The user closes the bar and the yellow blocks stay behind, with no control
    // left that removes them. That is the failure this case pins.
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: 0, resultCount: 3 });
    search.findNext("x");

    search.clear();

    expect(addon.cleared).toBe(1);
  });

  it("returns to idle rather than to the previous count, because a closed bar has no count to show", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: 0, resultCount: 3 });
    search.findNext("x");

    search.clear();

    expect(search.position).toEqual({ kind: "idle" });
  });

  it("clears the decorations when the term is emptied, because deleting the query means the same thing as closing the bar", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    addon.setResults({ resultIndex: 0, resultCount: 3 });
    search.findNext("x");

    const step = search.findNext("");

    expect(step).toEqual({ kind: "empty" });
    expect(addon.cleared).toBe(1);
    expect(search.position).toEqual({ kind: "idle" });
  });

  it("does not search for an empty term, because the addon would leave the old decorations painted", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);

    search.findNext("");

    expect(addon.calls).toHaveLength(0);
  });
});

describe("subscribers see every change", () => {
  it("notifies each listener with the new position, because the panel renders from it", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    const seen: SearchPosition[] = [];

    search.onDidChange((position) => seen.push(position));
    addon.setResults({ resultIndex: 1, resultCount: 4 });
    search.findNext("x");

    expect(seen).toEqual([{ kind: "at", index: 1, count: 4, capped: false }]);
  });

  it("stops notifying after unsubscribing, because a closed bar must not keep a listener alive", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    const listener = vi.fn();
    const unsubscribe = search.onDidChange(listener);

    unsubscribe();
    addon.setResults({ resultIndex: 0, resultCount: 1 });
    search.findNext("x");

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports more than one listener, and unsubscribing one leaves the other", () => {
    const addon = fakeAddon();
    const search = createTerminalSearch(addon);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = search.onDidChange(first);
    search.onDidChange(second);
    unsubscribeFirst();

    addon.setResults({ resultIndex: 2, resultCount: 5 });
    search.findNext("x");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("the sentence that describes a position", () => {
  it("says nothing while the box is empty, because a count for a search that has not run is noise", () => {
    expect(positionMessage({ kind: "idle" })).toEqual({ key: null });
  });

  it("reports a search that found nothing with the no-match key, because '0 of 0' is not a sentence", () => {
    expect(positionMessage({ kind: "none" })).toEqual({
      key: "component.terminal.search.noMatch",
      values: {},
    });
  });

  it("counts from one for display, because the message says 'Match 1 of 3' and the state stores a zero", () => {
    // The zero-based index stays in the state: it is what the addon reports and
    // what a keyboard step would use. The one-based number exists only for this
    // sentence, and converting it here keeps the panel from having to know which
    // convention the message uses.
    const message = positionMessage({ kind: "at", index: 0, count: 3, capped: false });

    expect(message).toEqual({
      key: "component.terminal.search.matchCount",
      values: { index: 1, count: 3 },
    });
  });

  it("hedges a capped count in the sentence itself, because a count the user can disprove teaches them to distrust the exact ones too", () => {
    // 1000 is the addon's ceiling, so "of 1000 matches" may be false. The hedge
    // has to be part of the message rather than a "+" the caller remembers to
    // append, or the one call site that forgets it reports a precise number.
    const capped = positionMessage({ kind: "at", index: 2, count: 1000, capped: true });
    const exact = positionMessage({ kind: "at", index: 2, count: 999, capped: false });

    expect(capped.key).toBe("component.terminal.search.matchCountAtLeast");
    expect(exact.key).toBe("component.terminal.search.matchCount");

    // Both keys exist and carry the same values, so the two sentences cannot
    // drift apart in placeholder names.
    // Narrowed by the key, not by a cast: the `null` arm has no values, and a
    // blind `.values` is the type error this helper exists to avoid.
    expect(valuesOf(capped)).toEqual({ index: 3, count: 1000 });
    expect(valuesOf(exact)).toEqual({ index: 3, count: 999 });
    expect(en["component.terminal.search.matchCountAtLeast"]).toBeDefined();
  });

  it("says nothing when matches exist but none is selected, because any index would name a match nobody is on", () => {
    // The only sentence available is "Match {index} of {count}". Printing 0 here
    // would claim the first match is selected while the terminal highlights none;
    // showing nothing under-reports for one keystroke instead.
    expect(positionMessage({ kind: "unanchored", count: 7, capped: false })).toEqual({ key: null });
  });

  it("uses a key the catalogue declares for every non-empty arm, so a rendered message cannot be a missing key", () => {
    // This is the consumer the i18n gate needs: each of these is a real reference
    // to a catalogue entry, not a string that merely looks like one.
    const positions: SearchPosition[] = [
      { kind: "none" },
      { kind: "at", index: 2, count: 9, capped: false },
    ];

    for (const position of positions) {
      const message = positionMessage(position);

      expect(message.key).not.toBeNull();
      expect(en[message.key as keyof typeof en]).toBeDefined();
    }
  });
});
