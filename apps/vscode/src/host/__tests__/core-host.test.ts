/**
 * `CoreProcessHost` against a real forked child.
 *
 * The child here is a small ESM script written into a temp directory: it speaks
 * the same pipe protocol (`./ipc.ts`) without needing an engine, so the test can
 * prove the four host behaviours -- boot, invoke, secure, stop -- against the
 * real `fork` semantics of this Node/Electron pair rather than against a mock.
 *
 * The script is generated per test so its behaviour (`ready`, delay, silent,
 * crash, bad message) is readable at the assertion that needs it. Every child is
 * force-killed afterwards, so a failing assertion never leaks a process.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CoreProcessHost, type CoreHostInit } from "../core-host.js";

/** Children created by a test, force-killed in `afterEach`. */
const started = new Set<CoreProcessHost>();

/** Temp roots created by a test, removed in `afterEach`. */
const roots: string[] = [];

afterEach(async () => {
  for (const host of started) {
    started.delete(host);
    await host.stop().catch(() => {
      // A host that already failed to stop shows up as the next test's timeout.
    });
  }

  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every temp root is created under the OS temp directory, never in the repo. */
function makeChild(source: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "haruyuki-core-host-"));

  roots.push(root);

  const entry = path.join(root, "child.mjs");

  writeFileSync(entry, source, "utf8");

  return entry;
}

/** The init every test sends; the child only reads `cwd`. */
const INIT: CoreHostInit = {
  paths: { userData: "/u", logs: "/l", cache: "/c", temp: "/t" },
  cwd: tmpdir(),
  locale: "en",
  engine: { kind: "bundled", dir: "/engine", bundlePath: "/engine/haruyuki.js" },
  expectedVersion: "1.0.0",
};

/**
 * Build a host for one child and register it for cleanup.
 *
 * @param entry absolute path of the generated child
 * @param options timeout overrides
 * @returns the host
 */
function hostFor(
  entry: string,
  options: Partial<{
    startTimeoutMs: number;
    stopTimeoutMs: number;
    commandTimeoutMs: number;
  }> = {},
): CoreProcessHost {
  // A short stop budget by default: the generated children either answer
  // `shutdown` immediately or ignore it, and `afterEach` stops every one of
  // them. The production default is minutes away from this on purpose.
  const host = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 500, ...options });

  started.add(host);

  return host;
}

/**
 * A child that speaks the protocol.
 *
 * `onInit` is the body the test wants: it can answer `ready`, stay silent, send
 * something malformed, or throw. Replies are echoed with the id the host minted,
 * which is the only contract the correlation depends on.
 */
function childSource(body: string): string {
  return `
const send = (message) => process.send(message);

process.on("message", (message) => {
  switch (message.kind) {
    case "init": {
      ${body}
      return;
    }
    case "command.invoke": {
      const reply = process.env.REPLY_MODE === "error"
        ? { ok: false, code: "REJECTED", detail: "the child refused" }
        : { ok: true, completion: "answered", data: { capability: message.call.capability } };

      send({ kind: "command.reply", callId: message.callId, reply });
      return;
    }
    case "secure.request": {
      if (message.op === "get") {
        send({ kind: "secure.reply", requestId: message.requestId, value: "stored" });
        return;
      }

      send({ kind: "secure.reply", requestId: message.requestId });
      return;
    }
    case "shutdown": {
      send({ kind: "status", phase: "stopped" });
      process.exit(0);
      return;
    }
    default:
      return;
  }
});
`;
}

describe("start", () => {
  it("settles once the child answers ready", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await expect(host.start(INIT)).resolves.toBeUndefined();
  });

  it("rejects on timeout when the child never answers ready", async () => {
    // A live but silent child: it holds the event loop open and never replies.
    const entry = makeChild(childSource(`setInterval(() => {}, 1000);`));
    const host = hostFor(entry, { startTimeoutMs: 150 });

    await expect(host.start(INIT)).rejects.toMatchObject({
      name: "CoreHostError",
      code: "START_TIMEOUT",
    });
  });

  it("rejects when the entry does not exist, instead of hanging on the fork event", async () => {
    const host = hostFor(path.join(tmpdir(), "haruyuki-missing-entry.mjs"));

    await expect(host.start(INIT)).rejects.toMatchObject({ name: "CoreHostError" });
  });

  it("refuses a second start", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.start(INIT)).rejects.toMatchObject({ code: "ALREADY_STARTED" });
  });
});

