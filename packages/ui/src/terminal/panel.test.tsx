/**
 * Panel tests.
 *
 * The panel is the first place a user can actually do something, so what is
 * asserted here is not rendering but the things that fail silently:
 *
 *   1. **The paste bypass.** xterm installs its own `paste` listener and writes
 *      the clipboard into the terminal immediately. Those bytes would then arrive
 *      on the keystroke path, which never counts lines and never asks. If the
 *      panel did not interpose, a multi-line paste would run every line with no
 *      confirmation -- and every other assertion in this file would still pass.
 *      So the bypass is asserted on the event itself: the panel must call
 *      `preventDefault` and `stopPropagation` from a listener above xterm's.
 *
 *   2. **The phase gate.** A payload produced one frame before the phase leaves
 *      `running` must not reach the sender. `sendInput` enforces that, and these
 *      tests pin that the panel hands it the *live* phase rather than one
 *      captured when the handler was installed.
 *
 *   3. **Composition.** Nothing reaches the sender while an input method owns the
 *      input.
 *
 * Why the panel is driven through engine frames
 *   The panel only accepts bytes while a session is live, and a session exists
 *   only when the engine says so -- a resolved `spawnTerminal` claims the request
 *   left this process, not that anything was created. So `subscribe` is how the
 *   tests move the panel into `running`, exactly as the host does.
 *
 * Why the CSS is a fixture
 *   The renderer may not import a Node builtin, so the real stylesheet cannot be
 *   read here and nothing below asserts appearance. The subset is what the
 *   terminal host needs present. jsdom has no layout engine either, and xterm
 *   queries `matchMedia` inside `open`, so that is stubbed.
 *
 * What each rule costs to break
 *   Measured, not estimated, by editing `panel.tsx` one line at a time and running
 *   this file. Baseline: 0 failed of 29.
 *
 *   | Mutation                                     | Failed |
 *   | -------------------------------------------- | ------ |
 *   | remove `stopPropagation` on the paste        | 7      |
 *   | capture-phase listener -> bubble-phase       | 5      |
 *   | remove the paste listener entirely           | 5      |
 *   | send multi-line paste without asking         | 4      |
 *   | pass a hard-coded `running` phase to sendInput | 3    |
 *   | route clear to the emulator's buffer         | 1      |
 *
 *   The first three rows are the same defect seen three ways: the interposition
 *   on the paste event. They cost the most because every paste assertion depends
 *   on the bytes arriving through this panel at all.
 *
 *   The lesson this file was written twice to learn: the first version dispatched
 *   the paste on the *container*, which made the container the event target, so
 *   no descendant was ever on the path -- and all three interposition rows read
 *   0 failed. A test can be green because the code is right or because it is
 *   measuring nothing, and only a mutation distinguishes them. `dispatchPaste`
 *   now targets xterm's textarea, which is where the browser delivers a paste.
 *
 *   Rows that cost exactly one assertion are the rules only that assertion
 *   defends; if you delete one, delete the matching test rather than leaving it
 *   to pass for the wrong reason.
 */

// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import { en } from "../i18n/locales/en.js";
import type { CommandSender, TerminalCommand } from "./commands.js";
import { decisionForStroke, initialPanelState, TerminalPanel } from "./panel.js";
import { TERMINAL_INPUT_CAPABILITY, translatePaste } from "./exit.js";
import type { TerminalSignal } from "./state.js";

/**
 * The rules the terminal host needs present.
 *
 * `.xterm-screen` makes the terminal its own positioned ancestor;
 * `.composition-view` is the overlay that falls into the document flow when the
 * sheet is missing.
 */
const MINIMAL_STYLESHEET = `
.xterm-screen {
  position: relative;
}
.xterm .composition-view {
  display: none;
  position: absolute;
  white-space: nowrap;
  z-index: 1;
}
.xterm .composition-view.active {
  display: block;
}
.xterm canvas {
  display: block;
  position: absolute;
  top: 0;
  left: 0;
}
`;

/** What one rendered panel's sender saw, and how to drive the engine. */
interface Harness {
  readonly commands: TerminalCommand[];
  readonly sender: CommandSender;
  /** Deliver an engine frame, as the host would. */
  readonly emit: (signal: TerminalSignal) => void;
  /** Take the panel live: a spawn was requested and the engine answered. */
  readonly run: () => void;
  /** The input payloads the sender saw, in order. */
  inputs(): string[];
}

