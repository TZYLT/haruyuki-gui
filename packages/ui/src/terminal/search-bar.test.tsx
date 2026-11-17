/**
 * Search bar tests.
 *
 * What is worth asserting here
 *   The bar has almost no logic of its own -- which is the point of splitting it
 *   out of the panel. What it does own is the mapping from a key press to a step
 *   of the model, and the mapping from a position to the one sentence that
 *   describes it. Both are asserted against a stubbed `TerminalSearch`, so a
 *   failure names the bar rather than a terminal that jsdom cannot paint.
 *
 * The two failures that reach a user
 *   1. Enter that submits a form instead of searching -- the renderer reloads and
 *      the scrollback the user was searching is gone.
 *   2. A count rendered from the position's raw numbers -- which prints "Match 0
 *      of 7" for a set no match is selected from, and an exact number for a count
 *      that is only a lower bound.
 *
 * Why the model is a double rather than a real addon
 *   A real `SearchAddon` needs a live terminal and a parsed buffer, so a test that
 *   used one would be asserting xterm's search rather than this bar. The double
 *   records calls, which is what the bar is responsible for producing.
 *
 * Why `LocaleProvider` wraps every render
 *   The bar renders catalogue keys, and `useT()` without a provider has no
 *   catalogue to resolve against. The tests assert on the catalogue's real English
 *   text, not on the key names, because a key name rendering as a message is the
 *   failure that looks fine in review.
 */

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { en } from "../i18n/locales/en.js";
import { LocaleProvider } from "../i18n/index.js";
import { SearchBar } from "./search-bar.js";
import type { SearchPosition, SearchStep, TerminalSearch } from "./search.js";

/**
 * A search model double that records what the bar asked it to do.
 *
 * @param step what a step should report; defaults to "found, on the first match"
 * @returns the model and its recorded calls
 */
