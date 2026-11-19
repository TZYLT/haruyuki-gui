/**
 * The core child, forked for real: the artifact must bootstrap.
 *
 * Why this test exists
 *   The message loop in `./main.ts` only runs once somebody injects its three
 *   seams, and for a while nothing in the product did: `dist/core.mjs` exported
 *   a function, ran nothing, and exited 0. The extension host forks that file and
 *   then waits for `ready`, so the symptom was a boot timeout on a machine with a
 *   working engine, and no test anywhere was red.
 *
 *   So this test does not import the entry and call it. It bundles
 *   `src/core/entry.ts` the way the build does, forks the *file*, and grades the
 *   messages that come back. A bundle that only exports fails here the same way
 *   it fails in the editor.
 *
 * What `ready` actually means
 *   `./main.ts` emits `ready` only after `startEngine` resolved; a rejected start
 *   is a `failed` status and an exit. Both halves are asserted below, because the
 *   ordering is what makes the review honest: the first case proves a start that
 *   succeeds produces `ready`, the second proves a start that cannot succeed
 *   reports `failed` instead of hanging.
 *
 * The engine in the first case is a real child process the core spawns, prints
 * `WebSocket:` from, and handshakes with. It is a double, not a stub inside the
 * core: the spawn, the token file, the port discovery and the handshake all
 * really happen.
 */

import { fork, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** `apps/vscode`, this test's package root. */
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Repository root, for resolving dependencies the app itself does not declare. */
const REPO_ROOT = path.resolve(APP_ROOT, "..", "..");

/** `ws` is a dependency of `@haruyuki/core`; resolved the way the build does. */
const requireFromCore = createRequire(path.join(REPO_ROOT, "packages", "core", "package.json"));

/** Scratch tree for the bundle, the engine double and the four roots. */
let root = "";

/** The bundled entry, which is what a child loads. */
let entry = "";

/** The engine double the core will spawn in the first case. */
let engineFile = "";

/** The four roots the host would create before forking. */
let paths = { userData: "", logs: "", cache: "", temp: "" };

/** Children that must not outlive the suite. */
const children = new Set<ChildProcess>();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "haruyuki-core-entry-"));
  entry = path.join(root, "entry.mjs");
  engineFile = path.join(root, "engine-double.mjs");

  paths = {
    userData: path.join(root, "roots", "userData"),
    logs: path.join(root, "roots", "logs"),
    cache: path.join(root, "roots", "cache"),
    temp: path.join(root, "roots", "temp"),
  };

  for (const dir of [paths.userData, paths.logs, paths.cache, paths.temp]) {
    mkdirSync(dir, { recursive: true });
  }

  // `packages/core/src/engine/connection.ts` loads `ws` through
  // `createRequire(import.meta.url)`, so the package is resolved next to the
  // bundle at load time and cannot be inlined by the bundler. The shipped build
  // copies it beside `dist/core.mjs` for exactly this reason; the same copy has
  // to happen here or the fork dies on its very first import instead of starting.
  const wsDir = path.dirname(requireFromCore.resolve("ws/package.json"));

  cpSync(wsDir, path.join(root, "node_modules", "ws"), { recursive: true, dereference: true });

  const { buildSync } = requireFromCore("esbuild") as {
    buildSync: (options: Record<string, unknown>) => void;
  };

  buildSync({
    entryPoints: [path.join(APP_ROOT, "src", "core", "entry.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    outfile: entry,
    // `ws` stays external, exactly as the build script keeps it.
    external: ["ws"],
    logLevel: "silent",
  });

  writeFileSync(engineFile, engineDouble(), "utf8");
});

