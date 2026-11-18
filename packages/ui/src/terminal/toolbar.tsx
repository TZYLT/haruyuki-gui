/**
 * The terminal panel's toolbar, and the one rule it encodes: which actions are
 * available in which phase.
 *
 * Why the availability rule lives here rather than in the buttons
 *   Every button in this bar has the same question to answer -- "may this be
 *   pressed right now?" -- and the answers come from one table, not from five
 *   separate `disabled=` expressions. Spread across the JSX, the table is
 *   invisible: a reader cannot tell whether a missing case is a decision or an
 *   oversight, and a wrong answer looks like a button that renders slightly
 *   differently from its neighbour. As a function it is a value a test can
 *   compare in full, so "reopen is offered in exactly these three phases" is
 *   asserted rather than eyeballed.
 *
 * Why `stop` and `clear` are separate rows although they agree today
 *   `stop` ends a process the engine owns; `clear` sends control bytes through
 *   the input path. A future phase where one is allowed and the other is not --
 *   a shell that exited but whose scrollback is still worth clearing -- would
 *   make a shared row silently wrong. Keeping them separate makes that change
 *   visible instead of hidden.
 *
 * Why the font buttons are never disabled for a session reason
 *   Text size is a view setting, not a session fact. Greying it out while a
 *   shell starts would disable a control for a reason the user cannot name, and
 *   the size must be adjustable exactly when the output is hard to read. They do
 *   stop at the ends of the ladder, because a size outside it makes the terminal
 *   draw a cursor that does not line up with its own cells.
 */

import type { ReactElement } from "react";

import { Button } from "../components/index.js";
import { useT } from "../i18n/index.js";
import type { TerminalPhase } from "./state.js";

/**
 * Which of the three session actions the current phase allows.
 *
 * `reopen` is the panel's only way out of a finished session, so the phases that
 * deny it are exactly the ones where a session already exists, or where a
 * request could not be delivered at all:
 *
 *   offered  idle / exited / failed -- nothing live to collide with.
 *   denied   starting / running     -- a session is being created or is live; a
 *                                      second spawn would leave two requests
 *                                      behind one panel.
 *   denied   disconnected          -- the engine ended the PTY when the
 *                                      connection closed, so a request now has
 *                                      nowhere to go. The button returns when
 *                                      readiness does, which moves the phase
 *                                      back to idle.
 */
export interface ToolbarAvailability {
  /** May a session be started, or started again? */
  readonly canReopen: boolean;
  /** May the running process be ended? */
  readonly canStop: boolean;
  /** May the screen be cleared? */
  readonly canClear: boolean;
}

/**
 * Decide which actions the toolbar offers for one phase.
 *
 * @param phase the panel's current phase
 * @returns the availability of each session action
 */
export function toolbarAvailability(phase: TerminalPhase): ToolbarAvailability {
  switch (phase) {
    case "idle":
    case "exited":
    case "failed":
      return { canReopen: true, canStop: false, canClear: false };

    case "running":
      return { canReopen: false, canStop: true, canClear: true };

    case "starting":
      // A spawn is in flight. Neither action has a target yet: the process may
      // not exist, and no bytes may be sent to it.
      return { canReopen: false, canStop: false, canClear: false };

    case "disconnected":
      return { canReopen: false, canStop: false, canClear: false };
  }
}

/** One of the two font steps, in pixels. */
export const FONT_STEP = 1;

/** Smallest font a user can reach from the toolbar. */
export const FONT_MIN = 9;

/** Largest font a user can reach from the toolbar. */
export const FONT_MAX = 24;

/** Props of {@link TerminalToolbar}. */
export interface TerminalToolbarProps {
  /** The phase the buttons gate on. */
  readonly phase: TerminalPhase;
  /** The exit code to show in the exited sentence, when there is one. */
  readonly exitCode: number | null;
  /** The engine's own failure text to show in the failed sentence. */
  readonly failureDetail: string | null;
  /** Whether the engine is connected. Decides which idle sentence is used. */
  readonly engineReady: boolean;
  /** The current font size, for the two font steps. */
  readonly fontSize: number;
  /** Asked to start a session, or to start one again. */
  readonly onReopen: () => void;
  /** Asked to end the running process. */
  readonly onStop: () => void;
  /** Asked to clear the screen. */
  readonly onClear: () => void;
  /**
   * Asked to clear the viewport *and* the scrollback.
   *
   * A second action rather than a second meaning for the first: the plain clear
   * delegates to the shell on purpose (Ctrl-L semantics), and a shell whose
   * terminfo does not know the sequence is allowed to do nothing. This one acts on
   * the emulator, so it works for a shell that never repaints and for a session
   * that already exited.
   */
  readonly onClearAll: () => void;
  /** Asked to change the font size by one step. */
  readonly onFontSize: (next: number) => void;
  /** Asked to open the overflow menu, anchored at the button that was pressed. */
  readonly onMore: (anchor: HTMLElement) => void;
}

