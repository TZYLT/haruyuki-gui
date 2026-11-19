/**
 * The composition root: what it assembles, and in which order.
 *
 * Nothing here launches an editor. Every collaborator the assembly needs is
 * injected -- the panel, the core pipe, the engine resolver's inputs and the
 * secret storage -- so the whole file runs against recording doubles and asserts
 * on the sequence of calls rather than on a rendered panel.
 *
 * Why the assertions are about ORDER and COUNTS
 *
 *   The bug this file exists to prevent is invisible in the end state. The core
 *   subscribes to its engine and emits its first frame batch while it starts, so a
 *   forwarder installed after `start` loses that batch and the panel then reports
 *   itself connected while rendering nothing. "One panel, one child, one
 *   subscription" are all still true in that broken build. So the first case
 *   records the calls and asserts the forwarder was subscribed before the fork,
 *   and the lazy cases count `start` calls rather than inspecting processes.
 *
 * The engine is never really searched
 *
 *   `resolveEngine` walks the setting, then `PATH`, then a hand-picked directory,
 *   and every rung stats the filesystem. Each case therefore hands the assembly a
 *   setting the resolver refuses and an empty `PATH`, which is the same code path
 *   a machine with no engine takes -- the refusal case is a real one, not a stub.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandCall, CommandReply } from "@haruyuki/core";

import type { CoreFrame, CoreStatusSnapshot } from "../../core/ipc.js";
import type { CoreHost } from "../core-host.js";
import { createController, type ControllerOptions } from "../controller.js";
import type { PanelHost, PanelLink, PanelLinkFactory } from "../panel.js";
import { TESTED_ENGINE_VERSION } from "../../shared/version.js";

/** One recorded call, in the order the assembly made them. */
type Recorded = { readonly member: string; readonly args: readonly unknown[] };

/** The calls every case reads, in one place so a type cannot drift. */
const calls: Recorded[] = [];

/**
 * A core pipe that records what was asked of it.
 *
 * The three subscriptions answer an unsubscribe function, because the assembly
 * installs two of them and unwinds both on close; the frame and status emitters
 * are what let a case drive the panel through the pipe without a child process.
 */
const core = {
  startCalls: 0,
  started: [] as unknown[],
  stopCalls: 0,
  announcements: [] as { appVersion: string; bridgeVersion: string }[],
  frameListeners: new Set<(frame: CoreFrame) => void>(),
  statusListeners: new Set<(status: CoreStatusSnapshot) => void>(),
  logListeners: new Set<(entry: { kind: "log"; line: string }) => void>(),
  statusUnsubscribes: 0,

  reset(): void {
    calls.length = 0;
    core.startCalls = 0;
    core.started.length = 0;
    core.stopCalls = 0;
    core.announcements.length = 0;
    core.frameListeners.clear();
    core.statusListeners.clear();
    core.logListeners.clear();
    core.statusUnsubscribes = 0;
  },

  emitFrame(frame: CoreFrame): void {
    for (const listener of [...core.frameListeners]) listener(frame);
  },

  emitStatus(snapshot: CoreStatusSnapshot): void {
    for (const listener of [...core.statusListeners]) listener(snapshot);
  },

  double(): CoreHost {
    return {
      async start(init): Promise<void> {
        core.startCalls += 1;
        core.started.push(init);
        calls.push({ member: "core.start", args: [init] });
      },
      async invoke(call: CommandCall): Promise<CommandReply> {
        calls.push({ member: "core.invoke", args: [call] });

        return { ok: true, completion: "answered", data: { seen: call.capability } };
      },
      async secure(): Promise<string | undefined> {
        return undefined;
      },
      async stop(): Promise<void> {
        core.stopCalls += 1;
        calls.push({ member: "core.stop", args: [] });
      },
      announce(appVersion: string, bridgeVersion: string): boolean {
        core.announcements.push({ appVersion, bridgeVersion });

        return true;
      },
      onFrame(listener): () => void {
        core.frameListeners.add(listener);
        calls.push({ member: "core.onFrame", args: [] });

        return () => {
          core.frameListeners.delete(listener);
        };
      },
      onStatus(listener): () => void {
        core.statusListeners.add(listener);
        calls.push({ member: "core.onStatus", args: [] });

        return () => {
          core.statusUnsubscribes += 1;
          core.statusListeners.delete(listener);
        };
      },
      onLog(listener): () => void {
        core.logListeners.add(listener);
        calls.push({ member: "core.onLog", args: [] });

        return () => {
          core.logListeners.delete(listener);
        };
      },
    };
  },
};

