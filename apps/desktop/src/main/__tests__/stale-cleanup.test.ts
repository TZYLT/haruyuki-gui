/**
 * The stale-engine confirmation dialog.
 *
 * What these tests pin is the part that can hurt somebody: an empty list must not
 * open a dialog, Cancel must not kill, a failure must come back as a readable
 * reason rather than a throw, and the dialog must name enough about a process for
 * a user to decide. The real Electron dialog and the real `process.kill` are
 * deliberately not involved -- neither can be asserted on without an app.
 */

import { describe, expect, it, vi } from "vitest";
import type { ProcessEvidence } from "@haruyuki/core";

import type { StaleCandidate } from "../supervision/boot.js";
import {
  showStaleCleanupDialog,
  type StaleCleanupDeps,
  type StaleCleanupLabels,
  type StaleCleanupMessageBoxOptions,
} from "../supervision/stale-cleanup.js";

/** Test copy that keeps the composed details visible in the message. */
const LABELS: StaleCleanupLabels = {
  title: "Leftover engine processes",
  message: (count, details) => `${count} candidate(s):\n${details}`,
  confirm: "End Processes",
  cancel: "Cancel",
};

/** Evidence that looks like a real ambiguous candidate. */
function evidence(pid: number, overrides: Partial<ProcessEvidence> = {}): ProcessEvidence {
  return {
    pid,
    alive: true,
    imagePath: `C:\\Haruyuki\\engine-${pid}.exe`,
    createdAt: "2026-11-16T10:00:00.000Z",
    runToken: null,
    tokenFileExists: false,
    portListening: false,
    matched: false,
    reason: "image path and creation time do not both agree with the marker",
    ...overrides,
  };
}

/** One candidate, defaulting to an ambiguous live process. */
function candidate(pid: number, overrides: Partial<StaleCandidate> = {}): StaleCandidate {
  return {
    pid,
    evidence: evidence(pid),
    decision: "ambiguous",
    reason: "two identity facts do not agree",
    ...overrides,
  };
}

/** The dialog, the kill and the liveness check, all controlled by the test. */
function harness(options: { response?: number; dialogError?: Error } = {}) {
  const showMessageBox = vi.fn(
    async (_options: StaleCleanupMessageBoxOptions): Promise<{ response: number }> => {
      if (options.dialogError !== undefined) throw options.dialogError;

      return { response: options.response ?? 0 };
    },
  );
  const kill = vi.fn(async (_pid: number): Promise<void> => undefined);
  const isAlive = vi.fn((_pid: number): boolean => false);
  const settle = vi.fn(async (): Promise<void> => undefined);
  const deps: StaleCleanupDeps = { showMessageBox, kill, isAlive, settle, labels: LABELS };

  return { deps, showMessageBox, kill, isAlive, settle };
}

describe("showStaleCleanupDialog", () => {
  it("does not open a dialog when there is nothing to clean up", async () => {
    const test = harness();

    const result = await showStaleCleanupDialog([], test.deps);

    expect(result).toEqual({ ok: true, removed: [], failures: [] });
    expect(test.showMessageBox).not.toHaveBeenCalled();
    expect(test.kill).not.toHaveBeenCalled();
  });

  it("defaults to Cancel and kills nothing when the user cancels", async () => {
    const test = harness({ response: 1 });

    const result = await showStaleCleanupDialog([candidate(4101), candidate(4102)], test.deps);

    const call = test.showMessageBox.mock.calls.at(0);

    expect(call).toBeDefined();
    expect(call?.[0].buttons).toEqual([LABELS.confirm, LABELS.cancel]);
    expect(call?.[0].defaultId).toBe(1);
    expect(call?.[0].cancelId).toBe(1);
    expect(test.kill).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, removed: [], failures: [] });
  });

  it("kills every candidate only after confirmation", async () => {
    const test = harness({ response: 0 });
    const candidates = [candidate(4101), candidate(4102)];

    const result = await showStaleCleanupDialog(candidates, test.deps);

    expect(test.kill.mock.calls.map(([pid]) => pid)).toEqual([4101, 4102]);
    expect(result).toEqual({ ok: true, removed: [4101, 4102], failures: [] });
  });

  it("returns a readable reason when one kill fails and keeps the rest", async () => {
    const test = harness({ response: 0 });
    const warn = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
      flush: vi.fn(async () => undefined),
    };
    const deps: StaleCleanupDeps = { ...test.deps, logger };
    const candidates = [candidate(4101), candidate(4102)];

    test.kill.mockResolvedValueOnce(undefined);
    test.kill.mockRejectedValueOnce(new Error("access denied"));

    const result = await showStaleCleanupDialog(candidates, deps);

    expect(result.ok).toBe(false);
    expect(result.removed).toEqual([4101]);
    expect(result.failures).toEqual([{ pid: 4102, reason: "access denied" }]);
    expect(warn).toHaveBeenCalledWith(
      "supervision.stale.failed",
      expect.objectContaining({ state: "cleanup", pid: 4102, reason: "access denied" }),
    );
  });

  it("reports a candidate that is still alive after the kill", async () => {
    // The liveness re-check is what keeps a failed kill in the menu; a kill that
    // returned without an error is not evidence that the process is gone.
    const test = harness({ response: 0 });
    const candidates = [candidate(4101), candidate(4102)];

    test.isAlive.mockImplementation((pid: number) => pid === 4102);

    const result = await showStaleCleanupDialog(candidates, test.deps);

    expect(result.ok).toBe(false);
    expect(result.removed).toEqual([4101]);
    expect(result.failures).toEqual([
      { pid: 4102, reason: "process is still running after the kill request" },
    ]);
  });

  it("kills nothing when the dialog itself fails", async () => {
    const test = harness({ dialogError: new Error("no display") });

    const result = await showStaleCleanupDialog([candidate(4101)], test.deps);

    expect(test.kill).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      removed: [],
      failures: [{ pid: 0, reason: "dialog failed" }],
    });
  });

  it("lists the PID, image, start time, decision and reason of each candidate", async () => {
    const test = harness({ response: 1 });
    const candidates = [
      candidate(4101, { reason: "creation time differs" }),
      candidate(4102, {
        evidence: evidence(4102, { imagePath: null, createdAt: null }),
      }),
    ];

    await showStaleCleanupDialog(candidates, test.deps);

    const call = test.showMessageBox.mock.calls.at(0);

    expect(call).toBeDefined();

    const options = call?.[0];

    expect(options?.message).toContain("2 candidate(s)");
    expect(options?.message).toContain("PID 4101");
    expect(options?.message).toContain("C:\\Haruyuki\\engine-4101.exe");
    expect(options?.message).toContain("2026-11-16T10:00:00.000Z");
    expect(options?.message).toContain("ambiguous");
    expect(options?.message).toContain("creation time differs");
    expect(options?.message).toContain("unknown");
  });
});
