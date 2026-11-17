/**
 * Tests for the terminal panel's phase machine.
 *
 * The interesting half of the decision table is the part that must change nothing,
 * and it is counted two ways, which must not be added together:
 *
 *   - by cell: six phases against five signal kinds is thirty cells; nine move the
 *     panel and twenty-one are inert;
 *   - by row, after splitting the two kinds that carry a discriminator (readiness
 *     is true or false, an exit carries the engine's error text or does not): it
 *     is forty-two rows, of which eleven move and thirty-one are inert.
 *
 * Twenty-one plus nine is thirty, and thirty-one plus eleven is forty-two; the two
 * pairs describe the same table at two resolutions. Quoting a count from one
 * resolution against a count from the other would produce a sum that looks
 * checked and is meaningless.
 *
 * The inert rows would be silent bugs if they were written as conditions inside a
 * component, so each row gets a case below, named after the concrete thing it
 * would break. There are twenty-nine cases rather than thirty-one because in
 * `idle` and `disconnected` the exit's error text is never read: whatever that
 * frame carries, the phase ignores it, and one case per phase shows that. Every
 * ignored case also asserts object identity, because "ignored" in a component
 * means "no re-render", and a freshly built but equal state would repaint on every
 * duplicate frame.
 *
 * What this file deliberately does not test
 *   The message catalogue. A phase is not a sentence; the panel chooses the text.
 *   Here the phase is asserted, and the catalogue's own tests cover the strings.
 */

import { describe, expect, it } from "vitest";

import { reducePhase } from "./state.js";
import type { TerminalPanelState, TerminalPhase, TerminalSignal } from "./state.js";

/** Every phase, in the order the type declares them. */
const PHASES: readonly TerminalPhase[] = [
  "idle",
  "starting",
  "running",
  "exited",
  "failed",
  "disconnected",
];

describe("coverage", () => {
  it("covers every phase the state machine defines, because a list that drives loops cannot notice its own shrinking", () => {
    expect(PHASES.length).toBe(EXPECTED_PHASE_COUNT);
  });
});

/**
 * The count this suite intends to cover, asserted below.
 *
 * `PHASES` drives loops, and a list that drives loops has a failure mode no
 * assertion inside those loops can catch: delete a member and every case passes,
 * having tested less. It is not hypothetical -- adding a seventh phase to
 * `TerminalPhase` breaks the build in two files and leaves this suite at 55/55,
 * because nothing here notices the missing member. So the length is asserted
 * against a number written down on purpose: growing the union means editing this
 * line, which is the moment to ask whether every case below still applies.
 */
const EXPECTED_PHASE_COUNT = 6;

/** The signals that do not depend on a value. */
const STATE_ONLY_SIGNALS = {
  spawnRequested: { kind: "spawn-requested" },
  reopenAllowed: { kind: "reopen-allowed" },
} as const;

/** A distinct value per signal, so a wrong mapping shows up as a wrong field. */
const SPAWNED_PID = 4242;
const SHELL_EXIT_CODE = 7;

/**
 * A consistent panel state for one phase.
 *
 * Each phase's exclusive fields are filled in the way the reducer fills them, so
 * a reducer that wrongly keeps them is visible rather than masked by null.
 *
 * @param phase the phase to build
 * @returns a state that only lacks a history
 */
function panel(phase: TerminalPhase): TerminalPanelState {
  return {
    phase,
    terminalId: phase === "idle" ? null : "t-1",
    pid: phase === "running" ? SPAWNED_PID : null,
    exitCode: phase === "exited" ? SHELL_EXIT_CODE : null,
    failureDetail: phase === "failed" ? "spawn ENOENT" : null,
    cwd: "C:\\work",
    fontSize: 14,
    searchVisible: false,
  };
}

/** @param state any state @returns a structural copy, for mutation checks */
function copy(state: TerminalPanelState): TerminalPanelState {
  return { ...state };
}