afterAll(() => {
  for (const child of children) {
    children.delete(child);

    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/**
 * The engine the core is allowed to find.
 *
 * It is spawned as `node engine-double.mjs server --listen ... --ws-token-file`,
 * so it prints the one line port discovery reads, answers the handshake and then
 * stays alive exactly as the real engine does. The URL path matches the shape
 * `port-discovery` accepts; the token is not checked, because authentication is
 * the engine's business and not the core's.
 *
 * @returns the module source, which is ESM because the core child loads it that way
 */
function engineDouble(): string {
  const wsDir = path.dirname(requireFromCore.resolve("ws/package.json"));

  return `import { createRequire } from "node:module";

const require = createRequire(${JSON.stringify(engineFile)});
const { WebSocketServer } = require(${JSON.stringify(wsDir)});

const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });

server.on("listening", () => {
  const { port } = server.address();

  process.stdout.write(\`WebSocket: ws://127.0.0.1:\${port}/ws\\n\`);
});

server.on("connection", (socket) => {
  socket.on("message", (data) => {
    let frame;

    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      return;
    }

    if (frame === null || frame.type !== "app_server_info") return;

    socket.send(
      JSON.stringify({
        type: "app_server_info_response",
        request_id: frame.request_id,
        success: true,
        letta_code_version: "0.6.0",
        protocol_version: 1,
        backend: "local",
        capabilities: {},
      }),
    );
  });
});

setInterval(() => {}, 1000);
`;
}

/** One message the child sent, with the moment it arrived. */
type Arrival = { readonly kind: string; readonly at: number };

/**
 * Fork the bundled entry the way the extension host does.
 *
 * @returns the child and a promise for every message it sends, in order
 */
function startCore(): {
  child: ChildProcess;
  arrivals: Arrival[];
  next: (kind: string, budgetMs?: number) => Promise<Arrival>;
  exited: Promise<{ code: number | null }>;
} {
  const child = fork(entry, { stdio: ["ignore", "pipe", "pipe", "ipc"], cwd: root });

  children.add(child);

  const started = Date.now();
  const arrivals: Arrival[] = [];
  const waiters: { kind: string; resolve: (arrival: Arrival) => void; timer: NodeJS.Timeout }[] =
    [];

  /** Stderr is the only place a bundle that died before subscribing explains itself. */
  let stderr = "";

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  child.on("message", (message: { kind?: string }) => {
    const arrival = { kind: String(message?.kind), at: Date.now() - started };

    arrivals.push(arrival);

    for (const waiter of [...waiters]) {
      if (waiter.kind !== arrival.kind) continue;

      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(arrival);
    }
  });

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.once("exit", (code) => {
      resolve({ code });
    });
  });

  return {
    child,
    arrivals,
    exited,
    next: (kind: string, budgetMs = 20_000): Promise<Arrival> =>
      new Promise<Arrival>((resolve, reject) => {
        const settled = arrivals.find((arrival) => arrival.kind === kind);

        if (settled !== undefined) {
          resolve(settled);
          return;
        }

        const timer = setTimeout(() => {
          reject(
            new Error(
              `no ${kind} within ${String(budgetMs)}ms; received ${JSON.stringify(arrivals)}; ` +
                `exit ${String(child.exitCode)}; stderr: ${stderr.trim()}`,
            ),
          );
        }, budgetMs);

        waiters.push({ kind, resolve, timer });
      }),
  };
}

/** @param version the engine build the host claims to expect */
function initMessage(version: string): Record<string, unknown> {
  return {
    kind: "init",
    paths,
    cwd: tmpdir(),
    locale: "en",
    engine: { kind: "external", dir: path.dirname(engineFile), bundlePath: engineFile },
    expectedVersion: version,
    // The capability table travels on `init`; the child refuses one without it.
    capabilities: {
      canNotify: false,
      canPopout: false,
      canFloat: false,
      canOpenExternal: false,
      canPickFiles: false,
      canReadDroppedFiles: false,
    },
  };
}

describe("the core child entry", () => {
  it("answers ready after a real engine handshake", async () => {
    const core = startCore();

    core.child.send(initMessage("0.6.0"));

    // `ready` is the whole point: the extension host waits for exactly this
    // message and times out when the bundle only exports the loop.
    const ready = await core.next("ready");

    expect(ready.kind).toBe("ready");

    // The status stream is what a reader watches while booting, so it must have
    // announced the start and the completion before the `ready` above.
    const phases = core.arrivals
      .filter((arrival) => arrival.kind === "status")
      .map((arrival) => arrival.at);

    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(ready.at).toBeGreaterThanOrEqual(phases[0] ?? 0);

    core.child.send({ kind: "shutdown" });
    await core.exited;
  });

  it("reports a failed start instead of hanging when the engine is missing", async () => {
    const core = startCore();

    core.child.send({
      ...initMessage("0.6.0"),
      paths: {
        userData: paths.userData,
        logs: paths.logs,
        cache: paths.cache,
        temp: paths.temp,
      },
      engine: {
        kind: "external",
        dir: path.join(root, "no-such-engine"),
        bundlePath: path.join(root, "no-such-engine", "haruyuki.js"),
      },
    });

    // A missing bundle is a spawn failure, so the child reports it and leaves.
    // It must not sit on the pipe waiting for the host's boot budget to expire.
    const { code } = await core.exited;

    expect(code).not.toBe(0);
    expect(core.arrivals.map((arrival) => arrival.kind)).toContain("status");
    expect(core.arrivals.map((arrival) => arrival.kind)).not.toContain("ready");
  });

  it("would have failed against a bundle that only exports the loop", async () => {
    // The negative control, and the reason the first case can be trusted: the
    // same fork against `./main.ts` itself produces no `ready` and no status,
    // which is precisely the shipped bug this test is here to keep from
    // returning. Without this case a passing suite would prove nothing about
    // the entry, because an exports-only bundle also exits 0 and looks calm.
    const onlyExports = path.join(root, "exports-only.mjs");

    const { buildSync } = requireFromCore("esbuild") as {
      buildSync: (options: Record<string, unknown>) => void;
    };

    buildSync({
      entryPoints: [path.join(APP_ROOT, "src", "core", "main.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      outfile: onlyExports,
      logLevel: "silent",
    });

    const child = fork(onlyExports, { stdio: ["ignore", "pipe", "pipe", "ipc"], cwd: root });

    children.add(child);

    const arrivals: string[] = [];
    child.on("message", (message: { kind?: string }) => {
      arrivals.push(String(message?.kind));
    });

    const { code } = await new Promise<{ code: number | null }>((resolve) => {
      child.once("exit", (exitCode) => {
        resolve({ code: exitCode });
      });

      child.send(initMessage("0.6.0"));
    });

    expect(code).toBe(0);
    expect(arrivals).toHaveLength(0);
  });
});