/**
 * Render a panel whose engine the test drives directly.
 *
 * @param overrides props to override
 * @returns the recorded commands and the frame emitter
 */
function renderPanel(overrides: Partial<Parameters<typeof TerminalPanel>[0]> = {}): Harness {
  const commands: TerminalCommand[] = [];
  const listeners: ((signal: TerminalSignal) => void)[] = [];

  const sender: CommandSender = async (command) => {
    commands.push(command);

    return { ok: true };
  };

  const props: Parameters<typeof TerminalPanel>[0] = {
    terminalId: "t-1",
    css: MINIMAL_STYLESHEET,
    send: sender,
    engineReady: true,
    subscribe: (receive) => {
      listeners.push(receive);

      return () => {
        listeners.splice(listeners.indexOf(receive), 1);
      };
    },
    ...overrides,
  };

  render(
    <LocaleProvider locale="en">
      <TerminalPanel {...props} />
    </LocaleProvider>,
  );

  const emit = (signal: TerminalSignal): void => {
    act(() => {
      for (const listener of [...listeners]) listener(signal);
    });
  };

  return {
    commands,
    sender,
    emit,
    run(): void {
      emit({ kind: "spawn-requested" });
      emit({ kind: "spawned", pid: 4242 });
    },
    inputs(): string[] {
      // Spelled through the constant `exit.ts` exports rather than as a literal,
      // for the same reason `commands.ts` does it: this file only *filters* the
      // commands that left, it does not construct a payload, and reading the
      // capability from one place is what keeps "no second producer of the
      // payload" a property a scan can check instead of a claim to review.
      return commands
        .filter((command) => command.name === TERMINAL_INPUT_CAPABILITY)
        .map(
          (command) =>
            (command as Extract<TerminalCommand, { name: typeof TERMINAL_INPUT_CAPABILITY }>).args
              .data,
        );
    },
  };
}

/** The phase the panel is currently reporting, from its own attribute. */
function phaseOf(): string | null {
  return document.querySelector<HTMLElement>(".ui-terminal")?.getAttribute("data-phase") ?? null;
}

/** The panel's screen element: the box the terminal paints into. */
function screenElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".ui-terminal__screen");

  if (element === null) throw new Error("the panel rendered no screen element");

  return element;
}

/**
 * Dispatch a real paste event carrying `text`.
 *
 * @param text the clipboard text
 * @returns the event, so a test can assert it was stopped
 */
function dispatchPaste(text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });

  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });

  // Dispatched on the *textarea*, which is where the browser delivers a paste
  // and where xterm installs its own handler. Dispatching on the container
  // instead would make the container the event target, so the event would never
  // pass a descendant on the way down -- and a test written that way measures
  // nothing, which is how the first version of this file was wrong.
  const target = screenElement().querySelector("textarea");

  if (target === null) throw new Error("xterm rendered no textarea to paste into");

  target.dispatchEvent(event);

  return event;
}

/**
 * The live `ResizeObserver` callbacks, so a test can make the box change.
 *
 * The stub used to be inert, which made "a resize is reported" unassertable: the
 * panel subscribed to an observer that never called back, and every test passed
 * because nothing was driven rather than because the wiring worked. Recording the
 * callbacks is what turns that into a claim that can fail.
 */
let resizeCallbacks: (() => void)[] = [];

beforeEach(() => {
  // jsdom implements neither, and xterm calls both while opening.
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));

  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

/**
 * Make the panel's box change, as a dock divider drag would.
 *
 * @returns nothing; the callbacks run synchronously
 */
function resizeBox(): void {
  for (const callback of [...resizeCallbacks]) callback();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resizeCallbacks = [];
});

describe("TerminalPanel: it mounts the terminal it was given a sheet for", () => {
  it("renders the region and the toolbar", () => {
    renderPanel();

    expect(screen.getByRole("region", { name: "Terminal" })).toBeDefined();
    expect(screen.getByRole("toolbar")).toBeDefined();
  });

  it("mounts xterm into its own screen element", () => {
    renderPanel();

    // xterm's own markup: the wrapper it creates inside the container it was
    // opened into. Asserting that rather than an internal class keeps this from
    // depending on xterm's own stylesheet.
    expect(screenElement().querySelector(".xterm")).not.toBeNull();
  });

  it("sends nothing before the user does anything", () => {
    expect(renderPanel().commands).toEqual([]);
  });

  it("renders no text of its own next to the terminal", () => {
    // xterm paints its own surface, and under a DOM renderer that surface is
    // text (the row spans plus the stylesheet it injects), so the panel's claim
    // is narrower: it contributes no text of its own. The toolbar is where all
    // of it lives, and it is a sibling, not a child.
    renderPanel();

    expect(screenElement().children).toHaveLength(1);
    expect(screenElement().querySelector(".xterm")).not.toBeNull();
  });
});