/** One created panel, and the counters a case reads. */
const panel = {
  openCalls: 0,
  closeCalls: 0,
  /** Every message the assembly posted into this panel's document. */
  posted: [] as unknown[],
  /** The two directions for the panel that is open, while one is. */
  link: null as PanelLink | null,

  reset(): void {
    panel.openCalls = 0;
    panel.closeCalls = 0;
    panel.posted.length = 0;
    panel.link = null;
  },

  double(link?: PanelLinkFactory): PanelHost {
    // The host the entry would have built, faithful to the real one in the one
    // way that matters here: it builds the two directions immediately after the
    // document is filled and before anything can be posted, which is what makes
    // the forwarder exist before the child is started.
    if (link !== undefined) links.push(link);

    return {
      open(): void {
        if (panel.link === null && link !== undefined) {
          panel.link = link({ webview } as never);
        }

        panel.openCalls += 1;
        calls.push({ member: "panel.open", args: [] });
      },
      async close(): Promise<void> {
        panel.closeCalls += 1;
        calls.push({ member: "panel.close", args: [] });
      },
    };
  },
};

/** The link factories the assembly handed to the panel host, in order. */
const links: PanelLinkFactory[] = [];

/** A `WebviewPanel` as far as the link's own `postMessage` needs. */
const webview = {
  postMessage(message: unknown): void {
    panel.posted.push(message);
  },
};

/** The log lines the assembly wrote, so a case can assert a refusal was logged. */
const lines: string[] = [];

/**
 * The status bar double.
 *
 * It records the state it rendered rather than only the calls it received,
 * because the assembly reads `state` back to get the one spelling of a phase it
 * puts on the wire -- a double that answered a constant would make that read
 * look correct while the real bar is doing the work.
 *
 * @param rendered where the rendered states are collected, if a case reads them
 * @returns the sink and its current state
 */
function statusDouble(rendered?: string[]): {
  state: "inactive" | "starting" | "connected" | "disconnected" | "failed";
  set(state: never, details?: never): void;
  apply(snapshot: { phase: string }): void;
} {
  const sink = {
    state: "inactive" as "inactive" | "starting" | "connected" | "disconnected" | "failed",
    set(next: string): void {
      sink.state = next as never;
      rendered?.push(next);
      calls.push({ member: "status.set", args: [next] });
    },
    apply(snapshot: { phase: string }): void {
      sink.state = snapshot.phase as never;
      rendered?.push(snapshot.phase);
      calls.push({ member: "status.apply", args: [snapshot] });
    },
  };

  return sink as never;
}

/**
 * The options every case starts from.
 *
 * `settings.read` answers a value the resolver refuses and `pathEnv` is empty, so
 * the search reaches its refusal through the real code path without touching the
 * filesystem. Cases that need a start override `settings` and `folders`.
 */
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
    locale: "zh-cn",
    // A workspace folder, so a case that does reach `start` has a directory to
    // run in; the refusal cases never get that far.
    folders: [{ uri: { fsPath: "/workspace" } }],
    homeDir: "/home",
    settings: {
      // A relative path: the resolver refuses it as "not an absolute path" and
      // moves on, which is the refusal every rung failing produces.
      read: async () => "not-an-absolute-path",
      write: async () => undefined,
    },
    pathEnv: "",
    log: {
      write: (line: string) => lines.push(line),
      event: (code: string) => lines.push(code),
      failure: (code: string) => lines.push(code),
      show: () => undefined,
      droppedLines: 0,
    },
    status: statusDouble(),
    createPanel: (link) => panel.double(link),
    core: core.double(),
    ...overrides,
  };
}

/**
 * Run one start against a fake engine directory.
 *
 * @param dir the engine package root the resolver should accept
 * @returns the options, already pointed at it
 */