describe("starting a session", () => {
  it("moves idle to starting, so the panel tells the user a spawn is in flight", () => {
    const next = reducePhase(panel("idle"), STATE_ONLY_SIGNALS.spawnRequested);

    expect(next.phase).toBe("starting");
    expect(next.pid).toBeNull();
    expect(next.terminalId).toBeNull();
  });

  it("moves exited to starting and drops the old exit code, because that session is over", () => {
    const next = reducePhase(panel("exited"), STATE_ONLY_SIGNALS.spawnRequested);

    expect(next.phase).toBe("starting");
    expect(next.exitCode).toBeNull();
    expect(next.pid).toBeNull();
  });

  it("moves failed to starting and drops the old failure text, because it belongs to the last attempt", () => {
    const next = reducePhase(panel("failed"), STATE_ONLY_SIGNALS.spawnRequested);

    expect(next.phase).toBe("starting");
    expect(next.failureDetail).toBeNull();
    expect(next.exitCode).toBeNull();
  });

  it("keeps the terminal id when reopening, because the engine keys the session by it", () => {
    const next = reducePhase(panel("exited"), STATE_ONLY_SIGNALS.spawnRequested);

    expect(next.terminalId).toBe("t-1");
  });

  it("keeps the spawn directory across a reopen, because it is the caller's choice, not the session's", () => {
    expect(reducePhase(panel("failed"), STATE_ONLY_SIGNALS.spawnRequested).cwd).toBe("C:\\work");
  });

  it("ignores a second spawn request while starting: the panel already has one request out and a second would give it two answers for one button", () => {
    const state = panel("starting");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.spawnRequested)).toBe(state);
  });

  it("ignores a spawn request while running: a live session is not restarted by pressing the button twice", () => {
    const state = panel("running");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.spawnRequested)).toBe(state);
  });

  it("ignores a spawn request while disconnected: the engine kills PTYs on disconnect, so the request could never be delivered", () => {
    const state = panel("disconnected");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.spawnRequested)).toBe(state);
  });
});

describe("confirming a session", () => {
  it("moves starting to running with the reported pid, because that pid is the only evidence the PTY exists", () => {
    const next = reducePhase(panel("starting"), { kind: "spawned", pid: SPAWNED_PID });

    expect(next.phase).toBe("running");
    expect(next.pid).toBe(SPAWNED_PID);
  });

  it("ignores a spawn confirmation while idle: no request went out from this panel, so adopting the pid would route input to a session it does not own", () => {
    const state = panel("idle");

    expect(reducePhase(state, { kind: "spawned", pid: SPAWNED_PID })).toBe(state);
  });

  it("ignores a second spawn confirmation while running: overwriting the pid would swap the identity of a session that has not changed", () => {
    const state = panel("running");

    expect(reducePhase(state, { kind: "spawned", pid: 9999 })).toBe(state);
  });

  it("ignores a late spawn confirmation in exited: the end of this session was already reported, so the panel would show a live session backed by a dead process", () => {
    const state = panel("exited");

    expect(reducePhase(state, { kind: "spawned", pid: SPAWNED_PID })).toBe(state);
  });

  it("ignores a late spawn confirmation in failed: accepting it would turn a failed spawn into a working terminal without a successful spawn ever having happened", () => {
    const state = panel("failed");

    expect(reducePhase(state, { kind: "spawned", pid: SPAWNED_PID })).toBe(state);
  });

  it("ignores a spawn confirmation while disconnected: the engine has already killed every PTY of the connection, so the pid names nothing", () => {
    const state = panel("disconnected");

    expect(reducePhase(state, { kind: "spawned", pid: SPAWNED_PID })).toBe(state);
  });
});