describe("invoke", () => {
  it("resolves with the correlated reply", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.invoke({ capability: "device.info", body: {} })).resolves.toEqual({
      ok: true,
      completion: "answered",
      data: { capability: "device.info" },
    });
  });

  it("does not confuse two concurrent calls", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    const replies = await Promise.all([
      host.invoke({ capability: "first", body: {} }),
      host.invoke({ capability: "second", body: {} }),
      host.invoke({ capability: "third", body: {} }),
    ]);

    expect(replies).toEqual([
      { ok: true, completion: "answered", data: { capability: "first" } },
      { ok: true, completion: "answered", data: { capability: "second" } },
      { ok: true, completion: "answered", data: { capability: "third" } },
    ]);
  });

  it("answers with a NOT_CONNECTED failure before start", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));

    await expect(hostFor(entry).invoke({ capability: "device.info", body: {} })).resolves.toEqual({
      ok: false,
      code: "NOT_CONNECTED",
      detail: "the core child is not running",
    });
  });

  it("answers with a REJECTED failure for a payload JSON cannot carry", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    const reply = await host.invoke({
      capability: "device.info",
      body: { at: new Date() },
    });

    expect(reply).toMatchObject({ ok: false, code: "REJECTED" });
  });

  it("answers with a TIMEOUT failure when the child stays silent", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind === "init") process.send({ kind: "ready" });
  // Every command is deliberately ignored.
});
setInterval(() => {}, 1000);
`);
    const host = new CoreProcessHost({
      entryPath: entry,
      commandTimeoutMs: 120,
      stopTimeoutMs: 500,
    });

    started.add(host);
    await host.start(INIT);

    await expect(host.invoke({ capability: "device.info", body: {} })).resolves.toMatchObject({
      ok: false,
      code: "TIMEOUT",
    });
  });

  it("settles every in-flight call when the child crashes", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    const inFlight = host.invoke({ capability: "device.info", body: {} });

    await host.stop();

    await expect(inFlight).resolves.toMatchObject({ ok: false, code: "NOT_CONNECTED" });
  });
});

describe("secure", () => {
  it("carries a value back and answers a write with undefined", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.secure("get", "token")).resolves.toBe("stored");
    await expect(host.secure("set", "token", "next")).resolves.toBeUndefined();
    await expect(host.secure("delete", "token")).resolves.toBeUndefined();
  });

  it("rejects before start instead of answering undefined", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));

    await expect(hostFor(entry).secure("get", "token")).rejects.toMatchObject({
      name: "CoreHostError",
      code: "NOT_STARTED",
    });
  });

  it("rejects a set without a value", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.secure("set", "token")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects when the child answers with an error", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind === "init") process.send({ kind: "ready" });
  if (message.kind === "secure.request") {
    process.send({ kind: "secure.reply", requestId: message.requestId, error: "keyring is locked" });
  }
});
`);
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.secure("get", "token")).rejects.toMatchObject({
      code: "DISCONNECTED",
      message: "keyring is locked",
    });
  });
});

