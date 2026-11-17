/**
 * The terminal panel: one xterm instance, one toolbar, and the wiring between
 * them and the engine.
 *
 * What this file is allowed to know
 *   It knows *where* bytes come from (the keyboard, the clipboard) and *when* a
 *   phase changed. It does not decide what a keystroke means (`translateKey`),
 *   how many lines a paste is (`translatePaste`), what a phase change is
 *   (`reducePhase`), or how a command leaves the process (`sendInput`). Each of
 *   those is a pure function it calls. That split is why the rules can be tested
 *   without a DOM, and why this file reads as wiring: there is no escape
 *   sequence, no phase transition and no input capability name written below.
 *
 * The two paths into the shell, and the one that had to be closed
 *   A keystroke reaches the engine through xterm's `onData`: xterm already mapped
 *   the key, already decided the composition is over, and hands over the finished
 *   payload. The panel forwards that payload through `translateKey`.
 *
 *   A paste is different, and this is the part worth reading twice. xterm
 *   installs its own `paste` listener on its textarea and on its root element,
 *   and that listener writes the clipboard into the terminal immediately. It has
 *   no idea this product asks before running several commands. Those bytes would
 *   then arrive as `onData` like any other keystroke -- on the *keystroke* path,
 *   which never counts lines and never asks. The panel therefore listens for
 *   `paste` on its own container in the capture phase and stops the event there.
 *   Capture runs outside-in, so this listener sees the event before xterm's
 *   listeners, which sit on descendants and run on the way back up;
 *   `stopPropagation` keeps xterm's handler from writing those bytes at all. The
 *   clipboard text is then handed to `translatePaste`, which is the function that
 *   knows about confirmation.
 *
 *   Without that interposition there would be two live paste paths, one asking
 *   and one not, and a test proving that multi-line pastes ask first would stay
 *   green while the bypass ran.
 *
 * Why the panel owns no terminal output
 *   Output belongs to the emulator's buffer. Holding it in React state would turn
 *   every frame into a re-render, which is the one thing a terminal cannot
 *   afford.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";

import { Dialog } from "../components/index.js";
import { useT } from "../i18n/index.js";
import { killTerminal, sendInput, spawnTerminal } from "./commands.js";
import type { CommandSender } from "./commands.js";
import { translateKey, translatePaste } from "./exit.js";
import { createTerminalHost } from "./host.js";
import type { TerminalHost } from "./host.js";
import { reducePhase } from "./state.js";
import type { TerminalPanelState, TerminalSignal } from "./state.js";
import { FONT_MAX, FONT_MIN, TerminalToolbar, toolbarAvailability } from "./toolbar.js";

/**
 * The keystroke that clears a shell's screen.
 *
 * A form feed, which is what the readline-style line editors bind to "clear"
 * (Control+L). Typing a `clear` command instead would be a guess about which
 * binary exists in the shell's `PATH`, and it would leave the command in history;
 * this is the interaction the user meant.
 */
const CLEAR_SCREEN = "\f";

/** Columns for a panel that has not measured itself. */
const DEFAULT_COLS = 80;

/** Rows for a panel that has not measured itself. */
const DEFAULT_ROWS = 24;

/** Default text size, matching the terminal host's own default. */
const DEFAULT_FONT_SIZE = 13;

/**
 * Turn one `onData` payload into the bytes that should travel, or `null`.
 *
 * Pulled out of the effect because it is the whole keyboard path and it cannot be
 * reached through a DOM test: jsdom does not run xterm's key handling far enough
 * to fire `onData`, so a test that pressed a key would assert on nothing. As a
 * function it is exercised directly, with the exact record xterm would hand over,
 * and the effect above holds no decision of its own -- it only calls this.
 *
 * `domEvent` is the KeyboardEvent xterm saw for the same stroke. It is nullable
 * because a payload can outlive its event: a test, or a synthetic write, produces
 * data with no DOM event behind it, and the modifiers of a missing event are all
 * false rather than unknown.
 *
 * @param input the payload and the stroke it came from
 * @returns the bytes to send, or `null` for "nothing travels"
 */
export function decisionForStroke(input: {
  readonly key: string;
  readonly domEvent: KeyboardEvent | null;
  readonly data: string;
  readonly isComposing: boolean;
}): string | null {
  const event = input.domEvent;

  return translateKey({
    key: input.key,
    data: input.data,
    ctrlKey: event?.ctrlKey === true,
    shiftKey: event?.shiftKey === true,
    altKey: event?.altKey === true,
    metaKey: event?.metaKey === true,
    isComposing: input.isComposing,
  });
}