/**
 * The sentence for one phase.
 *
 * `idle` is the one phase with two truths behind it, and the panel is the only
 * place that knows which applies: the state machine deliberately does not store
 * engine readiness, because readiness is an input to a decision rather than
 * something that happened to this session. So the caller passes it.
 *
 * Every sentence is a literal `t("...")` call rather than a table lookup, for two
 * reasons. The obvious one is that the gate finds references by reading these
 * call sites, so a key reached only through a table would be reported as
 * declared-but-unused. The load-bearing one is that a total map hides a phase
 * the day somebody adds it: a missing entry reads as `undefined` at runtime,
 * while a missing `case` is a type error here.
 *
 * @param props the facts the sentences interpolate
 * @returns the sentence to show
 */
function phaseText({
  phase,
  engineReady,
  exitCode,
  failureDetail,
}: Pick<
  TerminalToolbarProps,
  "phase" | "engineReady" | "exitCode" | "failureDetail"
>): ReactElement {
  const t = useT();

  switch (phase) {
    case "idle": {
      // "Nothing has been asked of the engine yet" versus "the connection came
      // back". A user whose shell a disconnect killed needs to read the second
      // one; telling them they are merely disconnected describes a panel that
      // never had a session at all.
      //
      // The two keys are two whole `t()` calls rather than one call with a
      // chosen key, because the reference scan reads these literals and would
      // otherwise report both of them as declared but never used.
      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {engineReady
            ? t("component.terminal.phaseIdleReady")
            : t("component.terminal.phaseIdleOffline")}
        </p>
      );
    }

    case "starting":
      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {t("component.terminal.phaseStarting")}
        </p>
      );

    case "running":
      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {t("component.terminal.phaseRunning")}
        </p>
      );

    case "exited":
      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {t("component.terminal.phaseExited", { code: exitCode ?? 0 })}
        </p>
      );

    case "failed": {
      // An empty failure text is a failure with nothing to add. Saying the shell
      // could not start, without a colon and a hole after it, is better than
      // rendering punctuation for a message that is not there.
      const detail = failureDetail ?? "";

      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {detail === ""
            ? t("component.terminal.phaseStarting")
            : t("component.terminal.phaseFailed", { detail })}
        </p>
      );
    }

    case "disconnected":
      return (
        <p className="ui-terminal-toolbar__phase" data-phase={phase}>
          {t("component.terminal.phaseDisconnected")}
        </p>
      );
  }
}

/**
 * The terminal's action bar.
 *
 * @param props toolbar props
 * @returns the toolbar element
 */
export function TerminalToolbar({
  phase,
  exitCode,
  failureDetail,
  engineReady,
  fontSize,
  onReopen,
  onStop,
  onClear,
  onClearAll,
  onFontSize,
  onMore,
}: TerminalToolbarProps): ReactElement {
  const t = useT();
  const available = toolbarAvailability(phase);

  return (
    <div
      className="ui-terminal-toolbar"
      role="toolbar"
      aria-label={t("component.terminal.a11y.region")}
    >
      <div className="ui-terminal-toolbar__actions">
        <Button variant="secondary" size="sm" disabled={!available.canReopen} onClick={onReopen}>
          {t("component.terminal.action.reopen")}
        </Button>
        <Button variant="secondary" size="sm" disabled={!available.canStop} onClick={onStop}>
          {t("component.terminal.action.stop")}
        </Button>
        <Button variant="ghost" size="sm" disabled={!available.canClear} onClick={onClear}>
          {t("component.terminal.action.clear")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!available.canClear}
          onClick={onClearAll}
          title={t("component.terminal.action.clearAllHint")}
        >
          {t("component.terminal.action.clearAll")}
        </Button>
      </div>

      {phaseText({ phase, engineReady, exitCode, failureDetail })}

      <div className="ui-terminal-toolbar__view">
        <Button
          variant="ghost"
          size="sm"
          disabled={fontSize <= FONT_MIN}
          onClick={() => onFontSize(fontSize - FONT_STEP)}
          aria-label={t("component.terminal.action.fontSmaller")}
          title={t("component.terminal.action.fontSmaller")}
        >
          A-
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={fontSize >= FONT_MAX}
          onClick={() => onFontSize(fontSize + FONT_STEP)}
          aria-label={t("component.terminal.action.fontLarger")}
          title={t("component.terminal.action.fontLarger")}
        >
          A+
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={(event) => onMore(event.currentTarget)}
          aria-label={t("component.terminal.action.more")}
          title={t("component.terminal.action.more")}
        >
          {t("component.terminal.action.more")}
        </Button>
      </div>
    </div>
  );
}