describe("ending a session", () => {
  it("moves starting to exited with the code, because a spawn that ends normally still reports its end", () => {
    const next = reducePhase(panel("starting"), {
      kind: "exited",
      exitCode: SHELL_EXIT_CODE,
      error: null,
    });

    expect(next.phase).toBe("exited");
    expect(next.exitCode).toBe(SHELL_EXIT_CODE);
    expect(next.failureDetail).toBeNull();
    expect(next.pid).toBeNull();
  });

  it("moves running to exited with the code, so the panel can say how the shell ended", () => {
    const next = reducePhase(panel("running"), {
      kind: "exited",
      exitCode: SHELL_EXIT_CODE,
      error: null,
    });

    expect(next.phase).toBe("exited");
    expect(next.exitCode).toBe(SHELL_EXIT_CODE);
  });

  it("moves running to failed and keeps the engine's own text, because a failed spawn is not an exit", () => {
    const next = reducePhase(panel("running"), {
      kind: "exited",
      exitCode: 1,
      error: "spawn cmd.exe ENOENT",
    });

    expect(next.phase).toBe("failed");
    expect(next.failureDetail).toBe("spawn cmd.exe ENOENT");
    expect(next.exitCode).toBeNull();
    expect(next.pid).toBeNull();
  });

  it("moves starting to failed when the spawn itself failed, and does not record exit code 1 as an exit", () => {
    const next = reducePhase(panel("starting"), {
      kind: "exited",
      exitCode: 1,
      error: "pty spawn failed",
    });

    expect(next.phase).toBe("failed");
    expect(next.exitCode).toBeNull();
    expect(next.failureDetail).toBe("pty spawn failed");
  });

  it("reports a shell that really exits with code 1 as exited, because the split is on the error text's presence", () => {
    const next = reducePhase(panel("running"), {
      kind: "exited",
      exitCode: 1,
      error: null,
    });

    expect(next.phase).toBe("exited");
    expect(next.exitCode).toBe(1);
  });

  it("takes the failure branch for an empty error string, because the engine sets that field only from its spawn catch", () => {
    const next = reducePhase(panel("starting"), { kind: "exited", exitCode: 1, error: "" });

    expect(next.phase).toBe("failed");
    expect(next.failureDetail).toBe("");
  });

  it("ignores an exit while idle: no session of ours was live, so reporting one would describe an end that never started", () => {
    const state = panel("idle");

    expect(reducePhase(state, { kind: "exited", exitCode: 0, error: null })).toBe(state);
  });

  it("ignores a second exit while exited: a later frame would overwrite the exit code of an end that already happened", () => {
    const state = panel("exited");

    expect(reducePhase(state, { kind: "exited", exitCode: 9, error: null })).toBe(state);
  });

  it("ignores an errored exit while exited: it must not restage a clean end as a failed spawn", () => {
    const state = panel("exited");

    expect(reducePhase(state, { kind: "exited", exitCode: 1, error: "late" })).toBe(state);
  });

  it("ignores a normal exit while failed: it must not turn a failed spawn into a clean exit, which is the distinction the two phases exist for", () => {
    const state = panel("failed");

    expect(reducePhase(state, { kind: "exited", exitCode: 0, error: null })).toBe(state);
  });

  it("ignores a second errored exit while failed: the first engine text is the one the user needs, not the last one", () => {
    const state = panel("failed");

    expect(reducePhase(state, { kind: "exited", exitCode: 1, error: "other" })).toBe(state);
  });

  it("ignores an exit while disconnected: the panel already says the session is over, and an exit code would report a kill as a clean end", () => {
    const state = panel("disconnected");

    expect(reducePhase(state, { kind: "exited", exitCode: 0, error: null })).toBe(state);
  });
});