/** What the panel needs from its host. */
export interface TerminalPanelProps {
  /** The session this panel owns. Allocated once by the host and reused on reopen. */
  readonly terminalId: string;
  /**
   * The xterm stylesheet.
   *
   * Read by the shell, because this package has no filesystem. Passed as text
   * rather than as a URL because there is no CSS loader either, and an
   * asynchronously fetched sheet arrives after `open` -- too late for the
   * composition overlay.
   */
  readonly css: string;
  /** Where to start the shell. Omitted means the engine's own start directory. */
  readonly cwd?: string;
  /** The command layer. Injected so this file has no dependency on the engine. */
  readonly send: CommandSender;
  /**
   * Whether the engine is connected.
   *
   * Read by the panel rather than stored by the state machine: it is an input to
   * a decision, not something that happened to the session. It decides which of
   * the two idle sentences the toolbar shows.
   */
  readonly engineReady: boolean;
  /** Called when the user asks to search the scrollback. */
  readonly onSearch?: () => void;
  /** Called when the user asks to export the buffer. */
  readonly onExport?: () => void;
  /** Called when the user asks to open this directory in the system terminal. */
  readonly onOpenExternal?: () => void;
  /**
   * The phase to start from.
   *
   * A host that has already received frames for this session -- a remount while
   * the shell is still live, or a panel restored from a snapshot -- has no way to
   * replay them, and starting from `idle` would show a running shell as never
   * having started. Defaults to the idle state.
   */
  readonly initialPhase?: Pick<TerminalPanelState, "phase" | "pid" | "exitCode" | "failureDetail">;
  /**
   * Registers a receiver for engine frames.
   *
   * Pushed frames are the only evidence a terminal exists: a resolved
   * `spawnTerminal` means the request left this process and nothing more. The
   * panel therefore cannot poll for them, and the host hands it a subscription
   * instead. Each frame it delivers is fed to the same pure reducer every other
   * change goes through.
   *
   * @param receive called once per frame; the return value unsubscribes
   * @returns an unsubscribe function
   */
  readonly subscribe?: (receive: (signal: TerminalSignal) => void) => () => void;
}

/** The panel state before anything has happened. */
export function initialPanelState(
  terminalId: string,
  cwd: string | undefined,
  fontSize: number = DEFAULT_FONT_SIZE,
): TerminalPanelState {
  return {
    phase: "idle",
    terminalId,
    pid: null,
    exitCode: null,
    failureDetail: null,
    cwd: cwd ?? null,
    fontSize,
    searchVisible: false,
  };
}

/**
 * The panel's state machine, as a hook.
 *
 * Exported so a host can feed engine frames in from outside and a test can feed
 * them in without a bridge. The panel below owns one instance.
 *
 * @param initial the state to start from
 * @returns the current state and a dispatcher for signals
 */
export function useTerminalPanelState(initial: TerminalPanelState): {
  readonly state: TerminalPanelState;
  readonly dispatch: (signal: TerminalSignal) => void;
  readonly setFontSize: (next: number) => void;
} {
  const [state, setState] = useState(initial);

  const dispatch = useCallback((signal: TerminalSignal) => {
    // Every phase change goes through the pure reducer, including the ones it
    // decides to ignore -- that is what makes "and ignores the rest" testable.
    setState((previous) => reducePhase(previous, signal));
  }, []);

  const setFontSize = useCallback((next: number) => {
    // A view setting, not a session fact, so it does not go through the reducer:
    // the reducer's job is to say what a frame means, and no frame carries this.
    setState((previous) => ({
      ...previous,
      fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, next)),
    }));
  }, []);

  return { state, dispatch, setFontSize };
}

/**
 * The terminal panel.
 *
 * @param props panel props
 * @returns the panel element
 */