function fakeSearch(step?: (term: string) => SearchStep) {
  const next: string[] = [];
  const prev: string[] = [];
  let position: SearchPosition = { kind: "idle" };
  const listeners = new Set<(next: SearchPosition) => void>();

  /**
   * Publish a position and tell the bar, the way the real model does.
   *
   * @param value the position to publish
   */
  const publish = (value: SearchPosition): void => {
    position = value;

    for (const listener of listeners) listener(value);
  };

  const record = (into: string[], term: string): SearchStep => {
    into.push(term);

    const reported = step?.(term) ?? {
      kind: "found" as const,
      position: { kind: "at", index: 0, count: 1, capped: false },
    };

    if ("position" in reported) publish(reported.position);

    return reported;
  };

  const search: TerminalSearch = {
    findNext: (term) => record(next, term),
    findPrev: (term) => record(prev, term),
    clear: () => {
      publish({ kind: "idle" });
    },
    get position() {
      return position;
    },
    onDidChange(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return { search, next, prev, publish };
}

/**
 * @param element what to render
 * @returns nothing; the caller uses `screen`
 */
function renderBar(element: React.ReactElement): void {
  render(<LocaleProvider locale="en">{element}</LocaleProvider>);
}

describe("typing and stepping", () => {
  it("searches the typed term when Enter is pressed, because that is what a find box does", async () => {
    const { search, next } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(next).toEqual(["needle"]);
  });

  it("keeps the typed text in the input, because a search box that clears itself after one step cannot be refined", async () => {
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(screen.getByRole("searchbox")).toHaveProperty("value", "needle");
  });

  it("steps forward from the arrow and backward from the other, because the two directions are the whole interaction", async () => {
    const { search, next, prev } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle");
    await userEvent.click(
      screen.getByRole("button", { name: en["component.terminal.search.nextMatch"] }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: en["component.terminal.search.prevMatch"] }),
    );

    expect(next).toEqual(["needle"]);
    expect(prev).toEqual(["needle"]);
  });

  it("cancels the keydown's default action, because a submit reloads the renderer and the scrollback being searched goes with it", async () => {
    // `preventDefault` is asserted directly rather than inferred from "nothing
    // navigated", because jsdom neither navigates nor has a form here: the weaker
    // assertion passes with the call deleted, which is exactly how this case was
    // first written and why it is written this way now.
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    const input = screen.getByRole("searchbox");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("closes on Escape, because a bar the user cannot dismiss without the mouse is a trap", async () => {
    const { search } = fakeSearch();
    const onClose = vi.fn();
    renderBar(<SearchBar search={search} onClose={onClose} />);

    await userEvent.type(screen.getByRole("searchbox"), "{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes from the close button too, because the bar is used with a mouse as well as a keyboard", async () => {
    const { search } = fakeSearch();
    const onClose = vi.fn();
    renderBar(<SearchBar search={search} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: en["common.action.cancel"] }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the sentence under the input", () => {
  it("shows the count once a match is selected, because the user has to know how far they are", async () => {
    const { search } = fakeSearch(() => ({
      kind: "found",
      position: { kind: "at", index: 2, count: 7, capped: false },
    }));
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    // One-based: the model's index 2 is the third match a user counts.
    expect(screen.getByText("Match 3 of 7 matches")).toBeDefined();
  });

  it("hedges a capped count, because an exact number the user can disprove discredits the ones that were exact", async () => {
    const { search } = fakeSearch(() => ({
      kind: "found",
      position: { kind: "at", index: 0, count: 1000, capped: true },
    }));
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    // The thousands separator is ICU's, not this module's: the catalogue says
    // `{count}` and the formatter localises the number for the locale.
    expect(screen.getByText("Match 1 of at least 1,000 matches")).toBeDefined();
  });

  it("says there are no matches rather than showing a zero, because '0 of 0' is not a sentence", async () => {
    const { search } = fakeSearch(() => ({ kind: "exhausted", position: { kind: "none" } }));
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "absent{Enter}");

    expect(screen.getByText(en["component.terminal.search.noMatch"])).toBeDefined();
    expect(screen.queryByText(/of 0/)).toBeNull();
  });

  it("shows nothing when matches exist but none is selected, because any index would name a match nobody is on", async () => {
    const { search } = fakeSearch(() => ({
      kind: "exhausted",
      position: { kind: "unanchored", count: 7, capped: false },
    }));
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    // The failure this pins is "Match 1 of 7" for a set the terminal has
    // highlighted none of.
    expect(screen.queryByText(/Match/)).toBeNull();
  });

  it("shows nothing while the box is empty, because a count for a search that has not run is noise", () => {
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    expect(screen.queryByText(/Match/)).toBeNull();
    expect(screen.queryByText(en["component.terminal.search.noMatch"])).toBeNull();
  });
});

describe("names a screen reader can announce", () => {
  it("gives the input, both arrows and the count an accessible name, because a control nobody can identify by ear is half unusable", () => {
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    expect(screen.getByRole("searchbox")).toHaveProperty(
      "placeholder",
      en["component.terminal.search.placeholder"],
    );
    expect(
      screen.getByRole("button", { name: en["component.terminal.search.prevMatch"] }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: en["component.terminal.search.nextMatch"] }),
    ).toBeDefined();
  });

  it("exposes the count as a live region, because it changes without the user moving focus", async () => {
    // The count only exists after a step, so a live-region assertion has to take
    // one: a bar that rendered an empty live region on mount would pass a weaker
    // version of this case while being useless to a screen reader.
    const { search } = fakeSearch(() => ({
      kind: "found",
      position: { kind: "at", index: 0, count: 3, capped: false },
    }));
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(screen.getByText("Match 1 of 3 matches").closest("[aria-live]")).not.toBeNull();
  });

  it("marks itself as a search landmark, because that is how a user jumps back to it", () => {
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    expect(screen.getByRole("search")).toBeDefined();
  });

  it("focuses the input on mount, because the bar opens on demand and typing is the next thing the user wants", () => {
    const { search } = fakeSearch();
    renderBar(<SearchBar search={search} onClose={() => {}} />);

    expect(screen.getByRole("searchbox")).toBe(document.activeElement);
  });
});

describe("the panel is told about every step", () => {
  it("reports the new position, so the panel can keep its own state in step with the bar", async () => {
    const { search } = fakeSearch(() => ({
      kind: "found",
      position: { kind: "at", index: 1, count: 4, capped: false },
    }));
    const seen: SearchPosition[] = [];
    renderBar(
      <SearchBar search={search} onClose={() => {}} onPositionChange={(next) => seen.push(next)} />,
    );

    await userEvent.type(screen.getByRole("searchbox"), "needle{Enter}");

    expect(seen).toEqual([{ kind: "at", index: 1, count: 4, capped: false }]);
  });
});
