import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEngineCrashWatcher,
  handleMainCrash,
  handleRendererGone,
  installMainCrashHandlers,
} from "../crash/capture.js";
import type {
  CrashNotifyContext,
  EngineAppServerInfoLike,
  EngineExitLike,
  EngineLike,
} from "../crash/capture.js";
import { readCrashRecords } from "../crash/records.js";
import type { CrashRecord, CrashVersions } from "../crash/records.js";

/** Directories to remove after each test. Only the ones this file made. */
const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "d4-crash-capture-"));

  created.push(dir);

  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();

  while (created.length > 0) {
    const dir = created.pop();

    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

const VERSIONS: CrashVersions = {
  version: "0.1.0",
  electron: "45.3.2",
  node: "24.22.3",
  platform: "win32",
  arch: "x64",
};

const NOW = new Date("2026-11-16T12:00:00.000Z");

/** A directory path that cannot be created, because a file is in the way. */
async function blockedDir(): Promise<string> {
  const root = await tempDir();
  const blocker = path.join(root, "blocker");

  await writeFile(blocker, "not a directory");

  return path.join(blocker, "crashes");
}

/** Let any scheduled write or callback run; used only for negative assertions. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** The context every notify-path test uses, with fixed versions and clock. */
function notifyContext(dir: string, crashes: CrashRecord[]): CrashNotifyContext {
  return {
    dir,
    versions: VERSIONS,
    now: () => NOW,
    onCrash: (record) => crashes.push(record),
  };
}

/** The structural engine the watcher is designed against. */
class FakeEngine implements EngineLike {
  state = "idle";
  appServerInfo: EngineAppServerInfoLike | null = null;
  lastExit: EngineExitLike | null = null;

  private readonly events = new EventEmitter();

  onState(callback: (state: string) => void): () => void {
    this.events.on("state", callback);

    return () => {
      this.events.off("state", callback);
    };
  }

  moveTo(state: string): void {
    this.state = state;
    this.events.emit("state", state);
  }

  fail(exit: EngineExitLike): void {
    this.lastExit = exit;
    this.moveTo("failed");
  }
}

describe("handleMainCrash", () => {
  it("writes a main record and exits with code 1", async () => {
    const dir = await tempDir();
    const fatal: number[] = [];

    handleMainCrash(new Error("boom"), {
      dir,
      versions: VERSIONS,
      now: () => NOW,
      onFatal: (code) => fatal.push(code),
    });

    expect(fatal).toEqual([1]);

    const records = readCrashRecords(dir);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      schemaVersion: 1,
      at: NOW.toISOString(),
      kind: "main",
      code: "MAIN_CRASHED",
      app: VERSIONS,
      main: { name: "Error", message: "boom" },
    });
    expect(records[0]?.main?.stack).toContain("boom");
  });

  it("describes a thrown non-Error without throwing", async () => {
    const dir = await tempDir();
    const fatal: number[] = [];

    handleMainCrash("a string was thrown", {
      dir,
      versions: VERSIONS,
      now: () => NOW,
      onFatal: (code) => fatal.push(code),
    });

    expect(fatal).toEqual([1]);
    expect(readCrashRecords(dir)[0]?.main).toEqual({
      name: "NonError",
      message: "a string was thrown",
    });
  });

  it("still exits when the record cannot be written", async () => {
    const dir = await blockedDir();
    const fatal: number[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => {
      handleMainCrash(new Error("boom"), {
        dir,
        versions: VERSIONS,
        now: () => NOW,
        onFatal: (code) => fatal.push(code),
      });
    }).not.toThrow();

    expect(fatal).toEqual([1]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("crash.main.write.failed"));
  });
});