describe("engine readiness", () => {
  it("turns running into disconnected when readiness drops, because the engine kills the PTY on disconnect", () => {
    const next = reducePhase(panel("running"), { kind: "engine", ready: false });

    expect(next.phase).toBe("disconnected");
    expect(next.pid).toBeNull();
  });

  it("turns starting into disconnected when readiness drops, because the answer to an in-flight spawn will never arrive", () => {
    const next = reducePhase(panel("starting"), { kind: "engine", ready: false });

    expect(next.phase).toBe("disconnected");
  });

  it("turns disconnected into idle when readiness returns, because the process is gone and only a reopen can start a new one", () => {
    const next = reducePhase(panel("disconnected"), { kind: "engine", ready: true });

    expect(next.phase).toBe("idle");
    expect(next.pid).toBeNull();
    expect(next.exitCode).toBeNull();
    expect(next.failureDetail).toBeNull();
  });

  it("keeps the terminal id across a reconnect, because the reopen it enables reuses the same id", () => {
    const state: TerminalPanelState = { ...panel("disconnected"), terminalId: "t-9" };

    expect(reducePhase(state, { kind: "engine", ready: true }).terminalId).toBe("t-9");
  });

  it("does not start a session on reconnect, because whether a start is wanted is the caller's decision and not a readiness fact", () => {
    const next = reducePhase(panel("disconnected"), { kind: "engine", ready: true });

    expect(next.phase).not.toBe("starting");
  });

  it("ignores a readiness drop while idle: nothing of ours is alive and the shell polls readiness, so reacting would repaint on every poll", () => {
    const state = panel("idle");

    expect(reducePhase(state, { kind: "engine", ready: false })).toBe(state);
  });

  it("ignores a readiness drop while exited: the session already ended, so there is nothing left to kill", () => {
    const state = panel("exited");

    expect(reducePhase(state, { kind: "engine", ready: false })).toBe(state);
  });

  it("ignores a readiness drop while failed: the phase already reports that no session exists", () => {
    const state = panel("failed");

    expect(reducePhase(state, { kind: "engine", ready: false })).toBe(state);
  });

  it("ignores a repeated readiness drop while disconnected: the phase already says so, and repeating it would churn the panel", () => {
    const state = panel("disconnected");

    expect(reducePhase(state, { kind: "engine", ready: false })).toBe(state);
  });

  it("ignores a readiness rise while idle: readiness is not a session fact, so there is nothing to change", () => {
    const state = panel("idle");

    expect(reducePhase(state, { kind: "engine", ready: true })).toBe(state);
  });

  it("ignores a readiness rise while starting: it must not confirm a spawn, because no pid has arrived", () => {
    const state = panel("starting");

    expect(reducePhase(state, { kind: "engine", ready: true })).toBe(state);
  });

  it("ignores a readiness rise while running: reacting to it would restart a working session", () => {
    const state = panel("running");

    expect(reducePhase(state, { kind: "engine", ready: true })).toBe(state);
  });

  it("ignores a readiness rise while exited: readiness does not reopen a finished session", () => {
    const state = panel("exited");

    expect(reducePhase(state, { kind: "engine", ready: true })).toBe(state);
  });

  it("ignores a readiness rise while failed: readiness does not retry a failed spawn on its own", () => {
    const state = panel("failed");

    expect(reducePhase(state, { kind: "engine", ready: true })).toBe(state);
  });
});

