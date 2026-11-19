/**
 * Toolbar tests.
 *
 * What is worth asserting here
 *   The bar has no logic of its own except one decision table -- which action is
 *   available in which phase -- and one sentence per phase. Both are asserted as
 *   values, in full, so a phase that quietly gains or loses an action fails a
 *   test that names the phase rather than showing up as a button that renders a
 *   shade differently.
 *
 * The `failed` and `exited` sentences get their own block because the two phases
 * exist for one reason: a spawn that never started and a shell that ran and
 * ended are different facts about the machine, and telling a user the wrong one
 * sends them to look at the wrong thing. Merging them is the single most likely
 * implementation mistake, and every merge collapses into the same observable --
 * "terminated with code 1" for a process that was never created.
 *
 * Why the CSS fixture is a minimal subset
 *   The renderer may not import a Node builtin, so this cannot read the real
 *   stylesheet either. Nothing below asserts appearance; the fixture exists
 *   because `Button` installs the component sheet on render and needs a document.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import type { TerminalPhase } from "./state.js";
import { FONT_MAX, FONT_MIN, TerminalToolbar, toolbarAvailability } from "./toolbar.js";

/** Every phase, so a missing case is a compile error and a test failure at once. */
const PHASES: readonly TerminalPhase[] = [
  "idle",
  "starting",
  "running",
  "exited",
  "failed",
  "disconnected",
];

/**
 * Render the toolbar in English.
 *
 * @param overrides props to override
 * @returns the props the render used, so a test can assert on the callbacks
 */
function renderToolbar(overrides: Partial<Parameters<typeof TerminalToolbar>[0]> = {}) {
  const props: Parameters<typeof TerminalToolbar>[0] = {
    phase: "idle",
    exitCode: null,
    failureDetail: null,
    engineReady: true,
    fontSize: 13,
    onReopen: vi.fn(),
    onStop: vi.fn(),
    onClear: vi.fn(),
    onClearAll: vi.fn(),
    onFontSize: vi.fn(),
    onMore: vi.fn(),
    ...overrides,
  };

  render(
    <LocaleProvider locale="en">
      <TerminalToolbar {...props} />
    </LocaleProvider>,
  );

  return props;
}

/**
 * Find the button whose visible label is `label`.
 *
 * @param label the exact visible text
 * @returns the button element
 */
function button(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

describe("toolbarAvailability: the table, in full", () => {
  it("offers reopen in exactly the three phases that have no live session", () => {
    const offering = PHASES.filter((phase) => toolbarAvailability(phase).canReopen);

    expect(offering).toEqual(["idle", "exited", "failed"]);
  });

  it("offers stop and clear in exactly one phase", () => {
    const offering = PHASES.filter((phase) => toolbarAvailability(phase).canStop);

    expect(offering).toEqual(["running"]);
    expect(PHASES.filter((phase) => toolbarAvailability(phase).canClear)).toEqual(["running"]);
  });

  it("never offers a second spawn while one is in flight or live", () => {
    // The defect this prevents is two spawn requests behind one panel, which the
    // engine coalesces into one answer the panel then has to guess about.
    expect(toolbarAvailability("starting").canReopen).toBe(false);
    expect(toolbarAvailability("running").canReopen).toBe(false);
  });

  it("never offers anything after a disconnect", () => {
    // The engine ended every PTY when the connection closed, so none of the three
    // has a target. Reopen returns when readiness does, not before.
    expect(toolbarAvailability("disconnected")).toEqual({
      canReopen: false,
      canStop: false,
      canClear: false,
    });
  });

  it("answers for every phase, so no phase can fall through to undefined", () => {
    for (const phase of PHASES) {
      const answer = toolbarAvailability(phase);

      expect(typeof answer.canReopen).toBe("boolean");
      expect(typeof answer.canStop).toBe("boolean");
      expect(typeof answer.canClear).toBe("boolean");
    }
  });
});

describe("TerminalToolbar: the buttons enabled from that table", () => {
  it("enables only reopen when nothing is running", () => {
    renderToolbar({ phase: "exited" });

    expect(button("Reopen").disabled).toBe(false);
    expect(button("Stop").disabled).toBe(true);
    expect(button("Clear").disabled).toBe(true);
  });

  it("enables only stop and clear while the shell runs", () => {
    renderToolbar({ phase: "running" });

    expect(button("Reopen").disabled).toBe(true);
    expect(button("Stop").disabled).toBe(false);
    expect(button("Clear").disabled).toBe(false);
  });

  it("enables nothing while a spawn is in flight", () => {
    renderToolbar({ phase: "starting" });

    expect(button("Reopen").disabled).toBe(true);
    expect(button("Stop").disabled).toBe(true);
    expect(button("Clear").disabled).toBe(true);
  });

  it("reports a press rather than acting on it", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ phase: "running" });

    await user.click(button("Clear"));

    expect(props.onClear).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalToolbar: the two idle sentences", () => {
  it("says the engine is not connected when it is not", () => {
    // "Idle" covers both "never started" and "recovered from a disconnect", and
    // those need different sentences. The panel reads readiness; the phase
    // machine deliberately does not store it.
    renderToolbar({ phase: "idle", engineReady: false });

    expect(screen.getByText("Not connected to the engine")).toBeDefined();
  });

  it("says the connection came back when it did", () => {
    renderToolbar({ phase: "idle", engineReady: true });

    expect(screen.getByText("Connection restored; reopen to start a new session")).toBeDefined();
  });

  it("does not show both sentences at once", () => {
    renderToolbar({ phase: "idle", engineReady: true });

    expect(screen.queryByText("Not connected to the engine")).toBeNull();
  });
});

