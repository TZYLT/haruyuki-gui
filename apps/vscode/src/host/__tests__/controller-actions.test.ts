/**
 * Every answer the fault page offers, answered.
 *
 * The page's buttons are the *only* way out of a failed start, so a button the
 * host does not implement is worse than no page at all: the user is told what is
 * wrong, offered a repair, and the repair does nothing. This suite therefore
 * asserts, for each action in the model's four sets, that the controller moved
 * something -- and that nothing landed on `onAction`, which is where an
 * unanswered action is logged.
 *
 * Two further properties live here because they need the same doubles:
 *
 * - closing the panel does not stop the core (the engine is not the panel), and
 *   the status bar keeps its word;
 * - reopening a closed panel gets a new document that is told the current status,
 *   because nothing else will ever repeat a phase that was settled a while ago.
 *
 * The doubles are the ones `controller.test.ts` established; they are duplicated
 * rather than shared because a shared recorder across two suites is one suite's
 * leftover state becoming the other's flaky failure.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CommandCall, CommandReply } from "@haruyuki/core";

import type { CoreFrame, CoreStatusSnapshot } from "../../core/ipc.js";
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

/** The core pipe, recording the one call that must not happen on a panel close. */
const core = {
  startCalls: 0,
  stopCalls: 0,
  announcements: [] as { appVersion: string; bridgeVersion: string }[],
  statusListeners: new Set<(status: CoreStatusSnapshot) => void>(),

  reset(): void {
    core.startCalls = 0;
    core.stopCalls = 0;
    core.announcements.length = 0;
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
      announce(appVersion: string, bridgeVersion: string): boolean {
        core.announcements.push({ appVersion, bridgeVersion });

        return true;
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
  const root = mkdtempSync(join(tmpdir(), "haruyuki-actions-"));

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
    // The roots are made by the shell in production; a test has no filesystem.
    ensureDirectory: () => undefined,
    toFileUri: (absPath) => ({ toString: () => `file://${absPath}` }),
    locale: "en",
    folders: [{ uri: { fsPath: "/workspace" } }],
    homeDir: "/home",
    settings: {
      // Relative: the resolver refuses it as "not an absolute path", so a case
      // that wants a refusal gets the real code path and no filesystem walk.
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

/**
 * The editor seam a real build supplies.
 *
 * Supplied to the cases that assert *nothing went unanswered*: with no seam at
 * all the honest outcome is the diagnostic (asserted separately below), so a case
 * that left it out would be testing that path rather than this one.
 *
 * @returns a seam that answers every member
 */
function fullEditor(): ControllerEditor {
  return {
    pickEngineDirectory: async () => undefined,
    openSettings: () => undefined,
    openFolder: () => undefined,
  };
}

/**
 * A settings port that behaves like the real one.
 *
 * The real setting is written and then read back by the next resolution, which is
 * the property the pick path depends on: a double that answered a constant would
 * make "the pick reached the setting" untestable and, worse, pass while the
 * engine started from the directory it replaced.
 *
 * @param initial the directory the setting starts at
 * @returns the port and the writes it received
 */
function memorySettings(initial: string): {
  port: { read(): Promise<string | undefined>; write(dir: string): Promise<void> };
  written: string[];
} {
  let current = initial;
  const written: string[] = [];

  return {
    port: {
      async read(): Promise<string | undefined> {
        return current;
      },
      async write(dir: string): Promise<void> {
        current = dir;
        written.push(dir);
      },
    },
    written,
  };
}

/** @returns whether anything the assembly wrote names an unanswered action */
function unhandled(): string[] {
  return lines.filter((line) => line === "PANEL_ACTION_UNHANDLED");
}

/** @returns the last status message the assembly posted into the panel */
function lastStatus(): Record<string, unknown> | undefined {
  const statuses = posted.filter((message) => message["kind"] === "status");

  return statuses[statuses.length - 1];
}

beforeEach(() => {
  posted.length = 0;
  lines.length = 0;
  core.reset();
  panel.reset();
});

describe("the fault page's answers, as the host handles them", () => {
  it("carries the panel's announcement to the core that can answer it", async () => {
    // The panel sends `ready` after every `boot`. Neither reader on this side
    // owns it -- the command path ignores families it does not handle, and it
    // names no action -- so before this it was dropped and the core was never
    // asked whether the versions agree.
    const controller = createController(options());

    controller.open();

    await until(() => lastStatus() !== undefined);

    panel.link?.receive({ kind: "ready", appVersion: "0.1.0", bridgeVersion: "1" });

    expect(core.announcements).toEqual([{ appVersion: "0.1.0", bridgeVersion: "1" }]);
  });

  it("ignores an announcement that names no versions", async () => {
    const controller = createController(options());

    controller.open();

    await until(() => lastStatus() !== undefined);

    panel.link?.receive({ kind: "ready" });
    panel.link?.receive({ kind: "ready", appVersion: "0.1.0" });

    expect(core.announcements).toEqual([]);
  });

  it("does not leave a missing engine's three answers unanswered", async () => {
    const controller = createController(options({ editor: fullEditor() }));

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    // The page the panel renders for this failure offers exactly these.
    for (const action of ["chooseEngineDir", "openSettings", "openLogs"]) {
      panel.link?.receive({ kind: "action", action });
    }

    await until(() => posted.length > 0);

    expect(unhandled()).toEqual([]);
  });

  it("does not leave an untested build's answers unanswered", async () => {
    const root = makeRoot();
    const dir = makeEngine(root, "9.9.9");

    const controller = createController(
      options({
        editor: fullEditor(),
        settings: { read: async () => dir, write: async () => undefined },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["failure"] !== undefined);

    // The versions are on the wire, which is what the page renders beside the
    // override; this is also the state `connectAnyway` needs to be offered at all.
    const failure = lastStatus()?.["failure"] as Record<string, unknown>;

    expect(failure["kind"]).toBe("untested-engine");
    expect(failure["actualVersion"]).toBe("9.9.9");
    expect(failure["expectedVersion"]).toBe(TESTED_ENGINE_VERSION);

    panel.link?.receive({ kind: "action", action: "connectAnyway" });
    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });

    await until(() => posted.length > 0);

    expect(unhandled()).toEqual([]);
  });

  it("does not leave a folder-less start's answers unanswered", async () => {
    // A working engine, so the refusal that is reported is the missing folder
    // rather than the missing engine: this is the one situation with no start.
    const root = makeRoot();
    const dir = makeEngine(root);

    const controller = createController(
      options({
        editor: fullEditor(),
        folders: undefined,
        settings: { read: async () => dir, write: async () => undefined },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const failure = lastStatus()?.["failure"] as Record<string, unknown>;

    // The directory the confirmation names, so the page can show it *before* the
    // user agrees rather than after.
    expect(failure["kind"]).toBe("no-workspace");
    // Resolved, not echoed: the host reports the absolute directory it would
    // actually run in, which is what the confirmation names.
    expect(failure["homeDir"]).toBe(resolve("/home"));

    panel.link?.receive({ kind: "action", action: "openFolder" });
    panel.link?.receive({ kind: "action", action: "useHomeDir" });

    await until(() => posted.length > 0);

    expect(unhandled()).toEqual([]);
  });

  it("does not leave a refused folder's answers unanswered", async () => {
    // A directory that exists but is not an engine package: the repair list the
    // page names comes from this resolution.
    const root = makeRoot();

    const controller = createController(
      options({
        editor: fullEditor(),
        settings: { read: async () => root, write: async () => undefined },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const failure = lastStatus()?.["failure"] as Record<string, unknown>;

    expect(failure["missingEntries"]).toEqual(["haruyuki.js", "node_modules", "package.json"]);

    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });
    panel.link?.receive({ kind: "action", action: "openLogs" });

    await until(() => posted.length > 0);

    expect(unhandled()).toEqual([]);
  });

  it("opens the editor's settings page through the injected seam", () => {
    const opened: string[] = [];

    const editor: ControllerEditor = {
      openSettings: () => opened.push("settings"),
      openFolder: () => opened.push("folder"),
    };

    const controller = createController(options({ editor }));

    controller.open();
    panel.link?.receive({ kind: "action", action: "openSettings" });
    panel.link?.receive({ kind: "action", action: "openFolder" });

    // Both reached the editor, so neither is reported as unanswered.
    expect(opened).toEqual(["settings", "folder"]);
    expect(unhandled()).toEqual([]);
  });

  it("shows the log without needing an editor surface", () => {
    const controller = createController(options());

    controller.open();
    panel.link?.receive({ kind: "action", action: "openLogs" });

    // The log is this module's own sink: a seam here would be a second way to
    // reach one channel.
    expect(lines).toContain("LOG_SHOWN");
    expect(unhandled()).toEqual([]);
  });

  it("reports an answer it cannot give instead of pretending", () => {
    // A build with no editor seam at all: the honest outcome is the diagnostic,
    // because the alternative is a button that appears to work.
    const controller = createController(options());

    controller.open();
    panel.link?.receive({ kind: "action", action: "openSettings" });

    expect(unhandled()).toEqual(["PANEL_ACTION_UNHANDLED"]);
  });

  it("writes the picked directory back and starts from it", async () => {
    const root = makeRoot();
    const dir = makeEngine(root);

    // Refused at first, so the pick is what makes the start possible; this is the
    // state the "engine not found" page is shown in.
    const settings = memorySettings("not-an-absolute-path");
    const editor: ControllerEditor = { pickEngineDirectory: async () => dir };

    const controller = createController(options({ editor, settings: settings.port }));

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });

    await until(() => core.startCalls === 1);

    // The pick reached the setting before the start read it, so the directory the
    // user chose is the one the engine runs in rather than the one it replaced.
    expect(settings.written).toEqual([dir]);
    expect(core.startCalls).toBe(1);
  });

  it("leaves the panel as it was when the picker is dismissed", async () => {
    const written: string[] = [];

    const controller = createController(
      options({
        editor: { pickEngineDirectory: async () => undefined },
        settings: {
          read: async () => "not-an-absolute-path",
          write: async (picked: string) => {
            written.push(picked);
          },
        },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    panel.link?.receive({ kind: "action", action: "chooseEngineDir" });

    await until(() => lines.includes("HOST_ENGINE_PICK_CANCELLED"));

    // A dismissed dialog is not a failure and certainly not a configuration: the
    // setting keeps what it had and no engine is started from nowhere.
    expect(written).toEqual([]);
    expect(core.startCalls).toBe(0);
  });
});

describe("what the page reports as searched", () => {
  it("does not list the PATH directories that hold no engine", async () => {
    // A real `PATH`: dozens of directories that have nothing to do with engines.
    // The resolver looks for an engine package *inside* each one, so listing them
    // would report the shell read an environment variable -- and bury the entry a
    // user actually chose under that noise.
    const noise = Array.from({ length: 39 }, (_, index) => `/opt/noise-${String(index)}/bin`);

    const controller = createController(
      options({
        // Nothing configured: the machine this page is shown on in the report.
        settings: { read: async () => "", write: async () => undefined },
        pathEnv: noise.join(delimiter),
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const failure = lastStatus()?.["failure"] as Record<string, unknown>;

    // Nothing was configured and nothing was inspected, so there is nothing worth
    // showing: the page renders no list and its answers say where to look.
    expect(failure["searchedPaths"]).toBeUndefined();
    expect(noise.some((dir) => JSON.stringify(failure).includes(dir))).toBe(false);
  });

  it("leads with the directory the user configured", async () => {
    // Configured but refused, which is the case the page exists for: the user has
    // already named a directory, and it is the one line they can act on.
    const controller = createController(
      options({
        pathEnv: "/opt/noise-0/bin:/opt/noise-1/bin",
        settings: { read: async () => "not-an-absolute-path", write: async () => undefined },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const searched = lastStatus()?.["failure"] as Record<string, unknown>;

    expect(searched["searchedPaths"]).toEqual(["not-an-absolute-path"]);
    expect(
      (searched["searchedPaths"] as string[]).some((entry) => entry.startsWith("/opt/noise")),
    ).toBe(false);
  });

  it("lists a directory that was inspected and refused", async () => {
    // An engine-shaped attempt that failed: this is a real folder to go and
    // repair, so it is shown as the path it is.
    const root = makeRoot();

    const controller = createController(
      options({ settings: { read: async () => root, write: async () => undefined } }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const failure = lastStatus()?.["failure"] as Record<string, unknown>;

    // The configured directory first, then the one that was actually inspected.
    expect(failure["searchedPaths"]).toEqual([root]);
    expect(failure["missingEntries"]).toEqual(["haruyuki.js", "node_modules", "package.json"]);
  });
});

describe("the panel and the core are separate lifetimes", () => {
  it("keeps the core running when the panel is closed", async () => {
    const root = makeRoot();
    const dir = makeEngine(root);

    const controller = createController(
      options({ settings: { read: async () => dir, write: async () => undefined } }),
    );

    controller.open();

    await until(() => core.startCalls === 1);

    await controller.close();

    // Closing a window is not stopping the engine: the child keeps running and
    // the status bar keeps its word, so reopening resumes rather than restarts.
    expect(core.stopCalls).toBe(0);
    expect(panel.closeCalls).toBe(1);
  });

  it("keeps the status it last reported, for the next document", async () => {
    // Two documents, in the order a real close-and-reopen produces them: the
    // second link is built after the first was disposed, so it is a new poster
    // bound to a new webview with an empty store.
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
        folders: undefined,
        createPanel: (factory) => {
          factoryRef.current = factory;

          return rebuildingHost;
        },
      }),
    );

    controller.open();

    await until(() => lastStatus()?.["phase"] === "failed");

    const before = posted.filter((message) => message["kind"] === "status").length;

    // The panel host disposes this document without the assembly being closed:
    // that is what a closed dock is, and it is not a stopped core.
    link = null;
    panel.link = null;

    const reopened = factoryRef.current?.({ webview } as never) ?? null;

    panel.link = reopened;

    // The rebuilt document is told the phase it missed. Nothing else will ever
    // repeat it, because the refusal it describes was settled before it existed.
    await until(() => posted.filter((message) => message["kind"] === "status").length > before);

    expect(reopened).not.toBeNull();
    expect(lastStatus()?.["phase"]).toBe("failed");
    expect(lastStatus()?.["failure"]).toBeDefined();
  });
});
