/**
 * The whole path, twice: a real core child, a real `CoreProcessHost`, and this
 * host's frame and command paths on top.
 *
 * The other host test drives the paths with a fake port. That proves the host's
 * own decisions but not the seam, so this one bundles the actual core entry and
 * forks it, exactly as the extension host does. Every assertion therefore spans
 * core -> pipe -> host -> panel, or the reverse:
 *
 * - the three reply arms travel from a panel invocation to the core and back;
 * - a frame's payload crosses the pipe and reaches the panel byte for byte;
 * - a core that dies mid-command settles the in-flight command as failed.
 *
 * `esbuild` is a workspace dev dependency, which is why bundling here is allowed
 * while the shipped build script is a later item's file.
 */

import { createRequire } from "node:module";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { CoreHostInit } from "../core-host.js";
import { CoreProcessHost } from "../core-host.js";
import {
  createCommandPath,
  createFrameForwarder,
  createOutbox,
  type HostToWebview,
} from "../command-path.js";

const requireFromHere = createRequire(import.meta.url);

/** `apps/vscode`, the package root this test lives in. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Temp root holding the bundle and the child's cwd, removed in `afterAll`. */
let root = "";

/** Bundled ESM entry of `src/core/main.ts`, which is what a child loads. */
let entry = "";

/** One host per test, all stopped in `afterAll`. */
const hosts = new Set<CoreProcessHost>();

/**
 * A payload no JSON parser accepts, emitted by the child itself.
 *
 * It crosses a real process boundary, so this is the payload a `JSON.parse` in
 * this host would throw on.
 */
const MALFORMED = '{"v":1,"ch":"control","seq":1,"t":"state.loop","body":{"x":"\u0000\u0007\n';

/**
 * The capability the launcher exits on, so a test can have one command in flight
 * when the core child dies.
 */
