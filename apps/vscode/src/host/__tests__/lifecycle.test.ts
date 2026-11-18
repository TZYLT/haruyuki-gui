/**
 * The teardown sequence: order, budget, idempotency and the token file.
 *
 * No child, no panel and no editor are involved. The three collaborators are
 * recording doubles, so what is asserted is the sequence a caller would observe
 * and, in one case, the wall clock.
 *
 * The case this file exists for is the budget one. `deactivate` is asked for a
 * promise the editor waits on and then gives up on, so a teardown that waits
 * for a hung child is indistinguishable from a teardown that never ran: the
 * panel stays, the token file stays and nothing is logged. The assertion is
 * therefore about settling *and* about the log line that says which step was
 * abandoned.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TOKEN_FILE_NAME as ENGINE_TOKEN_FILE_NAME } from "@haruyuki/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createLifecycle,
  DEFAULT_DISPOSE_BUDGET_MS,
  TOKEN_FILE_NAME,
  type LifecycleCoreHost,
  type LifecycleLog,
  type LifecyclePanel,
  type LifecycleStatus,
} from "../lifecycle.js";

/** Temp roots created by a test, removed in `afterEach`. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A `tokenDir` holding one token file, as the engine would have left it. */
function tokenDir(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-lifecycle-"));

  roots.push(root);

  writeFileSync(join(root, TOKEN_FILE_NAME), "deadbeef\n", "utf8");

  return root;
}

/** Everything one teardown reports, in the order it reported it. */
type Recorded = {
  /** Step names and log codes, interleaved: the observable sequence. */
  readonly events: string[];
  readonly codes: string[];
  readonly log: LifecycleLog;
};

/**
 * A log that records instead of appending to a channel.
 *
 * @returns the recorder
 */
function recorder(): Recorded {
  const events: string[] = [];
  const codes: string[] = [];

  return {
    events,
    codes,
    log: {
      event(code: string): void {
        codes.push(code);

        if (code === "LIFECYCLE_TOKEN_REMOVED" || code === "LIFECYCLE_TOKEN_ABSENT") {
          events.push("token");
        }
      },
      failure(code: string): void {
        codes.push(code);
      },
    },
  };
}

/** A panel whose close resolves immediately and is recorded. */
function panel(recording: Recorded): LifecyclePanel {
  return {
    async close(): Promise<void> {
      recording.events.push("panel");
      recording.codes.push("PANEL_CLOSED");
    },
  };
}

/** A core host whose stop resolves immediately and is recorded. */
function coreHost(recording: Recorded): LifecycleCoreHost {
  return {
    async stop(): Promise<void> {
      recording.events.push("core");
      recording.codes.push("CORE_STOPPED");
    },
  };
}

/** A status bar that records the state it was asked to render. */
function status(): LifecycleStatus & { readonly states: string[] } {
  const states: string[] = [];

  return {
    states,
    set(state): void {
      states.push(state);
    },
  };
}

describe("lifecycle: the teardown order", () => {
  it("closes the panel, stops the core, then removes the token file", async () => {
    const recording = recorder();
    const dir = tokenDir();
    const bar = status();

    await createLifecycle({
      panel: panel(recording),
      coreHost: coreHost(recording),
      tokenDir: dir,
      log: recording.log,
      status: bar,
    }).dispose();

    // The sequence, asserted as one list: a teardown that stopped the core
    // before closing the panel would fail here even though both calls happened.
    expect(recording.events).toEqual(["panel", "core", "token"]);

    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
    expect(bar.states).toEqual(["inactive"]);
  });

  it("removes the token file only after the core has exited", async () => {
    const recording = recorder();
    const dir = tokenDir();
    let tokenPresentAtStop: boolean | undefined;

    await createLifecycle({
      coreHost: {
        async stop(): Promise<void> {
          // The assertion the order exists for: the file is still there while
          // the process that reads it is still being waited on.
          tokenPresentAtStop = existsSync(join(dir, TOKEN_FILE_NAME));
        },
      },
      tokenDir: dir,
      log: recording.log,
    }).dispose();

    expect(tokenPresentAtStop).toBe(true);
    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
  });
});

