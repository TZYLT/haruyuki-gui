/**
 * The edges a start can be asked from, and what each one is allowed to do.
 *
 * Every case here is a lifetime edge rather than a feature: a picker the user
 * dismissed, a start still in flight when the panel goes away, and a second start
 * asked for while the first has not finished. None of them is visible on the
 * happy path, and each one used to leave the host believing something that was no
 * longer true -- a replayed status its own panel refuses, a child forked after
 * teardown, two forks for one answer.
 *
 * The doubles are the ones `controller-actions.test.ts` established. They are
 * duplicated rather than shared because a recorder shared between two suites is
 * one suite's leftover state becoming the other's flaky failure.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandCall, CommandReply } from "@haruyuki/core";

import type { CoreStatusSnapshot } from "../../core/ipc.js";
import type { CoreHost } from "../core-host.js";
import { createController, type ControllerEditor, type ControllerOptions } from "../controller.js";
import type { PanelHost, PanelLink, PanelLinkFactory } from "../panel.js";
import { TESTED_ENGINE_VERSION } from "../../shared/version.js";

/** Every message the assembly posted into a panel, in order. */
const posted: Record<string, unknown>[] = [];

/** The log codes and lines the assembly wrote. */
const lines: string[] = [];

/** The panel host the assembly was handed, as far as these cases read it. */
const panel = {
  openCalls: 0,
  closeCalls: 0,
  link: null as PanelLink | null,

  reset(): void {
    panel.openCalls = 0;
    panel.closeCalls = 0;
    panel.link = null;
  },

  double(link?: PanelLinkFactory): PanelHost {
    return {
      open(): void {
        if (panel.link === null && link !== undefined) panel.link = link({ webview } as never);

        panel.openCalls += 1;
      },
      async close(): Promise<void> {
        panel.closeCalls += 1;
      },
    };
  },
};

/** The panel's own postMessage. */
const webview = {
  postMessage(message: unknown): void {
    posted.push(message as Record<string, unknown>);
  },
};

/** The core pipe, counting the one call a case asserts about. */
const core = {
  startCalls: 0,
  stopCalls: 0,
  statusListeners: new Set<(status: CoreStatusSnapshot) => void>(),

  reset(): void {
    core.startCalls = 0;
    core.stopCalls = 0;
    core.statusListeners.clear();
  },

  emitStatus(snapshot: CoreStatusSnapshot): void {
    for (const listener of [...core.statusListeners]) listener(snapshot);
  },

  double(): CoreHost {
    return {
      async start(): Promise<void> {
        core.startCalls += 1;
      },
      async invoke(call: CommandCall): Promise<CommandReply> {
        return { ok: true, completion: "answered", data: { seen: call.capability } };
      },
      async secure(): Promise<string | undefined> {
        return undefined;
      },
      async stop(): Promise<void> {
        core.stopCalls += 1;
      },
      onFrame(listener): () => void {
        return () => void listener;
      },
      onStatus(listener): () => void {
        core.statusListeners.add(listener);

        return () => {
          core.statusListeners.delete(listener);
        };
      },
      onLog(): () => void {
        return () => undefined;
      },
    };
  },
};

/** The status bar, recording the state it rendered. */
function statusDouble(): {
  state: "inactive" | "starting" | "connected" | "disconnected" | "failed";
  set(state: never): void;
  apply(snapshot: { phase: string }): void;
} {
  const sink = {
    state: "inactive" as "inactive" | "starting" | "connected" | "disconnected" | "failed",
    set(next: string): void {
      sink.state = next as never;
    },
    apply(snapshot: { phase: string }): void {
      sink.state = snapshot.phase as never;
    },
  };

  return sink as never;
}

/** Temp roots this suite created, removed afterwards. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * @returns a fresh temp root this suite owns
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-edges-"));

  roots.push(root);

  return root;
}

/**
 * Write an engine package the resolver accepts.
 *
 * @param parent the directory to create it under
 * @param version the build it reports; defaults to the tested one
 * @returns the absolute package directory
 */
function makeEngine(parent: string, version = TESTED_ENGINE_VERSION): string {
  const dir = join(parent, "engine");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "haruyuki.js"), "// entry\n", "utf8");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }), "utf8");

  return dir;
}

/** The options every case starts from; the engine search always refuses. */
function options(overrides: Partial<ControllerOptions> = {}): ControllerOptions {
  return {
    extensionPath: "/extension",
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    storageRoot: "/storage",
    toFileUri: (absPath) => ({ toString: () => `file://${absPath}` }),
    locale: "en",
    folders: [{ uri: { fsPath: "/workspace" } }],
    homeDir: "/home",
    settings: {
      read: async () => "not-an-absolute-path",
      write: async () => undefined,
    },
    pathEnv: "",
    log: {
      write: (line: string) => lines.push(line),
      event: (code: string) => lines.push(code),
      failure: (code: string) => lines.push(code),
      show: () => lines.push("LOG_SHOWN"),
      // A stand-in that never fails drops nothing.
      droppedLines: 0,
    },
    status: statusDouble(),
    createPanel: (link) => panel.double(link),
    core: core.double(),
    ...overrides,
  };
}