export function TerminalPanel({
  terminalId,
  css,
  cwd,
  send,
  engineReady,
  onSearch,
  onExport,
  onOpenExternal,
  initialPhase,
  subscribe,
}: TerminalPanelProps): ReactElement {
  const t = useT();

  const { state, dispatch, setFontSize } = useTerminalPanelState({
    ...initialPanelState(terminalId, cwd),
    ...initialPhase,
  });

  // Engine frames are the only evidence a session exists, so the panel subscribes
  // rather than polling. Every frame takes the same road as a local intent: into
  // the pure reducer, which decides whether it means anything.
  useEffect(() => {
    if (subscribe === undefined) return;

    return subscribe(dispatch);
  }, [dispatch, subscribe]);

  /** The dialog a multi-line paste is waiting behind, or `null`. */
  const [pendingPaste, setPendingPaste] = useState<{
    readonly text: string;
    readonly lines: number;
  } | null>(null);

  /** Whether the overflow menu is open. */
  const [menuOpen, setMenuOpen] = useState(false);

  /**
   * Whether the terminal's own right-click menu is open.
   *
   * The panel supplies this menu rather than the browser's, because three of its
   * four items are things only this component can do: the selection lives in
   * xterm, and a copy has to reach the clipboard a paste is read from.
   */
  const [contextMenuOpen, setContextMenuOpen] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<TerminalHost | null>(null);

  /**
   * The state as it is right now, for handlers that outlive a render.
   *
   * `onData` is installed once, at mount, and must not send with a phase captured
   * a hundred renders ago: the phase decides whether `sendInput` may write.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * The stroke xterm saw just before the data event it is about to fire.
   *
   * `onData` carries only the finished payload; by then the modifiers that decide
   * whether the payload may travel are gone. xterm fires `onKey` immediately
   * before the data event for the same stroke, so recording it is exact rather
   * than a guess.
   */
  const lastKeyRef = useRef<{ readonly key: string; readonly domEvent: KeyboardEvent | null }>({
    key: "",
    domEvent: null,
  });

  /**
   * Whether an input method owns the input right now.
   *
   * xterm already refuses to send anything while a composition is open, so this is
   * a second line rather than the mechanism. It exists because the exit
   * function's composition rule is otherwise impossible to assert end to end: a
   * test can hold this flag up and prove no call reaches the sender.
   */
  const composingRef = useRef(false);

  /** Send bytes the exit functions have already decided on. */
  const transmit = useCallback(
    (data: string) => {
      // `sendInput` re-checks the phase, so a payload produced one frame before
      // the phase moved cannot reach a dead session. Passing the live phase
      // rather than a captured one is what makes that check meaningful.
      void sendInput(send, { terminalId, data }, stateRef.current.phase);
    },
    [send, terminalId],
  );

  /** Ask the engine to open a session, or to open it again. */
  const reopen = useCallback(() => {
    // The phase moves first and the request follows: a second click while the
    // request is in flight finds the panel already in `starting`, and the reducer
    // then refuses a second spawn rather than putting two behind one panel.
    dispatch({ kind: "spawn-requested" });

    void spawnTerminal(send, {
      terminalId,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      ...(cwd === undefined ? {} : { cwd }),
    });
  }, [cwd, dispatch, send, terminalId]);

  /** End the running process. Not phase-gated here: the engine ignores a kill for
   * a terminal that is already gone, and a close that was skipped is a process
   * that outlives its panel. */
  const stop = useCallback(() => {
    void killTerminal(send, { terminalId });
  }, [send, terminalId]);

  /** Apply a paste the exit function has already ruled on. */
  const applyPaste = useCallback(
    (text: string) => {
      const decision = translatePaste(text, { confirmed: true });

      if (decision.action === "send") transmit(decision.data);
    },
    [transmit],
  );

  /** Offer a paste: send it, or ask about it first. */
  const offerPaste = useCallback(
    (text: string) => {
      const decision = translatePaste(text, { confirmed: false });

      if (decision.action === "send") {
        transmit(decision.data);
        return;
      }

      setPendingPaste({ text, lines: decision.lines });
    },
    [transmit],
  );

  /* ---------------------------------------------------------------- mount */

  useEffect(() => {
    const container = containerRef.current;

    if (container === null) return;

    // A host owns exactly one instance and refuses to be reused after disposal,
    // so a remount builds a new one. Creating it here rather than in state keeps
    // the imperative object out of React's snapshot: a re-render must not build
    // a second terminal.
    const host = createTerminalHost({ css });
    hostRef.current = host;
    host.open(container);

    const terminal = host.terminal;

    const onKey = terminal.onKey(({ key, domEvent }) => {
      lastKeyRef.current = { key, domEvent: domEvent ?? null };
    });

    const onData = terminal.onData((data) => {
      const stroke = lastKeyRef.current;

      // `null` is the exit function's "this stroke produces no bytes", and it is
      // the only reason a keystroke stops here.
      const decision = decisionForStroke({
        key: stroke.key,
        domEvent: stroke.domEvent,
        data,
        isComposing: composingRef.current,
      });

      if (decision !== null) transmit(decision);
    });

    // Composition is tracked on the container rather than on xterm's internals,
    // which are not exposed. Both events bubble from the textarea xterm owns, so
    // the capture-phase listener sees them wherever focus sits inside the panel.
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };

    const onCompositionEnd = (): void => {
      composingRef.current = false;
    };

    // The interposition described at the top of this file: capture phase, on the
    // container, and it stops the event before xterm's own paste listeners run.
    const onPaste = (event: ClipboardEvent): void => {
      const text = event.clipboardData?.getData("text/plain");

      if (text === undefined) return;

      event.preventDefault();
      event.stopPropagation();

      offerPaste(text);
    };

    container.addEventListener("compositionstart", onCompositionStart, true);
    container.addEventListener("compositionend", onCompositionEnd, true);
    container.addEventListener("paste", onPaste as EventListener, true);

    return () => {
      container.removeEventListener("compositionstart", onCompositionStart, true);
      container.removeEventListener("compositionend", onCompositionEnd, true);
      container.removeEventListener("paste", onPaste as EventListener, true);

      onKey.dispose();
      onData.dispose();

      host.dispose();
      hostRef.current = null;
    };
  }, [css, offerPaste, transmit]);

  /**
   * Copy the terminal's current selection.
   *
   * Written through the same clipboard a paste is read from. With nothing
   * selected this does nothing rather than writing an empty string: a copy
   * gesture on an empty selection must not destroy what the user had there.
   */
  const copySelection = useCallback(() => {
    const selection = hostRef.current?.terminal.getSelection() ?? "";

    if (selection === "") return;

    void globalThis.navigator?.clipboard?.writeText(selection);
  }, []);

  /** Select the whole buffer. */
  const selectAll = useCallback(() => {
    hostRef.current?.terminal.selectAll();
  }, []);

  /**
   * Paste from the clipboard through the same gate a keystroke paste uses.
   *
   * The read is asynchronous, so the decision -- send, or ask -- happens once it
   * settles. It calls `offerPaste` rather than `translatePaste` directly: there is
   * exactly one place that decides whether a paste needs confirmation, and this
   * entry is not special enough to be a second one. That is what makes the
   * right-click paste and the shortcut paste the same path.
   */
  const pasteFromClipboard = useCallback(() => {
    const clipboard = globalThis.navigator?.clipboard;

    if (clipboard === undefined) return;

    void clipboard.readText().then((text) => {
      if (text !== "") offerPaste(text);
    });
  }, [offerPaste]);

  /* --------------------------------------------------------------- render */

  /** The overflow menu's items, in the order the host supplied them. */
  const moreItems: { readonly key: string; readonly label: string; readonly run: () => void }[] =
    [];

  if (onSearch !== undefined) {
    moreItems.push({ key: "search", label: t("component.terminal.menu.search"), run: onSearch });
  }

  if (onExport !== undefined) {
    moreItems.push({ key: "export", label: t("component.terminal.menu.export"), run: onExport });
  }

  if (onOpenExternal !== undefined) {
    moreItems.push({
      key: "external",
      label: t("component.terminal.menu.openExternal"),
      run: onOpenExternal,
    });
  }

  return (
    <section
      className="ui-terminal"
      data-phase={state.phase}
      aria-label={t("component.terminal.a11y.region")}
    >
      <TerminalToolbar
        phase={state.phase}
        exitCode={state.exitCode}
        failureDetail={state.failureDetail}
        engineReady={engineReady}
        fontSize={state.fontSize}
        onReopen={reopen}
        onStop={stop}
        onClear={() => {
          setMenuOpen(false);
          transmit(CLEAR_SCREEN);
        }}
        onFontSize={setFontSize}
        onMore={() => setMenuOpen((open) => !open)}
      />

      {menuOpen && moreItems.length > 0 ? (
        <div className="ui-terminal__menu" role="menu">
          {moreItems.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={containerRef}
        className="ui-terminal__screen"
        style={{ fontSize: `${state.fontSize}px` }}
        onContextMenu={(event) => {
          // The browser's menu is replaced rather than opened, because two of its
          // items would be wrong here: it cannot see xterm's selection, and its
          // paste would bypass the line count this product asks about.
          event.preventDefault();
          setContextMenuOpen(true);
        }}
        onClick={() => setContextMenuOpen(false)}
      />

      {contextMenuOpen ? (
        <div className="ui-terminal__context-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={(hostRef.current?.terminal.getSelection() ?? "") === ""}
            onClick={() => {
              setContextMenuOpen(false);
              copySelection();
            }}
          >
            {t("component.terminal.menu.copy")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenuOpen(false);
              pasteFromClipboard();
            }}
          >
            {t("component.terminal.menu.paste")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setContextMenuOpen(false);
              selectAll();
            }}
          >
            {t("component.terminal.menu.selectAll")}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!toolbarAvailability(state.phase).canClear}
            onClick={() => {
              setContextMenuOpen(false);
              transmit(CLEAR_SCREEN);
            }}
          >
            {t("component.terminal.action.clear")}
          </button>
        </div>
      ) : null}

      {pendingPaste === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingPaste(null);
          }}
          title={t("component.terminal.paste.confirmTitle", { lines: pendingPaste.lines })}
          footer={
            <>
              <button type="button" onClick={() => setPendingPaste(null)}>
                {t("common.action.cancel")}
              </button>
              <button
                type="button"
                onClick={() => {
                  const pending = pendingPaste;

                  setPendingPaste(null);
                  applyPaste(pending.text);
                }}
              >
                {t("common.action.confirm")}
              </button>
            </>
          }
        >
          <p>{t("component.terminal.paste.confirmMessage", { lines: pendingPaste.lines })}</p>
        </Dialog>
      )}
    </section>
  );
}
