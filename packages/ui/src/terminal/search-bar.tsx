/**
 * The search bar: one input, two arrows, one count, one close button.
 *
 * Why this is a component and not part of the panel
 *   The panel owns the layout and the session; this owns the query and what the
 *   query found. Splitting them means the panel never learns what a match is, and
 *   this never learns what a session is -- which is the same split that lets the
 *   search model be tested without a terminal and the panel be tested without a
 *   match.
 *
 * Why it holds no state of its own
 *   The term, the position and the highlight all live in `TerminalSearch`, which
 *   is where a step's result has to land anyway. A component that mirrored the
 *   term locally would have two answers to "what is being searched for" the moment
 *   a step was refused, and the count would then describe a query the input no
 *   longer shows.
 *
 * Why the count comes from `positionMessage` rather than from the position
 *   A capped count has to render as "at least N", and an unanchored one has to
 *   render as nothing at all. Both are decisions about a sentence, and both are
 *   already made where the states are defined -- re-deriving them here would put
 *   the same three-way branch in a component that cannot be tested without a
 *   document.
 *
 * The keyboard contract, and why the input is not a form
 *   Enter and the two arrows are the entire interaction, and Escape closes. A
 *   `<form>` would add a submit event that navigates in some environments, and a
 *   search that reloads the renderer is worse than no search. So the keys are
 *   handled directly and nothing is submitted.
 */

import type { KeyboardEvent, ReactElement } from "react";
import { useEffect, useRef, useState } from "react";

import { Button, Input } from "../components/index.js";
import { useT } from "../i18n/index.js";
import { positionMessage } from "./search.js";
import type { SearchPosition, TerminalSearch } from "./search.js";

/** What the bar needs from the panel. */
export interface SearchBarProps {
  /** The model this bar drives. Owned by the panel, not by the bar. */
  readonly search: TerminalSearch;

  /**
   * Called when the user closes the bar.
   *
   * The bar does not call `search.clear()` itself: closing is the panel's
   * decision, and the panel is what knows whether the decorations should survive
   * a collapse. It passes the same `search` back so this stays a view.
   */
  readonly onClose: () => void;

  /** Called after every step, so the panel can keep its own state in sync. */
  readonly onPositionChange?: (position: SearchPosition) => void;

  /** Focus the input on mount. Defaults to true, because the bar opens on demand. */
  readonly autofocus?: boolean;
}

/**
 * Render the search bar.
 *
 * @param props the model, the close handler and the focus preference
 * @returns the bar
 */
export function SearchBar({
  search,
  onClose,
  onPositionChange,
  autofocus = true,
}: SearchBarProps): ReactElement {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);

  // The term is mirrored here for one reason only: it is what the input displays,
  // and React needs a value to render. It is pushed into `search` on every step
  // and never read back from it, so `search` stays the only place a query lives.
  const [term, setTerm] = useState("");
  const [position, setPosition] = useState<SearchPosition>({ kind: "idle" });

  useEffect(() => {
    const unsubscribe = search.onDidChange((next) => {
      setPosition(next);
      onPositionChange?.(next);
    });

    if (autofocus) input.current?.focus();

    return unsubscribe;
  }, [search, onPositionChange, autofocus]);

  /**
   * Run one step and keep the displayed term in step with it.
   *
   * @param run the step to take
   */
  const step = (run: (term: string) => unknown): void => {
    run(term);
    setPosition(search.position);
  };

  const message = positionMessage(position);

  return (
    <div className="terminal-search-bar" role="search">
      <Input
        ref={input}
        className="terminal-search-input"
        value={term}
        // `type="search"` is what gives the field the `searchbox` role, which is
        // how a screen reader announces "this is the find box" rather than "edit
        // text". It also makes the browser offer its own clear affordance.
        type="search"
        placeholder={t("component.terminal.search.placeholder")}
        aria-label={t("component.terminal.search.placeholder")}
        onChange={(value: string) => {
          // The component hands over the raw DOM value, so this is the typed text
          // and not an event wrapping it.
          setTerm(value);
        }}
        onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
          // Handled here rather than through a form's submit, because a submit
          // navigates in some environments and a search that reloads the renderer
          // is worse than no search at all.
          if (event.key === "Enter") {
            event.preventDefault();
            step((value) => search.findNext(value));
            return;
          }

          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />

      {/* The two arrows carry accessible names rather than tooltips: a control
          nobody can identify by ear is a control half the users cannot operate. */}
      <Button
        className="terminal-search-prev"
        aria-label={t("component.terminal.search.prevMatch")}
        onClick={() => {
          step((value) => search.findPrev(value));
        }}
      >
        {t("component.terminal.search.prevMatch")}
      </Button>

      <Button
        className="terminal-search-next"
        aria-label={t("component.terminal.search.nextMatch")}
        onClick={() => {
          step((value) => search.findNext(value));
        }}
      >
        {t("component.terminal.search.nextMatch")}
      </Button>

      {/* One count, from the one sentence that knows how to hedge it. A capped
          count renders "at least N"; an unanchored one renders nothing. */}
      {message.key === null ? null : (
        <span className="terminal-search-count" aria-live="polite">
          {t(message.key, message.values)}
        </span>
      )}

      <Button
        className="terminal-search-close"
        aria-label={t("common.action.cancel")}
        onClick={onClose}
      >
        {t("common.action.cancel")}
      </Button>
    </div>
  );
}