describe("TerminalToolbar: exited and failed are different sentences", () => {
  it("reports the exit code for a shell that ran and ended", () => {
    renderToolbar({ phase: "exited", exitCode: 0 });

    expect(screen.getByText("Exited with code 0")).toBeDefined();
  });

  it("reports a non-zero exit code as a code, not as a failure", () => {
    // A shell that ran and returned 7 did what it was told. Calling that a
    // failure would advise a user to fix a configuration that works.
    renderToolbar({ phase: "exited", exitCode: 7 });

    expect(screen.getByText("Exited with code 7")).toBeDefined();
    expect(screen.queryByText(/could not be started/)).toBeNull();
  });

  it("reports a spawn failure with the engine's own text", () => {
    // The engine knows why the spawn failed; the panel must not put words in its
    // mouth, so its text is interpolated verbatim.
    renderToolbar({ phase: "failed", failureDetail: "pty allocation failed" });

    expect(screen.getByText("The shell could not be started: pty allocation failed")).toBeDefined();
  });

  it("never shows an exit code for a spawn that never started", () => {
    // This is the merge, stated as an assertion: a failed spawn's 1 is a marker
    // for "this was not an exit", and a panel that prints it sends the user to
    // look at their shell instead of the engine's spawn path.
    renderToolbar({ phase: "failed", failureDetail: "boom", exitCode: 1 });

    expect(screen.queryByText(/Exited with code/)).toBeNull();
    expect(screen.getByText(/could not be started/)).toBeDefined();
  });

  it("never shows a failure text for a shell that exited", () => {
    renderToolbar({ phase: "exited", exitCode: 0, failureDetail: "stale text from before" });

    expect(screen.queryByText(/stale text from before/)).toBeNull();
  });
});

describe("TerminalToolbar: the font ladder", () => {
  it("steps the size by one", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ fontSize: 13 });

    await user.click(button("Larger terminal text"));
    expect(props.onFontSize).toHaveBeenCalledWith(14);

    await user.click(button("Smaller terminal text"));
    expect(props.onFontSize).toHaveBeenCalledWith(12);
  });

  it("stops at the ends of the ladder instead of offering a size it clamps", () => {
    // A button that is enabled and then silently clamps is a control that lies
    // about what it did.
    renderToolbar({ fontSize: FONT_MIN });
    expect(button("Smaller terminal text").disabled).toBe(true);
    expect(button("Larger terminal text").disabled).toBe(false);
  });

  it("stops at the top too", () => {
    renderToolbar({ fontSize: FONT_MAX });
    expect(button("Smaller terminal text").disabled).toBe(false);
    expect(button("Larger terminal text").disabled).toBe(true);
  });

  it("stays available while a shell starts, because it is a view setting", () => {
    renderToolbar({ phase: "starting", fontSize: 13 });

    expect(button("Larger terminal text").disabled).toBe(false);
  });
});

describe("TerminalToolbar: the overflow trigger", () => {
  it("hands over the element it was pressed from, so a popup can anchor to it", async () => {
    const user = userEvent.setup();
    const props = renderToolbar({ phase: "running" });

    const more = button("More actions");
    await user.click(more);

    expect(props.onMore).toHaveBeenCalledWith(more);
  });
});