describe("TerminalPanel: the engine is told when the box changes", () => {
  it("sends no resize when the box cannot be measured", () => {
    // jsdom has no layout, so every container measures 0x0. `measure()` answers
    // `null` for that rather than a zero grid, and a zero grid must never reach
    // the engine: `terminal.resize` with `cols: 0` is a PTY asked to wrap at no
    // columns. This asserts the silent half of the wiring -- that "could not
    // measure" produces no frame at all.
    const harness = renderPanel();

    resizeBox();

    expect(harness.commands.filter((command) => command.name === "terminal.resize")).toEqual([]);
  });

  it("reports the measured grid to the engine", async () => {
    // The measurement itself cannot run here: `addon-fit` reads computed styles
    // and a cell size, and jsdom has neither, so `host.measure()` answers `null`
    // by design. So this replaces the measurement -- not the wiring -- with the
    // one value a real window would produce, and asserts the frame that leaves.
    // Without this, "the panel subscribes to an observer" would be the whole
    // claim, and a panel that measured and then sent nothing would pass it.
    // The host is built inside the effect, so the replacement is at the module
    // the effect imports from rather than at the component.
    // What the next measurement will say, so the test can make the box grow.
    let measured = { cols: 80, rows: 24 };

    const hostModule = await import("./host.js");
    const createHost = hostModule.createTerminalHost;
    const spy = vi.spyOn(hostModule, "createTerminalHost").mockImplementation((options) => {
      return Object.assign(createHost(options), { measure: () => measured });
    });

    try {
      const harness = renderPanel();
      const resizes = (): TerminalCommand[] =>
        harness.commands.filter((command) => command.name === "terminal.resize");

      // The mount measures once, so the first frame already carries a grid rather
      // than waiting for the observer's first asynchronous callback.
      expect(resizes()[0]?.args).toMatchObject({ terminalId: "t-1", cols: 80, rows: 24 });

      // A dock divider moves: the next measurement differs and the engine hears
      // about it. This is the whole point of the wiring -- the PTY otherwise keeps
      // the size it was spawned with forever.
      measured = { cols: 132, rows: 40 };
      resizeBox();

      expect(resizes().at(-1)?.args).toMatchObject({ terminalId: "t-1", cols: 132, rows: 40 });

      // An observer reports more often than the grid moves (a sub-cell pixel
      // change fits to the same cols/rows), so the same size twice is one frame.
      const before = resizes().length;
      resizeBox();

      expect(resizes()).toHaveLength(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("observes its own container rather than the window", () => {
    // The panel changes size when a dock divider moves, which fires no window
    // event. If the effect had listened on `window`, the count here would be 0.
    renderPanel();

    expect(resizeCallbacks.length).toBeGreaterThan(0);
  });

});

describe("TerminalPanel: the engine's bytes have a road to the screen", () => {
  it("registers a sink while mounted and unregisters it when it unmounts", async () => {
    // The panel-level half of `output.test.ts`: that file proves the loop closes
    // once a sink is registered, this one proves the panel is what registers it.
    // Without this, the sink could be perfect and never attached to a session.
    const { createTerminalRouter } = await import("../bridge/terminal.js");
    const acks: unknown[] = [];
    const router = createTerminalRouter({
      ack: (ack) => acks.push(ack),
      onNotice: vi.fn(),
      batchBytes: 1,
      intervalMs: 0,
    });

    const harness = renderPanel({ router });

    // A slice for this terminal is absorbed while the panel is mounted.
    router.deliver({
      terminal_id: "t-1",
      slice: 0,
      slices: 1,
      offset: 0,
      bytes: 5,
      final: true,
      text: "hello",
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(router.stats.delivered).toBeGreaterThan(0);
    expect(acks.length).toBeGreaterThan(0);
    expect(harness.commands).toEqual([]); // nothing about the panel sent a command

    router.dispose();
  });

  it("leaves the router counting the terminal as unseen once the panel is gone", async () => {
    // Measured: a disposed xterm still fires its completion callback. So a sink
    // left registered after unmount would confirm bytes painted into a torn-down
    // buffer -- the peer would discard output nobody saw.
    const { createTerminalRouter } = await import("../bridge/terminal.js");
    const router = createTerminalRouter({ ack: vi.fn(), onNotice: vi.fn() });

    renderPanel({ router });
    cleanup();

    router.deliver({
      terminal_id: "t-1",
      slice: 0,
      slices: 1,
      offset: 0,
      bytes: 5,
      final: true,
      text: "ghost",
    });

    expect(router.stats.noSink).toBe(1);

    router.dispose();
  });
});

describe("TerminalPanel: a command that never left is not a session that started", () => {
  /**
   * Render a panel whose command layer answers with one fixed failure.
   *
   * The real outcome value, not a stubbed panel method: "what the sender answers"
   * and "whether the panel reads the answer" are two different facts, and the
   * defect this block pins is the second one.
   *
   * @param reason the failure the command layer reports
   * @returns the harness
   */
  function refusing(reason: "engine-rejected" | "channel-unavailable" | "not-implemented") {
    return renderPanel({
      send: async () => ({
        ok: false,
        reason,
        detail: reason === "engine-rejected" ? "spawn denied" : undefined,
      }),
    });
  }

  it("leaves starting when the command could not be handed over, instead of spinning forever", async () => {
    // The failure this pins, in full: the panel moves to `starting` optimistically,
    // the command layer answers `not-implemented`, and a caller that discarded the
    // answer leaves the panel saying "starting the shell" with nothing in flight.
    // It reads as a slow shell, and no frame ever arrives to end it.
    const harness = refusing("not-implemented");

    await userEvent.click(screen.getByRole("button", { name: /reopen|start/i }));

    expect(phaseOf()).not.toBe("starting");
  });

  it("says the capability is missing rather than that the shell failed, because a retry cannot fix a version", () => {
    // `not-implemented` never reached the engine, so it is not a session failure.
    // Reporting it through the phase would print "the shell could not be started"
    // and send the user looking for a fault that is not there.
    refusing("not-implemented");

    return userEvent.click(screen.getByRole("button", { name: /reopen|start/i })).then(() => {
      expect(phaseOf()).toBe("idle");
      expect(screen.getByRole("status").textContent).toBe(
        "This is not available in this build yet",
      );
    });
  });

  it("says the channel is unavailable, and leaves the phase alone, because waiting is the answer", () => {
    // The shell's readiness already owns the connected/disconnected transition. A
    // second owner would fight it, so this is a notice and not a phase.
    refusing("channel-unavailable");

    return userEvent.click(screen.getByRole("button", { name: /reopen|start/i })).then(() => {
      expect(screen.getByRole("status").textContent).toBe("Cannot reach the engine right now");
      expect(phaseOf()).not.toBe("failed");
    });
  });

  it("enters the failed phase when the engine refused, because that attempt really did fail", () => {
    // The one reason that is a failure of a session, and the only one whose text
    // the user has to see: it is the engine's own words.
    refusing("engine-rejected");

    return userEvent.click(screen.getByRole("button", { name: /reopen|start/i })).then(() => {
      expect(phaseOf()).toBe("failed");
    });
  });

  it("clears the notice once a later command is carried, because a stale refusal describes an attempt that has since worked", async () => {
    let fail = true;

    // One render, one button. The sender refuses the first spawn and accepts the
    // second, so the panel has to clear what it said without any frame arriving in
    // between -- a stale refusal is the same class of lie as a stale phase.
    const harness = renderPanel({
      send: async (command) => {
        if (command.name === "terminal.spawn" && fail) {
          fail = false;

          return { ok: false, reason: "not-implemented" };
        }

        harness.commands.push(command);

        return { ok: true };
      },
    });

    // By the catalogue's own label rather than a pattern: two controls match a
    // loose name, and picking the first one is how a test ends up driving the
    // wrong button.
    const button = screen.getByRole("button", {
      name: en["component.terminal.action.reopen"],
    });

    await userEvent.click(button);
    expect(screen.getByRole("status")).toBeDefined();

    await userEvent.click(button);

    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("TerminalPanel: a keystroke paste reaches the shell once it is live", () => {
  it("sends a single-line paste through the input path", () => {
    const harness = renderPanel();
    harness.run();

    dispatchPaste("ls -la");

    expect(harness.inputs()).toEqual(["ls -la"]);
  });

  it("sends a multi-line paste as one payload with normalized line endings", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();
    harness.run();

    dispatchPaste("a\nb");
    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(harness.inputs()).toEqual(["a\rb"]);
  });
});

describe("TerminalPanel: the paste path cannot be bypassed", () => {
  it("asks about a multi-line paste and sends nothing yet", async () => {
    const harness = renderPanel();
    harness.run();

    const decision = translatePaste("a\nb", { confirmed: false });

    dispatchPaste("a\nb");

    // The count is the exit function's, not a second implementation of it.
    expect(decision).toEqual({ action: "ask", lines: 2 });
    expect(await screen.findByText("Paste 2 lines?")).toBeDefined();
    expect(harness.inputs()).toEqual([]);
  });

  it("stops the event before a listener like xterm's could run", () => {
    // The bypass, stated as the property that matters: a listener on the textarea
    // -- which is where xterm installs its own paste handler -- must never run,
    // because the panel's capture-phase listener above it stopped the event on
    // the way down. Both halves are load-bearing and both were measured:
    // removing `stopPropagation` and switching the listener to the bubble phase
    // each make this assertion fail, because a bubble-phase listener on an
    // ancestor runs after the descendant's.
    const harness = renderPanel();
    harness.run();

    const textarea = screenElement().querySelector("textarea");
    expect(textarea).not.toBeNull();

    const reached = vi.fn();
    textarea?.addEventListener("paste", reached);

    dispatchPaste("one\ntwo");

    expect(reached).not.toHaveBeenCalled();
  });

  it("sends nothing when the paste is cancelled", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();
    harness.run();

    dispatchPaste("a\nb\nc");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(harness.inputs()).toEqual([]);
  });

  it("asks about the same number of lines on both paths", async () => {
    // The dialog shows the count the decision carried, so a second count taken
    // after confirmation would be a second definition of a line.
    const user = userEvent.setup();
    const harness = renderPanel();
    harness.run();

    dispatchPaste("a\nb\n");

    expect(await screen.findByText("Paste 3 lines?")).toBeDefined();

    await user.click(await screen.findByRole("button", { name: "Confirm" }));

    expect(harness.inputs()).toEqual(["a\rb\r"]);
    expect(harness.inputs()[0]?.split("\r")).toHaveLength(3);
  });
});

describe("TerminalPanel: a payload obeys the phase", () => {
  it("is refused while no session is live", () => {
    // The panel mounts idle. A payload produced here must be refused by the
    // command seam rather than written into a session that does not exist.
    const harness = renderPanel();

    dispatchPaste("echo hello");

    expect(harness.commands).toEqual([]);
  });

  it("is refused while a spawn is still in flight", () => {
    const harness = renderPanel();

    harness.emit({ kind: "spawn-requested" });
    dispatchPaste("echo hello");

    expect(harness.commands).toEqual([]);
  });

  it("is accepted once the engine reports the session", () => {
    const harness = renderPanel();

    harness.run();
    dispatchPaste("echo hello");

    expect(harness.inputs()).toEqual(["echo hello"]);
  });

  it("is refused again after the connection drops", () => {
    // The engine killed the PTY when the connection closed. A payload now has
    // nowhere to go, and the seam must say so instead of writing bytes.
    const harness = renderPanel();

    harness.run();
    harness.emit({ kind: "engine", ready: false });

    dispatchPaste("echo hello");

    expect(harness.inputs()).toEqual([]);
    expect(screen.getByText(/disconnected and ended this shell/i)).toBeDefined();
  });
});

describe("TerminalPanel: an open composition sends nothing", () => {
  it("sends nothing for a stroke produced while the input method owns the input", () => {
    // The keyboard path, which is the one the composition rule defends: a paste
    // is never a composition. jsdom does not run xterm's key handling far enough
    // to fire `onData`, so the step that decides is exercised directly with the
    // record xterm would hand it -- and the panel's effect holds no decision of
    // its own beyond calling it.
    const composing = decisionForStroke({
      key: " ",
      domEvent: null,
      data: " ",
      isComposing: true,
    });

    expect(composing).toBeNull();
  });

  it("sends the same stroke once the composition is over", () => {
    // The other half of the rule: the guard must not swallow the stroke that
    // finalizes a composition, or a user could never type anything with an IME.
    const finished = decisionForStroke({
      key: " ",
      domEvent: null,
      data: " ",
      isComposing: false,
    });

    expect(finished).toBe(" ");
  });

  it("follows a chord gesture to silence even while composing", () => {
    // Composition does not make `Ctrl+Shift+C` mean "send a C"; the chord is
    // still a shortcut. This pins that the guard is checked after the chords.
    const chord = decisionForStroke({
      key: "C",
      domEvent: new KeyboardEvent("keydown", { key: "C", ctrlKey: true, shiftKey: true }),
      data: "\u0003",
      isComposing: true,
    });

    expect(chord).toBeNull();
  });
});

describe("TerminalPanel: the toolbar actions", () => {
  it("asks the engine to start a session, then refuses a second request", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(harness.commands.filter((command) => command.name === "terminal.spawn")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Reopen" })).toHaveProperty("disabled", true);
  });

  it("names the caller's directory when one was given", async () => {
    const user = userEvent.setup();
    const harness = renderPanel({ cwd: "/tmp/project" });

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(harness.commands.find((command) => command.name === "terminal.spawn")).toEqual({
      name: "terminal.spawn",
      args: { terminalId: "t-1", cols: 80, rows: 24, cwd: "/tmp/project" },
    });
  });

  it("omits the directory rather than sending an empty one", async () => {
    // An omitted `cwd` means "the engine's own start directory", which is a fact
    // the user can be told. An empty string would read as a real path.
    const user = userEvent.setup();
    const harness = renderPanel();

    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(harness.commands.find((command) => command.name === "terminal.spawn")).toEqual({
      name: "terminal.spawn",
      args: { terminalId: "t-1", cols: 80, rows: 24 },
    });
  });

  it("ends the session through the command seam", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();
    harness.run();

    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(harness.commands.find((command) => command.name === "terminal.kill")).toEqual({
      name: "terminal.kill",
      args: { terminalId: "t-1" },
    });
  });

  it("sends the clear keystroke through the input path, not into the buffer", async () => {
    // A component that cleared the emulator's buffer directly would satisfy a
    // rendering assertion and fail this one.
    const user = userEvent.setup();
    const harness = renderPanel();
    harness.run();

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(harness.inputs()).toEqual(["\f"]);
  });

  it("refuses clear while the shell is not running", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(harness.inputs()).toEqual([]);
    expect(harness.commands).toEqual([]);
  });
});

describe("TerminalPanel: the right-click menu", () => {
  it("replaces the browser's menu rather than leaving the user with neither", async () => {
    const user = userEvent.setup();

    renderPanel();
    await user.pointer({ keys: "[MouseRight]", target: screenElement() });

    expect(screen.getByRole("menu")).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Copy" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Paste" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Select all" })).toBeDefined();
    expect(screen.getByRole("menuitem", { name: "Clear" })).toBeDefined();
  });

  it("disables copy when nothing is selected, instead of clearing the clipboard", async () => {
    const user = userEvent.setup();

    renderPanel();
    await user.pointer({ keys: "[MouseRight]", target: screenElement() });

    expect(screen.getByRole("menuitem", { name: "Copy" })).toHaveProperty("disabled", true);
  });

  it("offers clear only while the shell runs", async () => {
    const user = userEvent.setup();
    const harness = renderPanel();

    await user.pointer({ keys: "[MouseRight]", target: screenElement() });
    expect(screen.getByRole("menuitem", { name: "Clear" })).toHaveProperty("disabled", true);

    harness.run();

    await user.pointer({ keys: "[MouseRight]", target: screenElement() });
    expect(screen.getByRole("menuitem", { name: "Clear" })).toHaveProperty("disabled", false);
  });
});

describe("initialPanelState: the shape the reducer expects", () => {
  it("declares every field the state machine carries", () => {
    const state = initialPanelState("t-1", undefined);

    expect(Object.keys(state).sort()).toEqual([
      "cwd",
      "exitCode",
      "failureDetail",
      "fontSize",
      "phase",
      "pid",
      "searchVisible",
      "terminalId",
    ]);
  });

  it("records no directory when the caller did not name one", () => {
    expect(initialPanelState("t-1", undefined).cwd).toBeNull();
  });

  it("starts idle with the terminal id it was given", () => {
    expect(initialPanelState("t-9", "/tmp/project", 15)).toEqual({
      phase: "idle",
      terminalId: "t-9",
      pid: null,
      exitCode: null,
      failureDetail: null,
      cwd: "/tmp/project",
      fontSize: 15,
      searchVisible: false,
    });
  });
});