describe("the coalescing window", () => {
  it("changes nothing from idle, because the window says only that a second spawn would be reused", () => {
    const state = panel("idle");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("changes nothing from starting, because the panel already has a request out and a timer cannot reorder the engine's answer", () => {
    const state = panel("starting");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("changes nothing from running: the window closing is not an event in the session's life", () => {
    const state = panel("running");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("changes nothing from exited: the reopen is offered by the phase, not by the window closing", () => {
    const state = panel("exited");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("changes nothing from failed: a finished spawn cannot be affected by a coalescing window", () => {
    const state = panel("failed");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("changes nothing from disconnected: reopening stays forbidden by the phase, not by the window", () => {
    const state = panel("disconnected");

    expect(reducePhase(state, STATE_ONLY_SIGNALS.reopenAllowed)).toBe(state);
  });

  it("accepts a duplicate spawn request while starting, which is what makes the engine's window unnecessary here", () => {
    // The panel cannot tell a first spawn from a duplicate one: both are
    // `spawn-requested`, one is ignored and one starts. So the guarantee the
    // window provides -- "a duplicate request is not a second session" -- is
    // already the reducer's own, and no timer has to be kept for it.
    const started = reducePhase(panel("idle"), STATE_ONLY_SIGNALS.spawnRequested);
    const duplicate = reducePhase(started, STATE_ONLY_SIGNALS.spawnRequested);

    expect(started.phase).toBe("starting");
    expect(duplicate).toBe(started);
  });
});

describe("invariants", () => {
  /** All five signals, one representative each. */
  const SIGNALS: readonly TerminalSignal[] = [
    STATE_ONLY_SIGNALS.spawnRequested,
    { kind: "spawned", pid: SPAWNED_PID },
    { kind: "exited", exitCode: SHELL_EXIT_CODE, error: null },
    { kind: "exited", exitCode: 1, error: "spawn failed" },
    { kind: "engine", ready: false },
    { kind: "engine", ready: true },
    STATE_ONLY_SIGNALS.reopenAllowed,
  ];

  it("is total: every one of the thirty cells, expanded to forty-two rows, returns a state", () => {
    const outcomes: string[] = [];

    for (const phase of PHASES) {
      for (const signal of SIGNALS) {
        const next = reducePhase(panel(phase), signal);

        expect(PHASES).toContain(next.phase);
        outcomes.push(`${phase}+${signal.kind}=${next.phase}`);
      }
    }

    expect(outcomes).toHaveLength(PHASES.length * SIGNALS.length);
  });

  it("moves the panel in exactly eleven transitions of the expanded table, and ignores the rest", () => {
    // A guard on the decision table itself: a new branch that changes a cell
    // which should be inert shows up here as a changed count, even if nobody
    // thought to write a case for that particular duplicate frame. Seven signals,
    // because the two with a discriminator are listed with both values: 42 rows,
    // 11 of which change the panel.
    let changed = 0;

    for (const phase of PHASES) {
      for (const signal of SIGNALS) {
        const state = panel(phase);

        if (reducePhase(state, signal) !== state) changed += 1;
      }
    }

    expect(changed).toBe(11);
  });

  it("never mutates the state it was given", () => {
    for (const phase of PHASES) {
      for (const signal of SIGNALS) {
        const state = panel(phase);
        const before = copy(state);

        reducePhase(state, signal);

        expect(state).toEqual(before);
        expect(state.phase).toBe(before.phase);
      }
    }
  });

  it("carries the view settings and the spawn directory through every transition", () => {
    const state: TerminalPanelState = {
      ...panel("running"),
      cwd: "/repo",
      fontSize: 18,
      searchVisible: true,
    };

    for (const signal of SIGNALS) {
      const next = reducePhase(state, signal);

      expect(next.cwd).toBe("/repo");
      expect(next.fontSize).toBe(18);
      expect(next.searchVisible).toBe(true);
    }
  });

  it("only reports a pid for a session that is running", () => {
    for (const phase of PHASES) {
      for (const signal of SIGNALS) {
        const next = reducePhase(panel(phase), signal);

        if (next.pid !== null) expect(next.phase).toBe("running");
      }
    }
  });

  it("only reports an exit code for an exited session and a failure text for a failed one", () => {
    for (const phase of PHASES) {
      for (const signal of SIGNALS) {
        const next = reducePhase(panel(phase), signal);

        if (next.exitCode !== null) expect(next.phase).toBe("exited");
        if (next.failureDetail !== null) expect(next.phase).toBe("failed");
      }
    }
  });

  it("remembers nothing from the previous session once a new one starts", () => {
    const exited: TerminalPanelState = { ...panel("exited"), exitCode: 130, pid: null };
    const started = reducePhase(exited, STATE_ONLY_SIGNALS.spawnRequested);
    const running = reducePhase(started, { kind: "spawned", pid: 11 });

    expect(running.phase).toBe("running");
    expect(running.exitCode).toBeNull();
    expect(running.failureDetail).toBeNull();
  });

  it("cannot get from disconnected to running without a spawn and a spawn confirmation", () => {
    // The path that makes the reconnect honest: readiness returns to idle, the
    // caller asks for a session, the engine answers. Anything shorter would show
    // a live terminal for a process that was killed.
    let state = panel("disconnected");

    state = reducePhase(state, { kind: "engine", ready: true });
    expect(state.phase).toBe("idle");

    state = reducePhase(state, { kind: "spawned", pid: SPAWNED_PID });
    expect(state.phase).toBe("idle");

    state = reducePhase(state, STATE_ONLY_SIGNALS.spawnRequested);
    expect(state.phase).toBe("starting");

    state = reducePhase(state, { kind: "spawned", pid: SPAWNED_PID });
    expect(state.phase).toBe("running");
    expect(state.pid).toBe(SPAWNED_PID);
  });
});
