/**
 * The pipe, end to end: a real `CoreProcessHost` and a real core child.
 *
 * The other host test uses generated scripts that speak the protocol. This one
 * uses the actual `runCoreMain` lifecycle, bundled to ESM first because a child
 * process cannot load a `.ts` file: the entry has to be what the build ships, and
 * proving that is half the point. If the bundle cannot be produced the whole
 * suite fails rather than skipping, so a broken build surface is never green.
 *
 * `esbuild` is a workspace dev dependency, which is why bundling here is allowed
 * while the shipped build script is a later item's file.
 */

import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CoreProcessHost, type CoreHostInit } from "../core-host.js";

const requireFromHere = createRequire(import.meta.url);

/** `apps/vscode`, the package root this test lives in. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Temp root holding the bundle and the child's cwd, removed in `afterAll`. */
let root = "";

/** Bundled ESM entry of `src/core/main.ts`, which is what a child loads. */
let entry = "";

/** One host per test, all stopped in `afterAll`. */
const hosts = new Set<CoreProcessHost>();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "haruyuki-core-pipe-"));
  entry = path.join(root, "entry.mjs");

  // The launcher a real build writes into the entry: it wires the seams the
  // engine and command layers will provide, and nothing else. Keeping it here
  // means the lifecycle under test is the shipped one, not a test double.
  const launcher = `
import { runCoreMain } from "./main.mjs";

const engineStopped = { count: 0 };

const engine = {
  async stop() {
    engineStopped.count += 1;
  },
  onFrame(listener) {
    listener("control", JSON.stringify({ hello: true }));

    return () => {};
  },
};

const secure = new Map([["token", "secret-value"]]);

runCoreMain({
  startEngine: async () => engine,
  invokeCommand: async (call) => ({
    ok: true,
    completion: "answered",
    data: { capability: call.capability, engineStopped, see: "engine" },
  }),
  secureStore: {
    async get(key) {
      return secure.get(key);
    },
    async set(key, value) {
      secure.set(key, value);
    },
    async delete(key) {
      secure.delete(key);
    },
  },
});
`;

  const { buildSync } = requireFromHere("esbuild") as {
    buildSync: (options: Record<string, unknown>) => void;
  };

  buildSync({
    entryPoints: [path.join(APP_ROOT, "src/core/main.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: path.join(root, "main.mjs"),
    logLevel: "silent",
  });

  writeFileSync(path.join(root, "entry.mjs"), launcher, "utf8");
});

afterAll(async () => {
  for (const host of hosts) {
    hosts.delete(host);
    await host.stop().catch(() => {
      // A host that cannot stop shows up as the bundle test's own failure.
    });
  }

  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** The init every test sends. */
const INIT: CoreHostInit = {
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: tmpdir(),
  locale: "en",
  engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
  expectedVersion: "1.0.0",
  capabilities: {
    canNotify: false,
    canPopout: false,
    canFloat: false,
    canOpenExternal: false,
    canPickFiles: false,
    canReadDroppedFiles: false,
  },
};

/**
 * Collect the child's messages until it says `ready`, then ask it to shut down.
 *
 * The child stays alive after `ready` on purpose: it is waiting for commands.
 * Asking it to leave is the host's job, so that is what this helper does.
 *
 * @param child the forked core child
 * @param budgetMs how long the whole exchange may take
 * @returns every message that arrived, in order
 */
async function collectMessages(
  child: ChildProcess,
  budgetMs = 10_000,
): Promise<{ kind: string }[]> {
  const messages: { kind: string }[] = [];

  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the standalone child did not exit"));
    }, budgetMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  child.on("message", (message: { kind: string }) => {
    messages.push(message);

    if (message.kind === "ready") child.send({ kind: "shutdown" });
  });

  await exited;

  return messages;
}

/** @returns the file's content, or `undefined` while it does not exist */
function readFileSyncSafe(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Poll a file's content until it holds something; fails instead of hanging. */
async function waitFor(
  read: (file: string) => string | undefined,
  file: string,
  budgetMs: number,
): Promise<string> {
  const deadline = Date.now() + budgetMs;

  while (Date.now() < deadline) {
    const value = read(file);

    if (value !== undefined && value !== "") return value;

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`nothing was written to ${path.basename(file)} within ${String(budgetMs)} ms`);
}

/** @returns once the child is gone, or fails the test */
async function waitForExit(child: ChildProcess, budgetMs = 10_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("the probe parent did not exit"));
    }, budgetMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Build a host against the real child and register it for cleanup.
 *
 * @returns the host
 */
function host(): CoreProcessHost {
  const instance = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 2000 });

  hosts.add(instance);

  return instance;
}

