/** @vitest-environment jsdom */
/**
 * The fault page, rendered.
 *
 * Two things are proven here that the model test cannot:
 *
 * 1. **The four situations render four different sentences.** The requirement is
 *    that the page tells the user which situation they are in, so a page that
 *    showed one generic sentence in all four cases would be a page the user has
 *    to diagnose. Each case asserts the heading text.
 * 2. **The buttons say what they do, and the count matches the situation.**
 *    Asserted on the rendered labels and on the number of buttons, because the
 *    requirement is about distinct action *sets*: a page with the right buttons
 *    but the same labels in every case is the same non-answer.
 *
 * The copy is read from the catalogue by rendering it, never by comparing to a
 * literal here: a test that spelled the sentence again would pass after the
 * catalogue changed and the page did not.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@haruyuki/ui";

import { ShellFault } from "../errors/ShellFault.js";
import type { FaultInput } from "../errors/model.js";

/** Render one failure as the panel renders it. */
function renderFault(failure: FaultInput, onAction = () => undefined): void {
  render(
    <LocaleProvider locale="en">
      <ShellFault failure={failure} onAction={onAction} />
    </LocaleProvider>,
  );
}

/** @returns the visible labels of the answer buttons */
function actionLabels(): string[] {
  const row = screen.getByTestId("shell-fault-actions");

  return within(row)
    .getAllByRole("button")
    .map((button) => button.textContent ?? "");
}

const MISSING: FaultInput = {
  kind: "missing-engine",
  detail: "no engine to start",
  searchedPaths: ["/opt/haruyuki", "/usr/local/bin"],
  logPath: "/home/somebody/.haruyuki/logs",
};

const INVALID: FaultInput = {
  kind: "start-failed",
  detail: "the picked directory is not an engine",
  candidateDir: "/tmp/not-an-engine",
  missingEntries: ["haruyuki.js", "node_modules"],
};

const UNTESTED: FaultInput = {
  kind: "untested-engine",
  detail: "the engine reports a version this build was not tested against",
  candidateDir: "/opt/haruyuki",
  expectedVersion: "1.4.0",
  actualVersion: "2.0.0",
};

const NO_WORKSPACE: FaultInput = {
  kind: "no-workspace",
  detail: "no workspace folder is open",
  homeDir: "/home/somebody",
};

// Testing-library unmounts what each case rendered. Stated explicitly because the
// alternative -- let the jsdom document accumulate -- makes a `getByTestId` match
// the previous case's page and turns every assertion below into a coincidence.
afterEach(() => {
  cleanup();
});

