/**
 * The search bar's model: one query, a position within its matches, and the
 * decision about how many matches there are.
 *
 * Why this module exists rather than the panel calling the addon
 *   `@xterm/addon-search` answers three different questions through one boolean
 *   and one event, and none of the three survives a careless caller:
 *
 *   1. "did this step find something" -- `findNext` returns `false` both when the
 *      term is absent and when the addon refuses to move off the current match
 *      (its search does not wrap). A panel that treats `false` as "no matches"
 *      shows "No matches" for a term that has twelve and is currently on the
 *      twelfth.
 *   2. "how many matches are there" -- only reported by `onDidChangeResults`,
 *      which `SearchAddon` fires **only when the search options carry a
 *      `decorations` object**. Without one the event never fires and the counts
 *      stay at their initial values, silently and while the highlighting works.
 *   3. "which match am I on" -- the same event's `resultIndex`, which the addon
 *      sets to `-1` when it has no selected decoration. Passing that to `{index}`
 *      renders "Match -1 of 3", so it must not be treated as a zero.
 *
 *   The counters are therefore not a convenience wrapper: they are the only place
 *   where the three answers become distinguishable. Everything else is a thin
 *   call, and a panel that called the addon directly would have to rediscover all
 *   three.
 *
 * Why the count is a lower bound
 *   The addon stops collecting at `highlightLimit` (1000 by default), so its
 *   `resultCount` saturates. A terminal with more than a thousand hits is not
 *   rare -- `grep -r` output, a loop in a log. Reporting "1000 matches" for one of
 *   those is a claim a user disproves by pressing the down arrow, so the ceiling
 *   is reported as a ceiling and the panel renders "1000+" rather than a number
 *   this layer cannot stand behind.
 *
 * Why closing the bar clears the decorations
 *   Decorations are painted into the terminal's DOM, not into the search bar, so
 *   hiding the bar leaves the coloured match blocks behind. A user who closed the
 *   search then sees unexplained coloured text with no control left that would
 *   remove it. The clear belongs next to the state it belongs to, rather than in
 *   an effect the panel has to remember.
 *
 * Pure with respect to everything but the injected addon: no DOM, no terminal
 * instance of its own, no timer, and no clock.
 */

import type { ISearchOptions, ISearchDecorationOptions, SearchAddon } from "@xterm/addon-search";

/**
 * The ceiling `@xterm/addon-search` applies to its own collection by default.
 *
 * Mirrored here because it is the reason a count can be a lower bound, and the
 * panel has to know that in order to render "1000+" instead of "1000". The addon
 * takes the limit as a constructor option, so a build that raised it would make
 * this number wrong -- which is why the limit is supplied to this module rather
 * than assumed.
 */
export const DEFAULT_HIGHLIGHT_LIMIT = 1000;

/**
 * The decoration colours, as the addon requires them.
 *
 * Present at all because `SearchAddon` fires `onDidChangeResults` only when the
 * search options carry this object: without it there is no count, and a search
 * bar with no count is a search bar the user cannot navigate. The values are
 * overridable because they belong to the theme, not to this module.
 */
export interface TerminalSearchDecorationOptions {
  readonly matchBackground?: string;
  readonly matchBorder?: string;
  readonly matchOverviewRuler?: string;
  readonly activeMatchBackground?: string;
  readonly activeMatchBorder?: string;
  readonly activeMatchColorOverviewRuler?: string;
}

/** What {@link createTerminalSearch} needs from its caller. */
export interface TerminalSearchOptions {
  /** Whether a query distinguishes case. Defaults to false. */
  readonly caseSensitive?: boolean;

  /** Whether a query must sit on word boundaries. Defaults to false. */
  readonly wholeWord?: boolean;

  /**
   * The match ceiling this build's addon was constructed with.
   *
   * Defaults to {@link DEFAULT_HIGHLIGHT_LIMIT}. Supplied rather than assumed so
   * that a count that hit the ceiling is reported as a lower bound against the
   * same number the addon actually used.
   */
  readonly highlightLimit?: number;

  /** The match colours. Defaults to a neutral pair that is readable on both themes. */
  readonly decorations?: TerminalSearchDecorationOptions;
}

/**
 * Where the user is in the matches, as far as this layer can honestly say.
 *
 * Discriminated rather than a pair of numbers because "nothing to search for",
 * "searched and found nothing", and "matches exist but the addon selected none"
 * are three different screens, and a panel that rendered the addon's `-1` would
 * be rendering an internal sentinel as content.
 */