/** @returns the last status message the assembly posted into the panel */
function lastStatus(): Record<string, unknown> | undefined {
  const statuses = posted.filter((message) => message["kind"] === "status");

  return statuses[statuses.length - 1];
}

/**
 * Wait for the assembly's promise chain to run out.
 *
 * @param done the condition to wait for
 */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (done()) return;

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
}

beforeEach(() => {
  posted.length = 0;
  lines.length = 0;
  core.reset();
  panel.reset();
});

describe("a picker the user dismissed", () => {
  it("keeps the version override the page is still offering", async () => {
    // The engine is not the tested one, so the page shows "connect anyway" beside
    // the two versions. Dismissing the picker answers nothing: the page and its
    // buttons are unchanged, so the refusal the override answers is unchanged too.
    const dir = makeEngine(makeRoot(), "9.9.9");
    const editor: ControllerEditor = { pickEngineDirectory: async () => undefined };

    const controller = createController(
      options({
        editor,
        settings: { read: async () => dir, write: async () => undefined },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["failure"] !== undefined);

    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });

    await until(() => lines.includes("HOST_ENGINE_PICK_CANCELLED"));

    // Still the same page, so this is the click a user makes next.
    panel.link?.receive({ kind: "action", action: "connectAnyway" });

    await until(() => core.startCalls > 0);

    // The override is the answer the user gave. A dismissal in between must not
    // turn it into the plain path, which resolves again and re-refuses instead of
    // connecting.
    expect(core.startCalls).toBe(1);
  });

  it("does not replace the replayed failure with one the panel refuses", async () => {
    // The panel's reader refuses a `failed` phase with no failure, so the host
    // must never let a synthetic one become what it remembers: the replay after a
    // close and reopen is the only message a rebuilt document ever gets about a
    // refusal that was settled before it existed.
    const factoryRef: { current: PanelLinkFactory | undefined } = { current: undefined };
    let link: PanelLink | null = null;

    const rebuildingHost: PanelHost = {
      open(): void {
        panel.openCalls += 1;

        if (link === null) {
          link = factoryRef.current?.({ webview } as never) ?? null;
          panel.link = link;
        }
      },
      async close(): Promise<void> {
        panel.closeCalls += 1;
        link = null;
      },
    };

    const controller = createController(
      options({
        editor: { pickEngineDirectory: async () => undefined },
        createPanel: (factory) => {
          factoryRef.current = factory;

          return rebuildingHost;
        },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["failure"] !== undefined);

    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });

    await until(() => lines.includes("HOST_ENGINE_PICK_CANCELLED"));

    const before = posted.filter((message) => message["kind"] === "status").length;

    // What a closed dock does: the document goes away and the next open builds a
    // fresh one with an empty store.
    link = null;
    panel.link = null;

    const reopened = factoryRef.current?.({ webview } as never) ?? null;

    panel.link = reopened;

    await until(() => posted.filter((message) => message["kind"] === "status").length > before);

    const replayed = lastStatus();

    expect(replayed?.["phase"]).toBe("failed");
    // The facts travel with the phase, on the replay as much as on the first send.
    expect(replayed?.["failure"]).toBeDefined();
  });
});

describe("a start that outlives the panel", () => {
  it("does not fork a child after the assembly was closed", async () => {
    // The engine search reads a setting and stats a directory, so it is a real
    // await: a window that closes during it used to leave a start in flight that
    // forked a child after teardown had already run.
    const dir = makeEngine(makeRoot());

    let resolveRead: (value: string | undefined) => void = () => undefined;

    const slowRead = new Promise<string | undefined>((resolve) => {
      resolveRead = resolve;
    });

    const controller = createController(
      options({ settings: { read: () => slowRead, write: async () => undefined } }),
    );

    controller.open();

    await controller.close();

    resolveRead(dir);

    await until(() => core.startCalls > 0);

    // Teardown is the end of an activation: nothing may start a process after it.
    expect(core.startCalls).toBe(0);
  });
});

describe("a second start asked for while the first is in flight", () => {
  it("forks one child, not two", async () => {
    // Two answers can arrive before the first start has finished resolving (a
    // double click, or a retry the user repeated). The child is a process and the
    // engine behind it is another, so the second answer must join the first start
    // rather than begin one of its own.
    const dir = makeEngine(makeRoot());

    let resolveRead: (value: string | undefined) => void = () => undefined;

    const slowRead = new Promise<string | undefined>((resolve) => {
      resolveRead = resolve;
    });

    const controller = createController(
      options({ settings: { read: () => slowRead, write: async () => undefined } }),
    );

    controller.open();

    panel.link?.receive({ kind: "action", action: "retry" });
    panel.link?.receive({ kind: "action", action: "retry" });

    resolveRead(dir);

    await until(() => core.startCalls > 0);

    expect(core.startCalls).toBe(1);
  });
});