const CRASH = "test.crash";

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "haruyuki-command-path-"));
  entry = path.join(root, "entry.mjs");

  // The launcher wires the three reply arms and one frame, and nothing else: the
  // lifecycle under test is the shipped one.
  const launcher = `
import { runCoreMain } from "./main.mjs";

const engine = {
  async stop() {},
  onFrame(listener) {
    listener("control", ${JSON.stringify(MALFORMED)});
    listener("stream", JSON.stringify({ v: 1, ch: "stream", seq: 2, t: "term.output", body: {} }));

    return () => {};
  },
};

runCoreMain({
  startEngine: async () => engine,
  invokeCommand: async (call) => {
    if (call.capability === ${JSON.stringify(CRASH)}) {
      // The core leaves without answering the command it is holding: the reply
      // is owed, so only the host's exit arm can settle the panel's command.
      process.exit(3);
    }

    if (call.capability === "test.accepted") return { ok: true, completion: "accepted" };

    if (call.capability === "test.refused") {
      return { ok: false, code: "COMMAND_SCOPE_REQUIRED", detail: "the call needs a scope" };
    }

    return { ok: true, completion: "answered", data: { capability: call.capability } };
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

  // `ws` stays external in the bundle, exactly as the shipped build leaves it,
  // so the child resolves it from beside its own file. The artifact sits next to
  // `dist/node_modules/ws`; this copy mirrors that layout instead of assuming a
  // single file is self-contained.
  const requireFromCore = createRequire(
    path.join(APP_ROOT, "..", "..", "packages", "core", "package.json"),
  );
  const wsDir = path.dirname(requireFromCore.resolve("ws/package.json"));

  cpSync(wsDir, path.join(root, "node_modules", "ws"), { recursive: true, dereference: true });
});

afterAll(async () => {
  for (const host of hosts) {
    hosts.delete(host);

    await host.stop().catch(() => {
      // A host that cannot stop shows up as one of this file's own failures.
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
 * Start a host against the real child and register it for cleanup.
 *
 * @returns the started host
 */
async function startHost(): Promise<CoreProcessHost> {
  const host = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 2_000 });

  hosts.add(host);
  await host.start(INIT);

  return host;
}

/** @returns the `command.reply` messages a panel received */
function replies(sent: HostToWebview[]): HostToWebview[] {
  return sent.filter((message) => message.kind === "command.reply");
}

describe("the three command arms, panel to core and back", () => {
  it("carries answered, accepted and refused through the whole path", async () => {
    const host = await startHost();
    const sent: HostToWebview[] = [];
    const path = createCommandPath({
      host,
      outbox: createOutbox((message) => {
        sent.push(message);
      }),
    });

    path.receive({
      kind: "command.invoke",
      callId: "wv-1",
      call: { capability: "device.info", body: {} },
    });

    await vi.waitFor(() => {
      expect(replies(sent)).toHaveLength(1);
    });

    // Arm one: a correlated answer whose data is the core's.
    expect(replies(sent)[0]).toEqual({
      kind: "command.reply",
      callId: "wv-1",
      reply: { ok: true, completion: "answered", data: { capability: "device.info" } },
    });

    sent.length = 0;

    path.receive({
      kind: "command.invoke",
      callId: "wv-2",
      call: { capability: "test.accepted", body: {} },
    });

    await vi.waitFor(() => {
      expect(replies(sent)).toHaveLength(1);
    });

    // Arm two: written to the channel, nothing answered.
    expect(replies(sent)[0]).toEqual({
      kind: "command.reply",
      callId: "wv-2",
      reply: { ok: true, completion: "accepted" },
    });

    sent.length = 0;

    path.receive({
      kind: "command.invoke",
      callId: "wv-3",
      call: { capability: "test.refused", body: {} },
    });

    await vi.waitFor(() => {
      expect(replies(sent)).toHaveLength(1);
    });

    // Arm three: a refusal, as a value rather than a rejection.
    expect(replies(sent)[0]).toEqual({
      kind: "command.reply",
      callId: "wv-3",
      reply: {
        ok: false,
        code: "COMMAND_SCOPE_REQUIRED",
        detail: "the call needs a scope",
      },
    });

    await host.stop();
  });

  it("does not mix up concurrent panel calls through the real pipe", async () => {
    const host = await startHost();
    const sent: HostToWebview[] = [];
    const path = createCommandPath({
      host,
      outbox: createOutbox((message) => {
        sent.push(message);
      }),
    });

    for (const id of ["wv-a", "wv-b", "wv-c"]) {
      path.receive({
        kind: "command.invoke",
        callId: id,
        call: { capability: id === "wv-b" ? "test.accepted" : "device.info", body: {} },
      });
    }

    await vi.waitFor(() => {
      expect(replies(sent)).toHaveLength(3);
    });

    const byId = new Map(
      replies(sent).map((message) => [
        message.kind === "command.reply" ? message.callId : "",
        message.kind === "command.reply" ? message.reply : null,
      ]),
    );

    expect(byId.get("wv-a")).toMatchObject({ ok: true, completion: "answered" });
    expect(byId.get("wv-b")).toEqual({ ok: true, completion: "accepted" });
    expect(byId.get("wv-c")).toMatchObject({ ok: true, completion: "answered" });

    await host.stop();
  });
});

describe("the frame direction through the real pipe", () => {
  it("delivers a payload that is not valid JSON, byte for byte", async () => {
    const sent: HostToWebview[] = [];
    const host = new CoreProcessHost({ entryPath: entry, stopTimeoutMs: 2_000 });

    hosts.add(host);

    // Subscribed BEFORE `start`: the child subscribes to its engine as soon as
    // the engine is ready, so the first frames are emitted during `start` and a
    // forwarder attached afterwards would miss them. This is the ordering the
    // composition root has to follow too.
    createFrameForwarder({
      host,
      outbox: createOutbox((message) => {
        sent.push(message);
      }),
    });

    await host.start(INIT);

    const frames = sent.filter((message) => message.kind === "frame");

    expect(frames).toHaveLength(2);

    // The child emitted this string; it crossed a real IPC channel; a host that
    // parsed it would have thrown instead of forwarding it.
    expect(() => {
      JSON.parse(MALFORMED);
    }).toThrow();
    expect(frames[0]).toEqual({ kind: "frame", channel: "control", payload: MALFORMED });
    expect(frames[0]?.kind === "frame" ? frames[0].payload : "").toBe(MALFORMED);
    expect(frames[1]).toMatchObject({ kind: "frame", channel: "stream" });

    await host.stop();
  });
});

describe("a core that dies mid-command", () => {
  it("settles the in-flight command as failed instead of leaving it hanging", async () => {
    const host = await startHost();
    const sent: HostToWebview[] = [];
    const failures: string[] = [];

    host.onStatus((status) => {
      if (status.phase === "failed") failures.push(status.failure?.kind ?? "none");
    });

    const path = createCommandPath({
      host,
      outbox: createOutbox((message) => {
        sent.push(message);
      }),
      // Longer than this test needs, so only the crash can settle the command.
      replyTimeoutMs: 30_000,
    });

    expect(
      path.receive({
        kind: "command.invoke",
        callId: "wv-1",
        call: { capability: CRASH, body: {} },
      }),
    ).toEqual({ ok: true, handled: "command" });

    expect(path.pending).toBe(1);

    // The crash: the core exits while it owes this command an answer. Nothing
    // calls `stop`, which would settle the command before the exit arm runs.
    await vi.waitFor(() => {
      expect(replies(sent)).toHaveLength(1);
    });

    expect(replies(sent)[0]).toMatchObject({
      kind: "command.reply",
      callId: "wv-1",
      reply: { ok: false, code: "NOT_CONNECTED" },
    });
    expect(path.pending).toBe(0);
    expect(failures).toEqual(["crash"]);
  });
});