describe("the child's parent watch", () => {
  it("stops the engine and exits by itself when the host channel closes", async () => {
    // Closing the channel is the portable form of "the host is gone": on POSIX a
    // killed host closes it, and this is the signal the child watches. A hard
    // kill is deliberately not simulated here, because on Windows the OS job
    // object terminates the child before any handler runs, so nothing about this
    // file would be under test.
    const probe = path.join(root, "watch-entry.mjs");
    const stopFile = path.join(root, "watch-engine-stopped.txt");

    writeFileSync(
      probe,
      `
import { writeFileSync } from "node:fs";
import { runCoreMain } from "./main.mjs";

runCoreMain({
  startEngine: async () => ({
    async stop() {
      writeFileSync(${JSON.stringify(stopFile)}, "stopped", "utf8");
    },
  }),
});
`,
      "utf8",
    );

    const parent = fork(probe, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });

    try {
      parent.send({
        kind: "init",
        paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
        cwd: tmpdir(),
        locale: "en",
        engine: { kind: "bundled", dir: "/e", bundlePath: "/e/b.js" },
        expectedVersion: "1.0.0",
        capabilities: {
          canNotify: false,
          canPopout: false,
          canFloat: false,
          canOpenExternal: false,
          canPickFiles: false,
          canReadDroppedFiles: false,
        },
      });

      await new Promise((resolve) => parent.once("message", resolve));

      // The host is gone: no shutdown message, just a closed pipe.
      parent.disconnect();

      await expect(waitFor(readFileSyncSafe, stopFile, 10_000)).resolves.toBe("stopped");
      await expect(waitForExit(parent)).resolves.toBeUndefined();
    } finally {
      parent.kill("SIGKILL");
    }
  });
});

describe("the bundled entry in a plain Node process", () => {
  it("loads as ESM and exposes a runnable lifecycle", async () => {
    // The child entry must be ESM -- the engine transport needs
    // `import.meta.url` -- so a CommonJS bundle would be a runtime failure
    // nothing else in this suite would see. Loading it as a module is the
    // evidence, and asserting the exported shape catches a renamed seam.
    const bundle = path.join(root, "main.mjs");
    const module = (await import(pathToFileURL(bundle).href)) as {
      runCoreMain?: unknown;
      nodeTransport?: unknown;
    };

    expect(typeof module.runCoreMain).toBe("function");
    expect(typeof module.nodeTransport).toBe("function");
  });

  it("runs its lifecycle to an exit without a host on the other end", async () => {
    const probe = path.join(root, "standalone-entry.mjs");

    writeFileSync(
      probe,
      `
import { runCoreMain } from "./main.mjs";

runCoreMain({ startEngine: async () => ({ async stop() {} }) });
`,
      "utf8",
    );

    const child = spawn(process.execPath, [probe], { stdio: ["ignore", "pipe", "pipe", "ipc"] });

    try {
      child.send({
        kind: "init",
        paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
        cwd: tmpdir(),
        locale: "en",
        engine: { kind: "bundled", dir: "/e", bundlePath: "/e/b.js" },
        expectedVersion: "1.0.0",
        capabilities: {
          canNotify: false,
          canPopout: false,
          canFloat: false,
          canOpenExternal: false,
          canPickFiles: false,
          canReadDroppedFiles: false,
        },
      });

      const messages = await collectMessages(child);

      // starting, ready, then the acknowledgement, then the phase shutdown
      // produced -- in that order, which is the whole lifecycle contract.
      expect(messages.map((message) => message.kind)).toEqual([
        "status",
        "status",
        "ready",
        "status",
      ]);
      expect(child.exitCode ?? 0).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("the real core child", () => {
  it("boots to ready, answers a command and serves the secret store", async () => {
    const instance = host();
    const phases: string[] = [];

    instance.onStatus((status) => phases.push(status.phase));

    await instance.start(INIT);

    expect(phases).toEqual(["starting", "ready"]);

    await expect(instance.invoke({ capability: "device.info", body: {} })).resolves.toMatchObject({
      ok: true,
      completion: "answered",
      data: { capability: "device.info" },
    });

    await expect(instance.secure("get", "token")).resolves.toBe("secret-value");
    await expect(instance.secure("get", "absent")).resolves.toBeUndefined();

    await instance.stop();

    expect(phases).toEqual(["starting", "ready", "stopped"]);
  });

  it("relays the engine's frames", async () => {
    const instance = host();
    const frames: string[] = [];

    instance.onFrame((frame) => frames.push(frame.payload));

    await instance.start(INIT);

    expect(frames).toEqual([JSON.stringify({ hello: true })]);

    await instance.stop();
  });

  it("stops cleanly, and a repeated stop is a no-op", async () => {
    const instance = host();

    await instance.start(INIT);
    await instance.stop();
    await instance.stop();

    await expect(instance.secure("get", "token")).rejects.toMatchObject({ code: "NOT_STARTED" });
  });
});