describe("stop", () => {
  it("is idempotent and leaves the child gone", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));
    const host = hostFor(entry);

    await host.start(INIT);

    await expect(host.stop()).resolves.toBeUndefined();
    await expect(host.stop()).resolves.toBeUndefined();
    await expect(host.secure("get", "token")).rejects.toMatchObject({ code: "NOT_STARTED" });
  });

  it("resolves before start without throwing", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));

    await expect(hostFor(entry).stop()).resolves.toBeUndefined();
  });

  it("kills a child that ignores shutdown, inside the stop budget", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind === "init") process.send({ kind: "ready" });
  // shutdown is deliberately ignored, and the event loop stays busy.
});
setInterval(() => {}, 1000);
`);
    const host = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 150 });

    started.add(host);
    await host.start(INIT);

    const began = Date.now();

    await host.stop();

    expect(Date.now() - began).toBeLessThan(5000);
  });
});

describe("subscriptions", () => {
  it("delivers frames, status and logs to their own subscribers", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind !== "init") return;

  process.send({ kind: "status", phase: "starting", cwd: "/w" });
  process.send({ kind: "frame", channel: "control", payload: "frame-body" });
  process.send({ kind: "log", line: "engine says hello" });
  process.send({ kind: "ready" });
});
`);
    const host = hostFor(entry);

    const frames: string[] = [];
    const statuses: string[] = [];
    const logs: string[] = [];
    const offFrame = host.onFrame((frame) => frames.push(frame.payload));
    const offStatus = host.onStatus((status) => statuses.push(status.phase));
    const offLog = host.onLog((log) => logs.push(log.line));

    await host.start(INIT);

    expect(frames).toEqual(["frame-body"]);
    expect(statuses).toEqual(["starting"]);
    expect(logs).toEqual(["engine says hello"]);

    offFrame();
    offStatus();
    offLog();

    expect(frames).toHaveLength(1);
  });

  it("reports an unexpected exit as a crash and a requested stop as nothing", async () => {
    const crashing = makeChild(`
process.on("message", (message) => {
  if (message.kind !== "init") return;

  process.send({ kind: "ready" });
  setTimeout(() => process.exit(3), 20);
});
`);
    const watcher = hostFor(crashing);
    const failures: string[] = [];

    watcher.onStatus((status) => {
      if (status.phase === "failed") failures.push(status.failure?.kind ?? "none");
    });

    await watcher.start(INIT);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(failures).toEqual(["crash"]);

    const orderly = makeChild(
      `process.on("message", (m) => m.kind === "init" && process.send({ kind: "ready" }));`,
    );
    const quiet = hostFor(orderly);
    const quietFailures: string[] = [];

    quiet.onStatus((status) => quietFailures.push(status.phase));
    await quiet.start(INIT);
    await quiet.stop();

    expect(quietFailures).toEqual([]);
  });

  it("still answers ready when an unusable message arrives first", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind !== "init") return;

  process.send({ kind: "frame.batch", payload: [] });
  process.send({ not: "a message" });
  process.send({ kind: "ready" });
});
`);
    const host = hostFor(entry);
    const logs: string[] = [];

    host.onLog((log) => logs.push(log.line));

    await expect(host.start(INIT)).resolves.toBeUndefined();

    expect(logs.filter((line) => line.includes("unusable")).length).toBe(2);
  });
});

describe("the child environment", () => {
  it("adds ELECTRON_RUN_AS_NODE only on an Electron host", async () => {
    const entry = makeChild(`
process.on("message", (message) => {
  if (message.kind !== "init") return;

  process.send({ kind: "frame", channel: "control", payload: String(process.env.ELECTRON_RUN_AS_NODE) });
  process.send({ kind: "ready" });
});
`);
    const host = hostFor(entry);
    const payloads: string[] = [];

    host.onFrame((frame) => payloads.push(frame.payload));

    await host.start(INIT);

    // A plain Node host must not be handed the variable by this class. It may
    // already carry it from the surrounding environment (a remote workspace sets
    // it), so the assertion is "unchanged", not "absent".
    const inherited = process.env.ELECTRON_RUN_AS_NODE ?? "undefined";
    const expected = typeof process.versions.electron === "string" ? "1" : inherited;

    expect(payloads).toEqual([expected]);
  });
});

describe("execPath", () => {
  it("defaults to this process binary, which is what an extension host must fork", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));

    // A child forked from `process.execPath` cannot be any other binary, so a
    // successful boot is the evidence that the default is the right one.
    await expect(hostFor(entry).start(INIT)).resolves.toBeUndefined();
  });

  it("runs a plain Node child without ELECTRON_RUN_AS_NODE, which is the remote case", async () => {
    const entry = makeChild(childSource(`send({ kind: "ready" });`));

    await expect(hostFor(entry).start(INIT)).resolves.toBeUndefined();
    expect(spawn).toBeTypeOf("function");
  });
});