export type SearchPosition =
  /** There is no query, so nothing has been searched. */
  | { readonly kind: "idle" }
  /** A query ran and found no match. */
  | { readonly kind: "none" }
  /** At least one match exists, and one of them is current. */
  | {
      readonly kind: "at";
      /** Zero-based index of the current match. */
      readonly index: number;
      /** How many matches were found, possibly a lower bound. */
      readonly count: number;
      /** Whether {@link count} stopped at the addon's ceiling. */
      readonly capped: boolean;
    }
  /** Matches exist, but the addon reported no current one (`resultIndex` was -1). */
  | { readonly kind: "unanchored"; readonly count: number; readonly capped: boolean };

/**
 * The addon surface this module actually uses.
 *
 * A narrow interface rather than `SearchAddon`, because the fixture in the test
 * file is a double for exactly these methods: depending on the whole class would
 * force a test to implement `activate`, `dispose` and the decoration methods it
 * never calls, and a double that grows to satisfy an unused surface stops being
 * an honest model of what this code needs. `SearchAddon` satisfies this type, so
 * a real addon passes without a cast.
 */
export interface TerminalSearchAddon {
  findNext(term: string, searchOptions?: ISearchOptions): boolean;
  findPrevious(term: string, searchOptions?: ISearchOptions): boolean;
  clearDecorations(): void;
  readonly onDidChangeResults: SearchAddon["onDidChangeResults"];
}

/** What one step of the search produced. */
export type SearchStep =
  /** The step moved to a match. */
  | { readonly kind: "found"; readonly position: SearchPosition }
  /**
   * The addon refused to move -- either there is no match at all, or the search
   * reached its end and does not wrap. {@link position} tells the two apart.
   */
  | { readonly kind: "exhausted"; readonly position: SearchPosition }
  /** Nothing was sent, because there is no term to search for. */
  | { readonly kind: "empty" };

/** The search model the panel drives. */
export interface TerminalSearch {
  /**
   * Search forward from the current match.
   *
   * @param term the text to look for
   * @returns what the step produced; never throws for a missing match
   */
  findNext(term: string): SearchStep;

  /**
   * Search backward from the current match.
   *
   * @param term the text to look for
   * @returns what the step produced; never throws for a missing match
   */
  findPrev(term: string): SearchStep;

  /**
   * Stop highlighting and forget the query.
   *
   * Called when the bar closes: the decorations are painted into the terminal, so
   * hiding the bar would otherwise leave them with no control that removes them.
   */
  clear(): void;

  /** The current position, for a panel that re-renders without searching. */
  readonly position: SearchPosition;

  /**
   * Subscribe to position changes.
   *
   * @param listener called with the new position
   * @returns a function that unsubscribes
   */
  onDidChange(listener: (position: SearchPosition) => void): () => void;
}

/** The message key that describes a position, and the values it needs. */
export type SearchPositionMessage =
  /** Nothing to say: the box is empty, so the bar shows only its placeholder. */
  | { readonly key: null }
  | { readonly key: "component.terminal.search.noMatch"; readonly values: Record<string, never> }
  | {
      /** `matchCount` when the total is exact, `matchCountAtLeast` when it is not. */
      readonly key:
        "component.terminal.search.matchCount" | "component.terminal.search.matchCountAtLeast";
      /** One-based, because the message says "Match {index} of {count}". */
      readonly values: { readonly index: number; readonly count: number };
    };

/**
 * Choose the sentence that describes a position.
 *
 * Why this lives here rather than in the panel
 *   The panel would otherwise re-derive it from the position's arms, and the two
 *   places where that goes wrong are the ones this module already knows about: an
 *   `unanchored` set has a count but no index, so a naive `matchCount` renders
 *   "Match -1"; and a `capped` count must not be printed as an exact number. Both
 *   facts are in this file's states, so the mapping from state to sentence belongs
 *   next to them instead of being rediscovered by a component.
 *
 * Why a capped count gets a different key instead of a plus sign
 *   The addon stops collecting at its highlight limit, so a saturated count is a
 *   lower bound. Rendering it as an exact number is a claim the user disproves by
 *   pressing the down arrow -- and the moment they do, they stop trusting the
 *   counts that were exact. The hedge therefore has to be in the sentence, where
 *   it cannot be forgotten by a caller.
 *
 * @param position the current position
 * @returns the message key and its values, or `null` for "show nothing"
 */
export function positionMessage(position: SearchPosition): SearchPositionMessage {
  switch (position.kind) {
    case "idle":
      return { key: null };

    case "none":
      return { key: "component.terminal.search.noMatch", values: {} };

    case "at":
      // One-based for display. The zero-based index stays in the state, because
      // that is what the addon and any keyboard stepping use.
      return {
        key: position.capped
          ? "component.terminal.search.matchCountAtLeast"
          : "component.terminal.search.matchCount",
        values: { index: position.index + 1, count: position.count },
      };

    case "unanchored":
      // The addon found matches but selected none, so there is no "which one"
      // to report. The only sentence available says "Match {index} of {count}",
      // and printing any index here would name a match nobody is on -- "Match 0
      // of 7" for a set the terminal has highlighted none of. This arm therefore
      // shows nothing until the user steps, which under-reports for one keystroke
      // rather than misreporting a position that does not exist.
      return { key: null };
  }
}