describe("lifecycle: the budget", () => {
  it("ships a budget that leaves room under the editor's own ceiling", () => {
    // The editor stops waiting after a few seconds; a budget equal to that
    // would settle just as the window is torn down, with nothing logged.
    expect(DEFAULT_DISPOSE_BUDGET_MS).toBeLessThanOrEqual(3_000);
    expect(DEFAULT_DISPOSE_BUDGET_MS).toBeLessThan(5_000);
  });

  it("settles within the default budget when the core never exits", async () => {
    const recording = recorder();
    const dir = tokenDir();
    const started = Date.now();

    // The child accepts the shutdown request and then hangs: the failure mode a
    // stop that awaits forever would turn into a deactivation that never ends.
    await createLifecycle({
      coreHost: { stop: () => new Promise<void>(() => undefined) },
      tokenDir: dir,
      log: recording.log,
    }).dispose();

    const elapsed = Date.now() - started;

    // The budget, plus timer granularity: a `setTimeout` for the whole budget
    // lands a few milliseconds late, and the assertion still says "the default
    // 3 seconds", not "somewhere under the editor's 5". A teardown that awaited
    // the child would sit here for the test runner's own timeout instead.
    expect(elapsed).toBeLessThanOrEqual(DEFAULT_DISPOSE_BUDGET_MS + 250);
    // Abandoned, reported, and the steps after it still ran.
    expect(recording.codes).toContain("LIFECYCLE_STEP_TIMEOUT");
    expect(recording.codes).toContain("LIFECYCLE_TOKEN_REMOVED");
    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
  });

  it("reserves time for the core when the panel never closes", async () => {
    const recording = recorder();
    const dir = tokenDir();
    let stopped = false;
    const started = Date.now();

    await createLifecycle({
      panel: { close: () => new Promise<void>(() => undefined) },
      coreHost: {
        async stop(): Promise<void> {
          stopped = true;
        },
      },
      tokenDir: dir,
      log: recording.log,
      deadlineMs: 600,
    }).dispose();

    // The panel's hang consumed its own slice only, so the child was still
    // stopped rather than left running by a webview that never answered.
    expect(stopped).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(1_100);
  });

  it("reports an overrun and still finishes the sequence", async () => {
    const recording = recorder();
    const dir = tokenDir();

    // A budget too small to cover the two steps: timer granularity makes the
    // sequence land past the deadline, which is exactly the case that has to be
    // logged rather than turned into a rejection or a hang.
    await createLifecycle({
      panel: { close: () => new Promise<void>(() => undefined) },
      coreHost: coreHost(recording),
      tokenDir: dir,
      log: recording.log,
      deadlineMs: 1,
    }).dispose();

    expect(recording.codes).toContain("LIFECYCLE_BUDGET_EXCEEDED");
    // Reported, then continued: the steps after the overrun still ran.
    expect(recording.codes).toContain("LIFECYCLE_TOKEN_REMOVED");
    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
  });
});