describe("createEngineCrashWatcher", () => {
  it("records a crash that happened after the engine reached ready", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const crashes: CrashRecord[] = [];

    engine.appServerInfo = { protocolVersion: 1, engineVersion: "0.6.0" };
    engine.moveTo("ready");

    const unsubscribe = createEngineCrashWatcher(engine, notifyContext(dir, crashes));

    engine.fail({ code: 1, signal: "SIGKILL" });

    await vi.waitFor(() => expect(crashes).toHaveLength(1));

    expect(crashes[0]).toMatchObject({
      schemaVersion: 1,
      at: NOW.toISOString(),
      kind: "engine",
      code: "ENGINE_CRASHED",
      engine: {
        exitCode: 1,
        signal: "SIGKILL",
        engineVersion: "0.6.0",
        protocolVersion: 1,
        watchdog: "unknown",
      },
    });

    const records = readCrashRecords(dir);

    expect(records).toHaveLength(1);
    expect(records[0]?.kind).toBe("engine");

    unsubscribe();
  });

  it("does not record a start failure, which belongs to the bootstrap path", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const crashes: CrashRecord[] = [];

    engine.moveTo("spawning");

    const unsubscribe = createEngineCrashWatcher(engine, notifyContext(dir, crashes));

    engine.fail({ code: 1, signal: null });

    await settle();

    expect(crashes).toEqual([]);
    expect(readCrashRecords(dir)).toEqual([]);

    unsubscribe();
  });

  it("records one crash only when failed is announced again", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const crashes: CrashRecord[] = [];

    engine.appServerInfo = { protocolVersion: 1, engineVersion: "0.6.0" };
    engine.moveTo("ready");

    const unsubscribe = createEngineCrashWatcher(engine, notifyContext(dir, crashes));

    engine.fail({ code: 1, signal: null });
    await vi.waitFor(() => expect(crashes).toHaveLength(1));

    engine.moveTo("failed");
    await settle();

    expect(crashes).toHaveLength(1);
    expect(readCrashRecords(dir)).toHaveLength(1);

    unsubscribe();
  });

  it("stops recording after unsubscribe", async () => {
    const dir = await tempDir();
    const engine = new FakeEngine();
    const crashes: CrashRecord[] = [];

    engine.appServerInfo = { protocolVersion: 1, engineVersion: "0.6.0" };
    engine.moveTo("ready");

    const unsubscribe = createEngineCrashWatcher(engine, notifyContext(dir, crashes));

    unsubscribe();
    engine.fail({ code: 1, signal: null });

    await settle();

    expect(crashes).toEqual([]);
    expect(readCrashRecords(dir)).toEqual([]);
  });
});

describe("handleRendererGone", () => {
  it("maps Electron's details into a renderer record", async () => {
    const dir = await tempDir();
    const crashes: CrashRecord[] = [];

    await handleRendererGone({ reason: "crashed", exitCode: 2 }, notifyContext(dir, crashes));

    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({
      schemaVersion: 1,
      at: NOW.toISOString(),
      kind: "renderer",
      code: "RENDERER_CRASHED",
      renderer: { reason: "crashed", exitCode: 2 },
    });
    expect(readCrashRecords(dir)).toHaveLength(1);
  });

  it("keeps a null exit code instead of inventing one", async () => {
    const dir = await tempDir();
    const crashes: CrashRecord[] = [];

    await handleRendererGone({ reason: "oom", exitCode: null }, notifyContext(dir, crashes));

    expect(crashes[0]?.renderer).toEqual({ reason: "oom", exitCode: null });
  });

  it("notifies even when the record cannot be written", async () => {
    const dir = await blockedDir();
    const crashes: CrashRecord[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await handleRendererGone({ reason: "crashed", exitCode: 2 }, notifyContext(dir, crashes));

    expect(crashes).toHaveLength(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("crash.renderer.write.failed"));
  });
});

describe("installMainCrashHandlers", () => {
  it("installs one pair of listeners and removes them without duplicates", () => {
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const unhandledBefore = process.listenerCount("unhandledRejection");
    const context = { dir: "unused", versions: VERSIONS, onFatal: () => undefined };

    const uninstall = installMainCrashHandlers(context);

    try {
      const second = installMainCrashHandlers(context);

      expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore + 1);
      expect(process.listenerCount("unhandledRejection")).toBe(unhandledBefore + 1);

      uninstall();
      second();
      uninstall();

      expect(process.listenerCount("uncaughtException")).toBe(uncaughtBefore);
      expect(process.listenerCount("unhandledRejection")).toBe(unhandledBefore);
    } finally {
      uninstall();
    }
  });

  it("routes an uncaught exception through the main crash path", async () => {
    const dir = await tempDir();
    const fatal: number[] = [];
    const context = {
      dir,
      versions: VERSIONS,
      now: () => NOW,
      onFatal: (code: number) => fatal.push(code),
    };
    const before = process.listeners("uncaughtException");
    const uninstall = installMainCrashHandlers(context);

    try {
      const added = process
        .listeners("uncaughtException")
        .filter((listener) => !before.includes(listener));

      expect(added).toHaveLength(1);
      added[0]?.(new Error("boom"), "uncaughtException");

      expect(fatal).toEqual([1]);
      expect(readCrashRecords(dir)[0]?.kind).toBe("main");
    } finally {
      uninstall();
    }
  });

  it("reports an unhandled rejection without exiting", async () => {
    const dir = await tempDir();
    const fatal: number[] = [];
    const details: string[] = [];
    const context = {
      dir,
      versions: VERSIONS,
      now: () => NOW,
      onFatal: (code: number) => fatal.push(code),
      onUnhandled: (detail: string) => details.push(detail),
    };
    const before = process.listeners("unhandledRejection");
    const uninstall = installMainCrashHandlers(context);

    try {
      const added = process
        .listeners("unhandledRejection")
        .filter((listener) => !before.includes(listener));

      expect(added).toHaveLength(1);
      added[0]?.(new Error("later"), Promise.resolve());

      expect(details).toEqual(["Error: later"]);
      expect(fatal).toEqual([]);
      expect(readCrashRecords(dir)).toEqual([]);
    } finally {
      uninstall();
    }
  });
});
