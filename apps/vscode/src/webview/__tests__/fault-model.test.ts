/**
 * The fault page: which situation, and which answers.
 *
 * The four situations exist because the answers differ, so every case here
 * asserts the *set* of actions rather than that a page rendered -- a page that
 * offered the same three buttons in all four cases would pass a "it rendered"
 * test and fail a user. The count is asserted separately from the names, because
 * the requirement is that the sets differ, not that they are non-empty.
 *
 * Nothing here is about copy: the model resolves no sentences (it cannot, the
 * i18n gate counts only `t()` literals), so the wording is asserted in
 * `ShellFault.test.tsx` where it is actually rendered.
 */

import { describe, expect, it } from "vitest";

import { toShellFault, type FaultInput, type ShellFaultAction } from "../errors/model.js";

/** One failure per situation, with the facts each one carries. */
const MISSING: FaultInput = {
  kind: "missing-engine",
  detail: "no engine to start",
  searchedPaths: ["/opt/haruyuki", "/usr/local/bin"],
};

const INVALID: FaultInput = {
  kind: "start-failed",
  detail: "the picked directory is not an engine",
  candidateDir: "/tmp/not-an-engine",
  missingEntries: ["haruyuki.js", "node_modules"],
};

const UNTESTED: FaultInput = {
  kind: "untested-engine",
  detail: "the engine reports version 2.0.0",
  candidateDir: "/opt/haruyuki",
  expectedVersion: "1.4.0",
  actualVersion: "2.0.0",
};

const NO_WORKSPACE: FaultInput = {
  kind: "no-workspace",
  detail: "no workspace folder is open",
  homeDir: "/home/somebody",
};

/** @returns the answers, as the requirement talks about them */
function actionsOf(failure: FaultInput): readonly ShellFaultAction[] {
  return toShellFault(failure).actions;
}

describe("the fault model", () => {
  it("gives each situation its own action set", () => {
    const missing = actionsOf(MISSING);
    const invalid = actionsOf(INVALID);
    const untested = actionsOf(UNTESTED);
    const noWorkspace = actionsOf(NO_WORKSPACE);

    // The four sets are pairwise different. Asserted as a set of serialized
    // lists rather than one comparison each, so the reason this case exists --
    // the sets must not converge -- is stated once.
    const distinct = new Set(
      [missing, invalid, untested, noWorkspace].map((actions) => actions.join(",")),
    );

    expect(distinct.size).toBe(4);
  });

  it("names the situation rather than the wire kind", () => {
    expect(toShellFault(MISSING).situation).toBe("engineMissing");
    expect(toShellFault(INVALID).situation).toBe("invalidEngineDir");
    expect(toShellFault(UNTESTED).situation).toBe("untestedEngine");
    expect(toShellFault(NO_WORKSPACE).situation).toBe("noWorkspace");
  });

  it("offers the three ways to look for an engine it could not find", () => {
    // Choosing a directory is the repair; the setting and the log are how the
    // user finds out why the first three rungs failed.
    expect(actionsOf(MISSING)).toEqual(["chooseEngineDir", "openSettings", "openLogs"]);
  });

  it("offers a second pick when the folder was refused", () => {
    // No `openSettings`: the user has just come from a picker, so what they need
    // is another pick, not the page that decides where the picker started.
    expect(actionsOf(INVALID)).toEqual(["chooseEngineDir", "openLogs"]);
  });

  it("lets the untested build be connected to anyway", () => {
    // The override leads, and the careful answer is offered beside it rather than
    // replaced by it. No `openLogs`: nothing has failed here.
    expect(actionsOf(UNTESTED)).toEqual(["connectAnyway", "chooseEngineDir"]);
  });

  it("offers a folder or the home directory, and nothing else", () => {
    // Deliberately no `retry`: re-running the same resolution without a folder
    // produces this same page, so the two answers are the only real ones.
    expect(actionsOf(NO_WORKSPACE)).toEqual(["openFolder", "useHomeDir"]);
  });

  it("requires a confirmation only for the home directory", () => {
    expect(toShellFault(NO_WORKSPACE).confirmsHomeDir).toBe(true);
    expect(toShellFault(MISSING).confirmsHomeDir).toBe(false);
    expect(toShellFault(INVALID).confirmsHomeDir).toBe(false);
    expect(toShellFault(UNTESTED).confirmsHomeDir).toBe(false);
  });

  it("carries the failure the page renders, unchanged", () => {
    // The page shows the host's facts, not the model's summary of them: a second
    // copy here would be a second place the expected version could come from.
    expect(toShellFault(UNTESTED).failure).toBe(UNTESTED);
    expect(toShellFault(UNTESTED).failure.expectedVersion).toBe("1.4.0");
    expect(toShellFault(UNTESTED).failure.actualVersion).toBe("2.0.0");
  });

  it("treats a crash and an internal failure as a missing engine", () => {
    // From the page's side these are the same question -- it is not running, and
    // here is where to look -- so they share its answers instead of a third page
    // that offers the same two buttons under another heading.
    expect(toShellFault({ kind: "crash", detail: "the child died" }).situation).toBe(
      "engineMissing",
    );
    expect(toShellFault({ kind: "internal", detail: "a bug" }).situation).toBe("engineMissing");
  });

  it("falls back to the missing-engine page for a kind it cannot place", () => {
    // A kind added on the wire and not here must still render something usable
    // rather than throw during a failure, which is the worst possible moment for
    // an unhandled case.
    expect(toShellFault({ kind: "something-new", detail: "?" }).situation).toBe("engineMissing");
  });
});