function withEngine(dir: string): Partial<ControllerOptions> {
  return {
    settings: {
      read: async () => dir,
      write: async () => undefined,
    },
  };
}

/** Temp roots one case created, removed afterwards. */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Write an engine package the resolver accepts.
 *
 * The entries are the three the check reads, and the version is the tested one so
 * the package resolves rather than asking -- a start has to actually happen for
 * the order assertion to see a fork.
 *
 * @param parent the directory to create it under
 * @returns the absolute package directory
 */
function makeEngine(parent: string): string {
  const dir = join(parent, "engine");

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "haruyuki.js"), "// entry\n", "utf8");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "haruyuki", version: TESTED_ENGINE_VERSION }),
    "utf8",
  );

  return dir;
}

/**
 * @returns a fresh temp root this suite owns
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "haruyuki-controller-"));

  roots.push(root);

  return root;
}

/**
 * Wait for the assembly's own promise chain to run out.
 *
 * The start path awaits the engine search, which awaits a settings read and a
 * couple of directory inspections; counting turns by hand would be a guess about
 * another module's internals, so this yields macrotasks until the predicate holds
 * or a real budget expires.
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

/** The recorded calls, narrowed to the members a case cares about. */
function members(): string[] {
  return calls.map((call) => call.member);
}

describe("controller: the assembly", () => {
  beforeEach(() => {
    calls.length = 0;
    links.length = 0;
    lines.length = 0;
    core.reset();
    panel.reset();
  });

  it("subscribes the frame forwarder before the child is started", async () => {
    const engine = makeEngine(makeRoot());

    const controller = createController(options(withEngine(engine)));

    controller.open();

    await until(() => core.startCalls === 1);

    const order = members().filter(
      (member) => member === "core.onFrame" || member === "core.start",
    );

    // The one assertion this whole package exists for. The core subscribes to its
    // engine and emits its first frame batch while it starts, so a forwarder
    // installed after the fork loses that batch -- and the broken build still
    // ends up with one panel, one child and one subscription, which is why the
    // order of these two calls is the only thing that can tell them apart.
    expect(order).toEqual(["core.onFrame", "core.start"]);
  });

  it("installs the document's inbound subscription through the panel host", () => {
    const controller = createController(options());

    controller.open();

    // The link is handed to the panel host, and the host builds the two
    // directions when it creates the document -- before anything can be posted,
    // which is what makes the forwarder exist before the child is started.
    expect(links).toHaveLength(1);
    expect(panel.openCalls).toBe(1);
    expect(panel.link).not.toBeNull();
  });

  it("carries a panel message to the command path rather than dropping it", async () => {
    const controller = createController(options());

    controller.open();

    const handle = panel.link;

    expect(handle).not.toBeNull();

    // Not a command: the path answers `ignored` and the action dispatch runs.
    handle?.receive({ kind: "action", action: "openSettings" });

    // A command the pipe answers, so the round trip is exercised end to end.
    handle?.receive({
      kind: "command.invoke",
      callId: "panel-1",
      call: { capability: "session.list", body: {} },
    });

    await until(() =>
      panel.posted.some((message) => (message as { kind: string }).kind === "command.reply"),
    );

    // The reply reached the document through the outbox, which is the direction
    // a missing subscription would have silently lost.
    expect(
      panel.posted.some((message) => (message as { kind: string }).kind === "command.reply"),
    ).toBe(true);
  });

  it("creates one panel and reveals it on every later open", async () => {
    const engine = makeEngine(makeRoot());

    const controller = createController(options(withEngine(engine)));

    controller.open();
    controller.open();
    controller.open();

    await until(() => core.startCalls === 1);

    // The host is built once and its own `open` is the idempotent step: one
    // creation, then reveals. A second creation would be a second document.
    expect(links).toHaveLength(1);
    expect(panel.openCalls).toBe(3);
    expect(core.startCalls).toBe(1);
  });

  it("starts nothing on construction, once on the first open, and once only", async () => {
    const engine = makeEngine(makeRoot());

    const controller = createController(options(withEngine(engine)));

    // Nothing was started by building the assembly, which is what makes the
    // activation cost a closure rather than a forked process and an engine.
    expect(core.startCalls).toBe(0);
    expect(panel.openCalls).toBe(0);

    controller.open();

    await until(() => core.startCalls === 1);

    expect(core.startCalls).toBe(1);

    controller.open();

    await until(() => panel.openCalls === 2);

    // A second open only reveals the panel that is already there: a second child
    // would be a second engine over the same user data.
    expect(panel.openCalls).toBe(2);
    expect(core.startCalls).toBe(1);
    expect(core.started).toHaveLength(1);
  });

  it("opens the panel even when there is no engine to offer", async () => {
    // The real no-engine case: nothing configured and nothing on `PATH`. The
    // search refuses, and the assembly must still show the refusal.
    const controller = createController(
      options({
        settings: { read: async () => undefined, write: async () => undefined },
      }),
    );

    controller.open();

    await until(() =>
      panel.posted.some((message) => (message as { kind: string }).kind === "status"),
    );

    expect(panel.openCalls).toBe(1);
    expect(core.startCalls).toBe(0);

    // The panel is told the shell is not connected. That is the whole of what
    // its message family can carry: one field, the phase.
    const status = panel.posted.find(
      (message) => (message as { kind: string }).kind === "status",
    ) as { kind: string; phase: string } | undefined;

    expect(status?.phase).toBe("failed");

    // The sentence explaining why is not lost, it is just on the other surface:
    // the log carries the readable half, and the status bar tooltip the details.
    expect(lines).toContain("HOST_START_REFUSED");
    expect(lines.some((line) => line.includes("no engine to start"))).toBe(true);
  });

  it("reports a configured but unusable directory as its own kind", async () => {
    // A relative setting is not a directory the child could run in. It is a
    // different answer from "nothing configured", and from "the engine did not
    // come up": the repair list is the point, and the page can only show one if
    // the kind says which question it is answering.
    const kind = vi.fn();

    const controller = createController(
      options({
        settings: { read: async () => "relative/engine", write: async () => undefined },
        log: {
          write: (line: string) => lines.push(line),
          event: (code: string, fields?: Record<string, unknown>) => {
            if (code === "HOST_START_REFUSED") kind(fields?.["kind"]);
          },
          failure: (code: string) => lines.push(code),
          show: () => undefined,
          droppedLines: 0,
        },
      }),
    );

    controller.open();

    await until(() => kind.mock.calls.length > 0);

    expect(kind).toHaveBeenCalledWith("invalid-dir");
  });
});