describe("lifecycle: idempotency", () => {
  it("runs the teardown once when dispose is called twice", async () => {
    const recording = recorder();
    const dir = tokenDir();
    let closes = 0;
    let stops = 0;

    const lifecycle = createLifecycle({
      panel: { close: async () => void (closes += 1) },
      coreHost: { stop: async () => void (stops += 1) },
      tokenDir: dir,
      log: recording.log,
    });

    await lifecycle.dispose();
    await lifecycle.dispose();

    expect(closes).toBe(1);
    expect(stops).toBe(1);
    // The second call joined the first one rather than starting another, and it
    // neither threw nor cleaned a second time.
    expect(recording.codes.filter((code) => code === "LIFECYCLE_TOKEN_REMOVED")).toHaveLength(1);
    expect(recording.codes).toContain("LIFECYCLE_DISPOSE_IGNORED");
  });

  it("joins a teardown that is still in flight", async () => {
    const recording = recorder();
    let stops = 0;
    let release: () => void = () => undefined;

    // Created up front so the test can release it after both calls are made,
    // which is what makes the second one arrive while the first is running.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const lifecycle = createLifecycle({
      coreHost: {
        stop: async () => {
          stops += 1;

          await gate;
        },
      },
      log: recording.log,
    });

    const first = lifecycle.dispose();
    const second = lifecycle.dispose();

    // Let the first call reach the child before the gate opens.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();

    await Promise.all([first, second]);

    expect(stops).toBe(1);
    expect(recording.codes).toContain("LIFECYCLE_DISPOSE_IGNORED");
    expect(recording.codes).not.toContain("LIFECYCLE_STEP_TIMEOUT");
  });

  it("does not throw when a collaborator fails", async () => {
    const recording = recorder();

    await expect(
      createLifecycle({
        panel: {
          close: async () => {
            throw new Error("already disposed");
          },
        },
        coreHost: {
          stop: async () => {
            throw new Error("child already gone");
          },
        },
        tokenDir: undefined,
        log: recording.log,
      }).dispose(),
    ).resolves.toBeUndefined();

    expect(recording.codes).toContain("PANEL_CLOSE_FAILED");
    expect(recording.codes).toContain("CORE_STOP_FAILED");
  });

  it("starts the same sequence from disposeSync and blocks nothing", async () => {
    const recording = recorder();
    const dir = tokenDir();
    let stops = 0;

    const lifecycle = createLifecycle({
      panel: panel(recording),
      coreHost: {
        stop: async () => {
          stops += 1;

          await new Promise((resolve) => setTimeout(resolve, 20));
        },
      },
      tokenDir: dir,
      log: recording.log,
    });

    // The synchronous entry returns before the child has finished stopping,
    // which is the whole difference from `dispose`.
    lifecycle.disposeSync();

    expect(stops).toBe(1);
    // It did not wait for the child, so a caller that needs the ordering uses
    // `dispose`; the token is removed at the point this call reaches it.
    expect(recording.codes).toContain("LIFECYCLE_TOKEN_REMOVED");

    await new Promise((resolve) => setTimeout(resolve, 40));

    // A later `dispose` reports instead of running a second teardown.
    await lifecycle.dispose();

    expect(stops).toBe(1);
    expect(recording.codes).toContain("LIFECYCLE_DISPOSE_IGNORED");
  });
});

describe("lifecycle: the token file", () => {
  it("uses the engine's own file name, so the path cannot depend on a copy", () => {
    expect(TOKEN_FILE_NAME).toBe(ENGINE_TOKEN_FILE_NAME);
  });

  it("removes one file and leaves the directory", async () => {
    const recording = recorder();
    const dir = tokenDir();

    await createLifecycle({
      coreHost: coreHost(recording),
      tokenDir: dir,
      log: recording.log,
    }).dispose();

    // The file is gone and the directory is still there with nothing in it: a
    // recursive delete would pass the first assertion and fail this one.
    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves a sibling file alone", async () => {
    const recording = recorder();
    const dir = tokenDir();
    const sibling = join(dir, "keep-me.log");

    writeFileSync(sibling, "not a secret\n", "utf8");

    await createLifecycle({ tokenDir: dir, log: recording.log }).dispose();

    // One known path, not "everything that looks like state".
    expect(readdirSync(dir)).toEqual(["keep-me.log"]);
    expect(existsSync(sibling)).toBe(true);
  });

  it("reports an absent token file as a success", async () => {
    const recording = recorder();
    const dir = mkdtempSync(join(tmpdir(), "haruyuki-lifecycle-"));

    roots.push(dir);

    await createLifecycle({ tokenDir: dir, log: recording.log }).dispose();

    expect(recording.codes).toContain("LIFECYCLE_TOKEN_ABSENT");
    expect(existsSync(dir)).toBe(true);
  });

  it("removes nothing when it owns no token directory", async () => {
    const recording = recorder();

    await createLifecycle({ tokenDir: undefined, log: recording.log }).dispose();

    expect(recording.codes).toContain("LIFECYCLE_TOKEN_NOT_OWNED");
    expect(recording.events).toEqual([]);
  });

  it("runs with no log at all, because a teardown is not the place to fail", async () => {
    const dir = tokenDir();

    // The one path a window with no output channel reaches: the collaborators
    // still have to be called, and nothing may throw for want of a sink.
    await expect(
      createLifecycle({ coreHost: coreHost(recorder()), tokenDir: dir }).dispose(),
    ).resolves.toBeUndefined();

    expect(existsSync(join(dir, TOKEN_FILE_NAME))).toBe(false);
  });
});