/** The colours used when the caller supplies none. */
const DEFAULT_DECORATIONS: Required<TerminalSearchDecorationOptions> = {
  matchBackground: "#3a3d41",
  matchBorder: "#5f6368",
  matchOverviewRuler: "#5f6368",
  activeMatchBackground: "#515c6a",
  activeMatchBorder: "#d1d1d1",
  activeMatchColorOverviewRuler: "#d1d1d1",
};

/**
 * Build the search model over one terminal's addon.
 *
 * @param addon the search addon, already activated on a terminal
 * @param options case and word matching, the addon's ceiling, and the colours
 * @returns the model the search bar drives
 */
export function createTerminalSearch(
  addon: TerminalSearchAddon,
  options: TerminalSearchOptions = {},
): TerminalSearch {
  const caseSensitive = options.caseSensitive ?? false;
  const wholeWord = options.wholeWord ?? false;
  const highlightLimit = options.highlightLimit ?? DEFAULT_HIGHLIGHT_LIMIT;
  const colours: Required<TerminalSearchDecorationOptions> = {
    ...DEFAULT_DECORATIONS,
    ...options.decorations,
  };

  if (!Number.isFinite(highlightLimit) || highlightLimit <= 0) {
    throw new RangeError(
      `invalid highlightLimit: ${String(highlightLimit)}; the ceiling must be a positive ` +
        "finite number, or no count could ever be reported as a lower bound",
    );
  }

  // The decoration set is required, not optional: `SearchAddon` fires its result
  // event only when the search options carry one, so an "off" switch here would
  // silently disable the match count while the highlighting kept working.
  const decorations: ISearchDecorationOptions = {
    matchBackground: colours.matchBackground,
    matchBorder: colours.matchBorder,
    matchOverviewRuler: colours.matchOverviewRuler,
    activeMatchBackground: colours.activeMatchBackground,
    activeMatchBorder: colours.activeMatchBorder,
    activeMatchColorOverviewRuler: colours.activeMatchColorOverviewRuler,
  };

  const searchOptions = { caseSensitive, wholeWord, decorations };

  let position: SearchPosition = { kind: "idle" };
  const listeners = new Set<(position: SearchPosition) => void>();

  /**
   * Set the position and tell every listener.
   *
   * @param next the position to publish
   */
  const publish = (next: SearchPosition): void => {
    position = next;

    for (const listener of listeners) {
      listener(next);
    }
  };

  addon.onDidChangeResults((event) => {
    const count = Math.max(0, event.resultCount);
    const capped = count >= highlightLimit;

    if (count === 0) {
      publish({ kind: "none" });

      return;
    }

    // `resultIndex` is -1 when the addon has no selected decoration. That is not
    // "the first match": reporting 0 there would point the user at a match nobody
    // selected, so it gets its own arm.
    if (event.resultIndex < 0) {
      publish({ kind: "unanchored", count, capped });

      return;
    }

    publish({ kind: "at", index: event.resultIndex, count, capped });
  });

  /**
   * Run one step and translate the addon's boolean.
   *
   * The boolean says what the step did, not what exists: `findNext` returns false
   * on the last match even though the term has twelve, because the addon's search
   * does not wrap. The position is therefore read from the counters the addon just
   * published -- it fires its result event synchronously inside `findNext`, so by
   * the time the call returns, {@link position} is already this step's.
   *
   * @param move the addon call to make
   * @param term the text to look for
   * @returns the step, with the position the addon reported for it
   */
  const step = (move: () => boolean, term: string): SearchStep => {
    if (term === "") {
      // An empty term is not a failed search. The addon treats it as "nothing to
      // do" and leaves the previous decorations painted, so clearing here is what
      // makes emptying the box remove the highlight -- what a user who deleted
      // their query expects.
      addon.clearDecorations();
      publish({ kind: "idle" });

      return { kind: "empty" };
    }

    const found = move();

    return { kind: found ? "found" : "exhausted", position };
  };

  return {
    findNext(term: string): SearchStep {
      return step(() => addon.findNext(term, searchOptions), term);
    },

    findPrev(term: string): SearchStep {
      return step(() => addon.findPrevious(term, searchOptions), term);
    },

    clear(): void {
      // Decorations are painted into the terminal, not into the bar. Closing the
      // bar has to remove them, or the user is left with coloured blocks and no
      // control that would clear them.
      addon.clearDecorations();
      publish({ kind: "idle" });
    },

    get position(): SearchPosition {
      return position;
    },

    onDidChange(listener: (position: SearchPosition) => void): () => void {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