describe("controller: the child's phases", () => {
  beforeEach(() => {
    calls.length = 0;
    links.length = 0;
    lines.length = 0;
    core.reset();
    panel.reset();
  });

  it("maps a status snapshot onto the status bar and onto the panel", async () => {
    const rendered: string[] = [];

    const controller = createController(options({ status: statusDouble(rendered) as never }));

    controller.open();

    await until(() =>
      panel.posted.some((message) => (message as { kind: string }).kind === "status"),
    );

    panel.posted.length = 0;

    for (const listener of [...core.statusListeners]) {
      listener({ phase: "ready", engineVersion: "0.6.0", source: "external" });
    }

    // Both sinks learned the same fact: the status bar rendered the phase, and
    // the panel was told the word the bar rendered rather than a second spelling.
    expect(rendered).toContain("ready");

    const status = panel.posted.find(
      (message) => (message as { kind: string }).kind === "status",
    ) as { kind: string; phase: string } | undefined;

    expect(status?.kind).toBe("status");
    expect(status?.phase).toBe("ready");
  });

  it("writes the child's log lines to the shell log", () => {
    const controller = createController(options());

    controller.open();

    for (const listener of [...core.logListeners]) {
      listener({ kind: "log", line: "the engine said something" });
    }

    expect(lines.some((line) => line.includes("the engine said something"))).toBe(true);
  });

  it("unsubscribes what it installed when it is closed", async () => {
    const controller = createController(options());

    controller.open();

    const statusBefore = core.statusListeners.size;

    expect(statusBefore).toBeGreaterThan(0);

    await controller.close();

    expect(core.statusListeners.size).toBe(0);
    expect(panel.closeCalls).toBe(1);
  });
});