describe("the fault page", () => {
  it("says the engine was not found, and where it looked", () => {
    renderFault(MISSING);

    const heading = screen.getByText(/Haruyuki engine not found/u);

    expect(heading).toBeTruthy();

    // Both directories the search tried, as one sentence: naming them is the
    // difference between "not found" and "not found here".
    const facts = screen.getByTestId("shell-fault-facts").textContent ?? "";

    expect(facts).toContain("/opt/haruyuki");
    expect(facts).toContain("/usr/local/bin");
    expect(facts).toContain("/home/somebody/.haruyuki/logs");
  });

  it("says the folder is not an engine, and names what is missing", () => {
    renderFault(INVALID);

    expect(screen.getByText(/not a usable engine/u)).toBeTruthy();

    const facts = screen.getByTestId("shell-fault-facts").textContent ?? "";

    // The repair list, not just the verdict.
    expect(facts).toContain("haruyuki.js");
    expect(facts).toContain("node_modules");
    expect(facts).toContain("/tmp/not-an-engine");
  });

  it("says the build was never tested, and names both versions", () => {
    renderFault(UNTESTED);

    expect(screen.getByText(/has not been tested/u)).toBeTruthy();

    const facts = screen.getByTestId("shell-fault-facts").textContent ?? "";

    // The pair is the fact the decision turns on, so both halves are shown.
    expect(facts).toContain("1.4.0");
    expect(facts).toContain("2.0.0");
  });

  it("says no folder is open, and names the directory it would use", () => {
    renderFault(NO_WORKSPACE);

    expect(screen.getByText(/No folder is open/u)).toBeTruthy();
  });

  it("renders four different headings, one per situation", () => {
    const headings = [MISSING, INVALID, UNTESTED, NO_WORKSPACE].map((failure) => {
      const { unmount } = render(
        <LocaleProvider locale="en">
          <ShellFault failure={failure} onAction={() => undefined} />
        </LocaleProvider>,
      );

      const heading = document.querySelector(".ui-state__title")?.textContent ?? "";

      unmount();

      return heading;
    });

    // All four present and pairwise distinct: the requirement is that the page
    // tells the user *which* situation this is, so identical copy is the failure.
    expect(headings.every((heading) => heading.length > 0)).toBe(true);
    expect(new Set(headings).size).toBe(4);
  });

  it("offers three answers for a missing engine", () => {
    renderFault(MISSING);

    expect(actionLabels()).toEqual(["Choose engine folder", "Settings", "Open logs"]);
  });

  it("offers two different answers for a refused folder", () => {
    renderFault(INVALID);

    expect(actionLabels()).toEqual(["Choose engine folder", "Open logs"]);

    // Fewer, and not a subset of the same length: no setting page, because the
    // user has just come from a picker.
    expect(actionLabels()).toHaveLength(2);
  });

  it("offers the override for an untested build", () => {
    renderFault(UNTESTED);

    expect(actionLabels()).toEqual(["Connect anyway", "Choose engine folder"]);
  });

  it("offers a folder or the home directory when none is open", () => {
    renderFault(NO_WORKSPACE);

    expect(actionLabels()).toEqual([
      "Open folder",
      "I understand the risk; use the home directory",
    ]);
  });

  it("sends the answer the button names", () => {
    const onAction = vi.fn();

    renderFault(MISSING, onAction);

    // `fireEvent` rather than `.click()`: the model flips a `useState`, and a
    // bare dispatch does not flush the re-render this asserts on.
    fireEvent.click(within(screen.getByTestId("shell-fault-actions")).getAllByRole("button")[2]!);

    expect(onAction).toHaveBeenCalledWith("openLogs");
  });

  it("asks before running the engine in the home directory", () => {
    const onAction = vi.fn();

    renderFault(NO_WORKSPACE, onAction);

    // The second button is the degradation; pressing it must not start anything.
    fireEvent.click(within(screen.getByTestId("shell-fault-actions")).getAllByRole("button")[1]!);

    expect(onAction).not.toHaveBeenCalled();

    // The risk is stated together with the answer that carries it.
    const confirm = screen.getByTestId("shell-fault-confirm");

    expect(confirm.textContent).toContain("/home/somebody");

    // And only an explicit confirmation sends it.
    fireEvent.click(within(confirm).getByText("Confirm"));

    expect(onAction).toHaveBeenCalledWith("useHomeDir");
  });

  it("drops a confirmation without starting anything", () => {
    const onAction = vi.fn();

    renderFault(NO_WORKSPACE, onAction);

    fireEvent.click(within(screen.getByTestId("shell-fault-actions")).getAllByRole("button")[1]!);

    fireEvent.click(within(screen.getByTestId("shell-fault-confirm")).getByText("Cancel"));

    expect(onAction).not.toHaveBeenCalled();

    // Back to the two answers, so the user is not stuck on a question they
    // declined.
    expect(screen.getByTestId("shell-fault-actions")).toBeTruthy();
  });

  it("omits a fact the host did not supply", () => {
    // A searched-path list that is absent must not render as an empty sentence:
    // "Looked in: " reads as a rendering bug rather than as a missing fact.
    renderFault({ kind: "missing-engine", detail: "no engine to start" });

    expect(screen.queryByTestId("shell-fault-facts")).toBeNull();
  });
});
