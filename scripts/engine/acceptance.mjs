#!/usr/bin/env node
/**
 * acceptance.mjs - real-engine acceptance runs for the B1 engine host.
 *
 * Scope: the acceptance subcommands below. Exit codes:
 * 0 pass, 1 fail, 2 engine artifact missing. Not part of `pnpm verify`.
 *
 * Invariants (section 8): the token only reaches the engine through
 * `--ws-token-file`; `ready` means the `app_server_info` response arrived, not
 * that the socket opened; the port is only parsed from stdout, never guessed;
 * temp trees are removed pointwise, never with a recursive delete.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script and the repo root derived from it, never from cwd. */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..");
/** Unpacked engine entry point produced by scripts/engine/fetch-engine.mjs. */
const BUNDLE_PATH = path.join(REPO_ROOT, "_research", "engine-0.6.0", "package", "haruyuki.js");
/** Watchdog preload shipped with the package. */
const WATCHDOG_PATH = path.join(REPO_ROOT, "packages", "core", "src", "runtime", "watchdog.cjs");
/** Resolution base for `ws`. */
const CORE_PACKAGE_JSON = path.join(REPO_ROOT, "packages", "core", "package.json");
/** What a developer must run when the engine artifact is absent. */
const FETCH_HINT = "node scripts/engine/fetch-engine.mjs";
/** F-6 is the only discovery path for the bound port (F-7, F-8: no ws-url-file). */
const PORT_LINE = /^WebSocket:\s+(ws:\S+)$/m;
/** Watchdog self-check marker written to the engine's stderr (section 3.4). */
const MARKER_LINE = /^WATCHDOG_OK=(\d+)$/m;
/** Line the inner harness prints with the engine pid. */
const HARNESS_PID_LINE = /^HARNESS_ENGINE_PID=(\d+)$/m;
/** Budgets and counts straight from the acceptance criteria. */
const URL_TIMEOUT_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 5000;
const ATTEMPTS = 20;
const MAX_FAILURES = 3;
const STOP_GRACE_MS = 2000;
const STOP_KILL_MS = 2000;
const PARENT_DEATH_MS = 5000;
const POLL_MS = 25;
const TOKEN_BYTES = 32;
const TOKEN_NAME = "engine-token";
const MAX_DEPTH = 8;
/** Usage text for --help and for an unknown subcommand. */
const HELP_TEXT = [
  "Real-engine acceptance for the engine host.",
  "",
  "Usage: node scripts/engine/acceptance.mjs <subcommand>",
  "",
  "  coldstart  20 isolated start -> ready -> stopGraceful cycles",
  "  watchdog   watchdog marker and self-exit within 5s of a parent death",
  "  acl        token ACL, token absent from argv, token gone after exit",
  "  orphan     no engine survives a crashed launcher",
  "  --help     show this text",
  "",
  "Exit codes: 0 pass, 1 fail, 2 engine artifact missing.",
  `Engine artifact: ${BUNDLE_PATH} (missing? run: ${FETCH_HINT})`,
  "",
].join("\n");

/** Single stdout write point so output ordering stays obvious. */
const out = (text) => process.stdout.write(text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const roundMs = (value) => Math.round(value);
/** Run a best-effort action and swallow the error (closing dead sockets, pid races). */
const quietly = (action) => {
  try {
    action();
  } catch {
    // Best effort only.
  }
};
/** min / median / max; the median of an even sample count is the mean of both middles. */
function stats(values) {
  if (values.length === 0) return { min: null, median: null, max: null, samples: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    min: roundMs(sorted[0]),
    median: roundMs(median),
    max: roundMs(sorted[sorted.length - 1]),
    samples: sorted.length,
  };
}
/** True while the pid exists; EPERM means alive but not ours. */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error) && error.code === "EPERM";
  }
}
/** Wait until a pid disappears; `process.kill(pid, 0)` throwing ESRCH proves it is gone. */
async function waitPidGone(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isPidAlive(pid)) return { gone: true, ms: Date.now() - startedAt };
    await sleep(POLL_MS);
  }
  return { gone: !isPidAlive(pid), ms: Date.now() - startedAt };
}
/** Wait until `predicate` returns true or the budget expires. */
async function waitFor(predicate, timeoutMs, intervalMs = POLL_MS) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}
/** Poll a text source until `pattern` matches, then return the match (or null). */
async function waitForMatch(readText, pattern, timeoutMs) {
  await waitFor(() => pattern.test(readText()), timeoutMs);
  return pattern.exec(readText());
}
/** Run a command without a shell and always resolve with the full result. */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const settings = { encoding: "utf8", windowsHide: true, ...options };
    execFile(command, args, settings, (error, stdout, stderr) => {
      const text = (value) => (typeof value === "string" ? value : "");
      resolve({ ok: error === null, stdout: text(stdout), stderr: text(stderr) });
    });
  });
}
/** Build a stage-tagged error so the report names the phase that broke. */
function stageError(stage, message, extra = {}) {
  const error = new Error(message);
  error.stage = stage;
  Object.assign(error, extra);
  return error;
}
/** Resolve `ws` from packages/core so the harness uses the host's own copy. */
function loadWebSocket() {
  try {
    return createRequire(CORE_PACKAGE_JSON)("ws");
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    throw stageError("dependencies", `cannot resolve "ws" from ${CORE_PACKAGE_JSON}: ${detail}`);
  }
}

/**
 * Remove a tree with single-path operations only: collect every file and
 * directory, then `unlinkSync` each file and `rmdirSync` each directory
 * bottom-up. No recursive delete API (section 5.1 rule 3); a path outside the
 * root or deeper than the bound is reported instead of removed.
 */
function removeTreePointwise(rootDir) {
  const root = path.resolve(rootDir);
  const normalize = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const rootKey = normalize(root.endsWith(path.sep) ? root : root + path.sep);
  const files = [];
  const dirs = [];
  const failures = [];
  const queue = [{ dir: root, depth: 0 }];
  const note = (target, error) => {
    if (!error || error.code !== "ENOENT") {
      failures.push({ path: target, error: error && error.code ? error.code : String(error) });
    }
  };
  while (queue.length > 0) {
    const { dir, depth } = queue.pop();
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code !== "ENOENT") note(dir, error);
      continue;
    }
    dirs.push(dir);
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (!normalize(path.resolve(entryPath)).startsWith(rootKey)) {
        failures.push({ path: entryPath, error: "outside-temp-root" });
      } else if (!entry.isDirectory()) {
        files.push(entryPath);
      } else if (depth >= MAX_DEPTH) {
        failures.push({ path: entryPath, error: "max-depth-reached" });
      } else {
        queue.push({ dir: entryPath, depth: depth + 1 });
      }
    }
  }
  for (const file of files) {
    try {
      unlinkSync(file);
    } catch (error) {
      note(file, error);
    }
  }
  // Deepest first: a directory can only be removed once it is empty.
  for (const dir of dirs.reverse()) {
    try {
      rmdirSync(dir);
    } catch (error) {
      note(dir, error);
    }
  }
  return { files: files.length, directories: dirs.length, failures };
}
/** Remove a run's temp tree, retrying briefly for handles Windows has not dropped. */
async function cleanupRunTemp(rootDir, attempts = 4) {
  let last = { files: 0, directories: 0, failures: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = removeTreePointwise(rootDir);
    if (last.failures.length === 0) break;
    await sleep(150);
  }
  return {
    files: last.files,
    directories: last.directories,
    failureCount: last.failures.length,
    failures: last.failures.slice(0, 10),
  };
}
/** Create an isolated run root plus the `work` directory used as the engine cwd. */
async function createRunRoot(prefix) {
  const rootDir = await mkdtemp(path.join(tmpdir(), prefix));
  const workDir = path.join(rootDir, "work");
  await mkdir(workDir);
  return { rootDir, workDir };
}
/** Engine isolation env: state dirs and cwd point into the run root. */
const isolatedEnv = (rootDir) => ({
  ...process.env,
  HARUYUKI_HOME: rootDir,
  USERPROFILE: rootDir,
  HOME: rootDir,
});
/** Write a capability token: 32 random bytes as hex, to a file only (invariant 1). */
async function writeToken(dir) {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const tokenPath = path.join(dir, TOKEN_NAME);
  await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  return { token, tokenPath };
}
/** Apply the same token ACL the core applies: Windows current account only, POSIX 0o600. */
async function hardenTokenFile(tokenPath) {
  if (process.platform !== "win32") {
    await chmod(tokenPath, 0o600);
    return { applied: true, detail: "" };
  }
  const result = await runCommand("icacls", [
    tokenPath,
    "/inheritance:r",
    "/grant:r",
    `${userInfo().username}:R`,
  ]);
  return { applied: result.ok, detail: result.ok ? "" : result.stderr.trim() };
}
/** Remove the token file with one `unlink`; a missing file is not an error. */
async function removeTokenFile(tokenPath) {
  try {
    await unlink(tokenPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
  }
}
/** Engine argv, bundle first (`node haruyuki.js server ...`). */
const engineArgs = (tokenPath) => [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
  tokenPath,
];
/** Shared stdout/stderr/port/exit capture for an engine or harness child. */
function attachCapture(child, startedAt = Date.now()) {
  const state = { startedAt, stdout: "", stderr: "", url: null, urlAt: 0 };
  Object.assign(state, { exited: false, exitCode: null, exitSignal: null, spawnError: undefined });
  for (const stream of ["stdout", "stderr"]) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk) => {
      state[stream] += chunk;
      if (stream !== "stdout" || state.url !== null) return;
      const match = PORT_LINE.exec(state.stdout);
      if (match) {
        state.url = match[1];
        state.urlAt = Date.now();
      }
    });
  }
  child.on("error", (error) => {
    state.exited = true;
    state.spawnError = error && error.message ? error.message : String(error);
  });
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
  });
  return state;
}
/** Spawn the engine as a direct child. */
function spawnEngine({ rootDir, workDir, tokenPath }) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [BUNDLE_PATH, ...engineArgs(tokenPath)], {
    cwd: workDir,
    env: isolatedEnv(rootDir),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, state: attachCapture(child, startedAt) };
}
/** Wait for the parsed `WebSocket:` URL, failing on exit or timeout. */
async function waitForUrl({ state }, timeoutMs = URL_TIMEOUT_MS) {
  await waitFor(() => state.url !== null || state.exited, timeoutMs, 10);
  if (state.url !== null) return { url: state.url, spawnToUrlMs: state.urlAt - state.startedAt };
  if (state.spawnError !== undefined) {
    throw stageError("spawn", `engine spawn failed: ${state.spawnError}`, { state });
  }
  const detail = `code ${state.exitCode}, signal ${state.exitSignal}`;
  if (state.exited) {
    throw stageError("spawn->url", `engine exited before publishing a URL (${detail})`, { state });
  }
  throw stageError("spawn->url", `no WebSocket URL within ${timeoutMs} ms`, { state });
}

/**
 * Connect with `Authorization: Bearer <token>` and perform the `app_server_info`
 * handshake; no Origin header, the harness is a native client.
 */
function connectAndHandshake(url, token, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  const WebSocket = loadWebSocket();
  const requestId = `acceptance-${randomBytes(8).toString("hex")}`;
  const connectStartedAt = Date.now();
  return new Promise((resolve, reject) => {
    let openedAt = 0;
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const done = (error, value) => {
      clearTimeout(timer);
      quietly(() => ws.close());
      // terminate() drops the socket without a close handshake: no lingering handle.
      setTimeout(() => quietly(() => ws.terminate()), 0).unref();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      done(stageError("handshake", `no app_server_info_response within ${timeoutMs} ms`));
    }, timeoutMs);
    ws.on("open", () => {
      openedAt = Date.now();
      ws.send(JSON.stringify({ type: "app_server_info", request_id: requestId }));
    });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      done(stageError("connect", `unexpected-response ${response.statusCode}`));
    });
    ws.on("error", (error) => {
      const code = error && error.code ? error.code : "WS_ERROR";
      done(stageError("connect", `websocket error ${code}: ${error && error.message}`));
    });
    ws.on("message", (data) => {
      let message = null;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message || message.type !== "app_server_info_response") return;
      if (message.request_id !== requestId) return;
      done(null, {
        info: message,
        requestId,
        urlToOpenMs: openedAt - connectStartedAt,
        handshakeMs: Date.now() - openedAt,
      });
    });
  });
}
/** Validate the frozen handshake shape (F-15, F-17); `ready` needs all three fields. */
function assertHandshake(info, requestId, expectedProtocolVersion = 1) {
  const problems = [];
  if (info.request_id !== requestId) {
    problems.push(`request_id mismatch: expected ${requestId}, got ${String(info.request_id)}`);
  }
  if (info.success !== true) problems.push(`success is ${String(info.success)}, expected true`);
  if (info.protocol_version !== expectedProtocolVersion) {
    problems.push(`protocol_version is ${String(info.protocol_version)}, expected 1`);
  }
  if (problems.length > 0) throw stageError("handshake-validation", problems.join("; "), { info });
  return {
    protocolVersion: info.protocol_version,
    engineVersion: typeof info.letta_code_version === "string" ? info.letta_code_version : "",
  };
}
/** Hard-stop a pid and its children; last resort after SIGTERM / SIGKILL. */
async function forceKillTree(pid) {
  if (process.platform === "win32") {
    return runCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 15000 });
  }
  quietly(() => process.kill(pid, "SIGKILL"));
}
/** Stop the engine: SIGTERM, 2 s, SIGKILL, 2 s, then a forced tree kill (section 3.4). */
async function stopEngine({ child, state }) {
  const startedAt = Date.now();
  const stopMs = () => Date.now() - startedAt;
  for (const [signal, budgetMs] of [
    ["SIGTERM", STOP_GRACE_MS],
    ["SIGKILL", STOP_KILL_MS],
  ]) {
    if (state.exited) return { exited: true, ms: stopMs() };
    try {
      child.kill(signal);
    } catch {
      // The exit event below is the source of truth.
    }
    if (await waitFor(() => state.exited, budgetMs)) return { exited: true, ms: stopMs() };
  }
  await forceKillTree(child.pid);
  const exited = await waitFor(() => state.exited, STOP_KILL_MS);
  return { exited, ms: stopMs() };
}
/** Print the raw engine output attached to a failed stage (evidence for the report). */
function printFailureDetail(label, error) {
  const state = error && error.state ? error.state : null;
  const stage = error && error.stage ? error.stage : "unknown";
  const message = error && error.message ? error.message : String(error);
  out(`\n--- ${label} failed at stage: ${stage}\n--- message: ${message}\n`);
  if (state === null) return;
  out(`--- engine stdout:\n${state.stdout || "(empty)"}\n`);
  out(`--- engine stderr:\n${state.stderr || "(empty)"}\n--- end of failure detail\n\n`);
}

/**
 * Run one direct-engine scenario: isolated root, token, engine, stop, token
 * removal, pointwise cleanup. The handler fills `ctx.result`; a thrown error is
 * recorded as a string failure instead of escaping, and the engine is always
 * stopped and the token always removed.
 */
async function withEngineRun(prefix, handler) {
  const run = await createRunRoot(prefix);
  const ctx = {
    ...run,
    token: null,
    tokenPath: null,
    engine: null,
    stopMs: null,
    result: null,
    tokenRemoved: null,
    failures: [],
    cause: null,
    cleanup: { files: 0, directories: 0, failureCount: 0, failures: [] },
  };
  try {
    const written = await writeToken(run.rootDir);
    Object.assign(ctx, written);
    await handler(ctx);
  } catch (error) {
    ctx.cause = error;
    ctx.failures.push({
      stage: (error && error.stage) || "engine",
      error: error && error.message ? error.message : String(error),
    });
  } finally {
    if (ctx.engine !== null) {
      const stopped = await stopEngine(ctx.engine);
      ctx.stopMs = stopped.ms;
      if (!stopped.exited) {
        ctx.failures.push({ stage: "stop", error: "engine did not exit after SIGTERM/SIGKILL" });
      }
    }
    if (ctx.tokenPath !== null) {
      await removeTokenFile(ctx.tokenPath).catch(() => undefined);
      ctx.tokenRemoved = !existsSync(ctx.tokenPath);
    }
    ctx.cleanup = await cleanupRunTemp(run.rootDir);
    if (ctx.cleanup.failureCount > 0) {
      const detail = `${ctx.cleanup.failureCount} temp paths left behind`;
      ctx.failures.push({ stage: "cleanup", error: detail });
    }
  }
  return ctx;
}

/**
 * Twenty consecutive cold starts, each in its own isolated temp root:
 * fresh token, fresh home, fresh cwd, start -> ready -> stopGraceful. A failed
 * stage prints the raw engine output; the loop gives up after MAX_FAILURES.
 */
async function runColdstart() {
  const samples = { spawnToUrl: [], urlToOpen: [], handshake: [], ready: [], stop: [] };
  const failures = [];
  const cleanup = { files: 0, directories: 0, failureCount: 0, failures: [] };
  const versions = new Set();
  const protocols = new Set();
  let successes = 0;
  out(`coldstart: ${ATTEMPTS} isolated cycles\n`);
  for (let index = 1; index <= ATTEMPTS; index += 1) {
    const label = `[coldstart ${String(index).padStart(2, "0")}/${ATTEMPTS}]`;
    const ctx = await withEngineRun("haruyuki-accept-cold-", async (c) => {
      c.engine = spawnEngine({ rootDir: c.rootDir, workDir: c.workDir, tokenPath: c.tokenPath });
      const { url, spawnToUrlMs } = await waitForUrl(c.engine);
      const hs = await connectAndHandshake(url, c.token);
      const parsed = assertHandshake(hs.info, hs.requestId);
      c.result = { spawnToUrlMs, hs, parsed, readyMs: Date.now() - c.engine.state.startedAt };
    });
    cleanup.files += ctx.cleanup.files;
    cleanup.directories += ctx.cleanup.directories;
    cleanup.failureCount += ctx.cleanup.failureCount;
    cleanup.failures.push(...ctx.cleanup.failures);
    if (ctx.failures.length > 0) {
      const failure = ctx.failures[0];
      failures.push({ attempt: index, stage: failure.stage, error: failure.error });
      if (ctx.cause !== null) printFailureDetail(label, ctx.cause);
      const stop = ctx.stopMs === null ? "n/a" : `${roundMs(ctx.stopMs)}ms`;
      out(`${label} FAIL stage=${failure.stage} stop=${stop}\n`);
    } else {
      const { spawnToUrlMs, hs, parsed, readyMs } = ctx.result;
      samples.spawnToUrl.push(spawnToUrlMs);
      samples.urlToOpen.push(hs.urlToOpenMs);
      samples.handshake.push(hs.handshakeMs);
      samples.ready.push(readyMs);
      samples.stop.push(ctx.stopMs);
      versions.add(parsed.engineVersion);
      protocols.add(parsed.protocolVersion);
      successes += 1;
      out(
        `${label} ok  spawn->url ${roundMs(spawnToUrlMs)}ms  url->open ${roundMs(hs.urlToOpenMs)}ms  handshake ${roundMs(hs.handshakeMs)}ms  ready ${roundMs(readyMs)}ms  stop ${roundMs(ctx.stopMs)}ms  protocol ${parsed.protocolVersion}\n`,
      );
    }
    if (failures.length >= MAX_FAILURES) {
      out(`coldstart: aborting after ${failures.length} failures\n`);
      break;
    }
  }
  const pass = successes === ATTEMPTS && failures.length === 0 && cleanup.failureCount === 0;
  return {
    pass,
    summary: {
      subcommand: "coldstart",
      pass,
      attempts: ATTEMPTS,
      successes,
      failures,
      protocolVersions: [...protocols],
      engineVersions: [...versions],
      timingsMs: {
        spawnToUrl: stats(samples.spawnToUrl),
        urlToOpen: stats(samples.urlToOpen),
        handshake: stats(samples.handshake),
        ready: stats(samples.ready),
        stop: stats(samples.stop),
      },
      cleanup,
    },
  };
}

/**
 * Inner harness, run by re-invoking this script as `__harness <mode> ...`: a
 * scenario kills the engine's *parent*, and the watchdog only fires when its
 * parent disappears. The engine's stdout/stderr go to FILES, not pipes, because
 * a pipe would raise EPIPE when the harness dies and would muddy the question.
 */
function runHarnessChild(argv) {
  const [mode, bundlePath, tokenPath, homeDir, cwd, outLog, errLog, watchdogPath] = argv;
  const env = { ...process.env, HARUYUKI_HOME: homeDir, USERPROFILE: homeDir, HOME: homeDir };
  delete env.NODE_OPTIONS;
  if (watchdogPath && watchdogPath !== "-") {
    const target = process.platform === "win32" ? watchdogPath.replace(/\\/g, "/") : watchdogPath;
    env.NODE_OPTIONS =
      process.platform === "win32" ? `--require "${target}"` : `--require ${target}`;
  }
  const outFd = openSync(outLog, "a");
  const errFd = openSync(errLog, "a");
  const child = spawn(process.execPath, [bundlePath, ...engineArgs(tokenPath)], {
    cwd,
    env,
    stdio: ["pipe", outFd, errFd],
    windowsHide: true,
  });
  closeSync(outFd);
  closeSync(errFd);
  if (typeof child.pid !== "number") {
    out("HARNESS_ENGINE_ERROR=spawn-failed\n");
    return;
  }
  out(`HARNESS_ENGINE_PID=${child.pid}\n`);
  const startedAt = Date.now();
  let urlSeen = false;
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    // Short delay so the last stdout line lands; the parent also reads the logs.
    setTimeout(() => process.exit(code), 20);
  };
  const timer = setInterval(() => {
    if (!urlSeen) {
      const url = PORT_LINE.exec(readLogsSync(outLog));
      if (url) {
        urlSeen = true;
        out(`HARNESS_URL=${url[1]}\n`);
      }
    }
    if (mode === "exit" && (urlSeen || Date.now() - startedAt > 15000)) return finish(0);
    if (Date.now() - startedAt > 120000) finish(3);
  }, 20);
}
/** Spawn the inner harness for a harness scenario root. */
function spawnHarness(mode, tokenPath, ctx) {
  const env = { ...process.env };
  // The harness sets NODE_OPTIONS itself; inheriting it would make it self-watch.
  delete env.NODE_OPTIONS;
  const tail = [ctx.rootDir, ctx.workDir, ctx.outLog, ctx.errLog, WATCHDOG_PATH];
  const args = [SELF_PATH, "__harness", mode, BUNDLE_PATH, tokenPath, ...tail];
  const child = spawn(process.execPath, args, {
    cwd: ctx.rootDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return { child, state: attachCapture(child) };
}
/** Synchronous log read for polling predicates; a missing log is an empty string. */
function readLogsSync(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Run one harness scenario: isolated root, token, launcher, engine pid, cleanup.
 * The handler pushes into `ctx.failures`; nothing is judged here, so both
 * scenarios share this scaffolding and differ only in what they do to the parent.
 */
async function withHarnessRun(prefix, mode, name, handler) {
  const run = await createRunRoot(prefix);
  const ctx = {
    ...run,
    outLog: path.join(run.rootDir, "engine-out.log"),
    errLog: path.join(run.rootDir, "engine-err.log"),
    failures: [],
    enginePid: null,
    harness: null,
    cleanup: { files: 0, directories: 0, failureCount: 0, failures: [] },
  };
  try {
    const { tokenPath } = await writeToken(run.rootDir);
    ctx.harness = spawnHarness(mode, tokenPath, ctx);
    const pidMatch = await waitForMatch(() => ctx.harness.state.stdout, HARNESS_PID_LINE, 15000);
    if (pidMatch === null) {
      const detail = ctx.harness.state.stderr.trim() || "(empty)";
      throw stageError("harness-spawn", `no engine pid reported; stderr: ${detail}`);
    }
    ctx.enginePid = Number(pidMatch[1]);
    out(`${name}: harness ${ctx.harness.child.pid}, engine ${ctx.enginePid}\n`);
    await handler(ctx);
  } catch (error) {
    ctx.failures.push({
      check: (error && error.stage) || "harness",
      error: error && error.message ? error.message : String(error),
    });
    out(`engine stderr:\n${readLogsSync(ctx.errLog) || "(empty)"}\n`);
  } finally {
    if (ctx.enginePid !== null && isPidAlive(ctx.enginePid)) {
      await forceKillTree(ctx.enginePid);
      await waitPidGone(ctx.enginePid, STOP_KILL_MS);
    }
    if (ctx.harness !== null && isPidAlive(ctx.harness.child.pid)) {
      quietly(() => ctx.harness.child.kill("SIGKILL"));
      await waitFor(() => ctx.harness.state.exited, 2000);
    }
    ctx.cleanup = await cleanupRunTemp(run.rootDir);
    if (ctx.cleanup.failureCount > 0) {
      ctx.failures.push({
        check: "cleanup",
        error: `${ctx.cleanup.failureCount} temp paths left behind`,
      });
    }
  }
  return ctx;
}
/** Wait for the engine to die after its parent vanished; records the watchdog evidence. */
async function awaitParentDeath(ctx, check, sinceAt) {
  const markerMatch = await waitForMatch(() => readLogsSync(ctx.errLog), MARKER_LINE, 2000);
  const marker = markerMatch === null ? null : Number(markerMatch[1]);
  const missing = `WATCHDOG_OK missing from ${ctx.errLog}`;
  const mismatch = `WATCHDOG_OK=${marker} does not match the engine pid ${ctx.enginePid}`;
  if (marker === null) ctx.failures.push({ check: "watchdog-marker", error: missing });
  else if (marker !== ctx.enginePid)
    ctx.failures.push({ check: "watchdog-marker", error: mismatch });
  const gone = await waitPidGone(ctx.enginePid, PARENT_DEATH_MS);
  // Measured from the parent-loss event, not from the poll that observed it.
  const elapsed = Date.now() - sinceAt;
  if (!gone.gone) {
    const stuck = `engine ${ctx.enginePid} still alive ${elapsed} ms after the parent went away (limit ${PARENT_DEATH_MS} ms)`;
    ctx.failures.push({ check, error: stuck });
  }
  return { marker, disappeared: { gone: gone.gone, ms: elapsed } };
}

/**
 * The watchdog must self-check and must exit the engine when its parent
 * dies. The script spawns a middle parent, that parent spawns the engine, and the
 * script SIGKILLs the middle parent; the engine must vanish within 5 s without
 * anyone signalling it.
 */
async function runWatchdog() {
  let marker = null;
  let engineStarted = false;
  let wasAlive = false;
  let disappeared = { gone: false, ms: 0 };
  const ctx = await withHarnessRun("haruyuki-accept-watchdog-", "stay", "watchdog", async (c) => {
    // The engine must be up and alive before the parent dies to make this meaningful.
    const urlMatch = await waitForMatch(() => readLogsSync(c.outLog), PORT_LINE, URL_TIMEOUT_MS);
    engineStarted = urlMatch !== null;
    if (!engineStarted) throw stageError("engine-start", `no URL: ${readLogsSync(c.errLog)}`);
    wasAlive = isPidAlive(c.enginePid);
    if (!wasAlive) throw stageError("engine-alive", `engine ${c.enginePid} is not running`);
    const killedAt = Date.now();
    quietly(() => c.harness.child.kill("SIGKILL"));
    await waitFor(() => c.harness.state.exited, 5000);
    const death = await awaitParentDeath(c, "engine-self-exit", killedAt);
    marker = death.marker;
    disappeared = death.disappeared;
    const shown = marker === null ? "missing" : `WATCHDOG_OK=${marker}`;
    out(`watchdog: marker ${shown}, engine gone after ${disappeared.ms} ms\n`);
  });
  const pass = ctx.failures.length === 0;
  return {
    pass,
    summary: {
      subcommand: "watchdog",
      pass,
      watchdogMarker: marker !== null,
      markerPid: marker,
      enginePid: ctx.enginePid,
      engineStarted,
      engineAliveBeforeKill: wasAlive,
      engineGone: disappeared.gone,
      disappearMs: roundMs(disappeared.ms),
      limitMs: PARENT_DEATH_MS,
      failures: ctx.failures,
      cleanup: ctx.cleanup,
    },
  };
}

/**
 * Read the command line of a live pid. Windows uses `Get-CimInstance
 * Win32_Process` through PowerShell, base64-encoded so console line wrapping
 * cannot corrupt it; POSIX reads `/proc/<pid>/cmdline`.
 */
async function readProcessCommandLine(pid) {
  if (process.platform !== "win32") {
    try {
      const raw = await readFile(`/proc/${pid}/cmdline`, "utf8");
      return { ok: true, commandLine: raw.split("\0").filter(Boolean).join(" ") };
    } catch (error) {
      const code = error && error.code ? error.code : String(error);
      return { ok: false, detail: `cannot read /proc/${pid}/cmdline: ${code}` };
    }
  }
  const script =
    `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; ` +
    "if ($null -eq $p -or [string]::IsNullOrEmpty($p.CommandLine)) { 'NO_COMMAND_LINE' } " +
    "else { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.CommandLine)) }";
  const result = await runCommand("powershell", ["-NoProfile", "-Command", script], {
    timeout: 30000,
  });
  if (!result.ok) return { ok: false, detail: `powershell failed: ${result.stderr.trim()}` };
  const encoded = result.stdout.trim();
  if (encoded === "" || encoded === "NO_COMMAND_LINE") {
    return { ok: false, detail: "the engine process has no readable command line" };
  }
  return { ok: true, commandLine: Buffer.from(encoded, "base64").toString("utf8") };
}

/**
 * Assert the token ACL: Windows `icacls` output may only name the current
 * account (no `Everyone`, no `BUILTIN\Users`), POSIX must be exactly `600`. The
 * Windows output is collapsed to one line and stripped of drive paths because
 * `icacls` wraps long paths and prints the first ACE on the path line.
 */
async function inspectTokenAcl(tokenPath) {
  if (process.platform !== "win32") {
    const result = await runCommand("stat", ["-c", "%a", tokenPath]);
    if (!result.ok) return { pass: false, detail: `stat failed: ${result.stderr.trim()}` };
    const mode = result.stdout.trim();
    return { pass: mode === "600", detail: `stat -c %a -> ${mode}` };
  }
  const result = await runCommand("icacls", [tokenPath]);
  if (!result.ok) return { pass: false, detail: `icacls failed: ${result.stderr.trim()}` };
  const user = userInfo().username;
  const cleaned = result.stdout.replace(/\s+/g, " ").replace(/[A-Za-z]:\\[^\s]*/g, "<path>");
  const problems = [];
  const forbidden = /everyone|builtin\\users|nt authority\\/gi;
  for (const match of cleaned.matchAll(forbidden)) {
    problems.push(`${match[0]} still holds an ACE`);
  }
  const principals = [...cleaned.matchAll(/([^\s<>()]+(?:\s[^\s<>()]+)?):\(/g)].map((m) => m[1]);
  for (const principal of principals) {
    if (!principal.endsWith(`\\${user}`)) problems.push(`unexpected principal ${principal}`);
  }
  if (principals.length === 0) problems.push(`no ACE for the current account ${user}`);
  return {
    pass: problems.length === 0,
    detail:
      problems.length === 0
        ? `only ${user} holds an ACE (${principals.join(", ")})`
        : problems.join("; "),
  };
}

/**
 * The token guarantees in one engine run: the token ACL while the engine is up, the engine's
 * own command line while it is up, and the token file after a clean stop.
 */
async function runAcl() {
  const checks = [];
  const add = (name, pass, detail, extra = {}) => checks.push({ name, pass, detail, ...extra });
  const ctx = await withEngineRun("haruyuki-accept-acl-", async (c) => {
    const hardened = await hardenTokenFile(c.tokenPath);
    out(`acl: token file ${c.tokenPath} (harden ${hardened.applied ? "ok" : "FAILED"})\n`);
    // Block 1: the on-disk ACL of the token file.
    const acl = await inspectTokenAcl(c.tokenPath);
    const aclDetail = hardened.applied ? acl.detail : `${acl.detail}; ${hardened.detail}`;
    add("token-file-acl", acl.pass && hardened.applied, aclDetail);
    // Engine up: block 2 needs a live process to inspect.
    c.engine = spawnEngine({ rootDir: c.rootDir, workDir: c.workDir, tokenPath: c.tokenPath });
    out(`acl: engine at ${(await waitForUrl(c.engine)).url}\n`);
    // Block 2: the token must not appear in the engine's own command line.
    const found = await readProcessCommandLine(c.engine.child.pid);
    if (!found.ok) {
      add("token-not-in-command-line", false, found.detail);
      return;
    }
    const problems = [];
    if (found.commandLine.includes(c.token)) {
      problems.push("the capability token appears verbatim in the command line");
    }
    if (!found.commandLine.includes("--ws-token-file")) {
      problems.push("--ws-token-file missing, so the inspected command line is suspicious");
    }
    const okDetail = "token absent, --ws-token-file present";
    const detail = problems.length === 0 ? okDetail : problems.join("; ");
    add("token-not-in-command-line", problems.length === 0, detail, {
      commandLine: found.commandLine,
    });
  });
  // Block 3: the helper unlinked the token after the stop and confirmed it is gone.
  const removed = ctx.tokenRemoved === true;
  add("token-removed-after-exit", removed, removed ? "removed with one unlink" : "still present");
  for (const check of checks) {
    out(`acl: ${check.pass ? "ok  " : "FAIL"} ${check.name}: ${check.detail}\n`);
  }
  const pass = ctx.failures.length === 0 && checks.length === 3 && checks.every((c) => c.pass);
  return {
    pass,
    summary: {
      subcommand: "acl",
      pass,
      checks,
      failures: ctx.failures,
      stopMs: ctx.stopMs === null ? null : roundMs(ctx.stopMs),
      cleanup: ctx.cleanup,
    },
  };
}

/**
 * A crashed launcher must not leave an engine behind. The launcher spawns
 * the engine and exits on its own; nobody signals the engine, and the watchdog is
 * expected to see the closed stdin pipe and leave.
 */
async function runOrphan() {
  let launcherExited = false;
  let served = false;
  let marker = null;
  let disappeared = { gone: false, ms: 0 };
  const ctx = await withHarnessRun("haruyuki-accept-orphan-", "exit", "orphan", async (c) => {
    // The launcher exits once the engine published its URL: that exit is the crash
    // being simulated, and the URL proves the engine was really serving first.
    const [, urlMatch] = await Promise.all([
      waitFor(() => c.harness.state.exited, 20000),
      waitForMatch(() => readLogsSync(c.outLog), PORT_LINE, URL_TIMEOUT_MS),
    ]);
    launcherExited = c.harness.state.exited;
    served = urlMatch !== null;
    if (!launcherExited) throw stageError("launcher-exit", "launcher did not exit in 20 s");
    if (!served) throw stageError("engine-serve", "engine never published its URL");
    const death = await awaitParentDeath(c, "orphan-engine", Date.now());
    marker = death.marker;
    disappeared = death.disappeared;
    out(
      `orphan: launcher exited, engine gone after ${disappeared.ms} ms (limit ${PARENT_DEATH_MS} ms)\n`,
    );
  });
  const residual = ctx.enginePid !== null && isPidAlive(ctx.enginePid);
  const pass = ctx.failures.length === 0 && !residual;
  return {
    pass,
    summary: {
      subcommand: "orphan",
      pass,
      enginePid: ctx.enginePid,
      engineServed: served,
      launcherExited,
      watchdogMarker: marker !== null,
      engineGone: disappeared.gone,
      disappearMs: roundMs(disappeared.ms),
      limitMs: PARENT_DEATH_MS,
      residual,
      failures: ctx.failures,
      cleanup: ctx.cleanup,
    },
  };
}
/** Verify the artifact every scenario needs; exit code 2 when it is absent. */
function checkArtifact() {
  const missing = {
    ok: false,
    reason: "engine-artifact-missing",
    detail: `engine artifact not found at ${BUNDLE_PATH}. Run: ${FETCH_HINT}`,
  };
  if (!existsSync(BUNDLE_PATH)) return missing;
  try {
    loadWebSocket();
    return { ok: true };
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    return { ok: false, reason: "ws-unresolved", detail };
  }
}
/** Dispatch one subcommand and translate its result into an exit code. */
async function main(argv) {
  const subcommand = argv[0] ?? "";
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    out(HELP_TEXT);
    return 0;
  }
  const runners = {
    coldstart: runColdstart,
    watchdog: runWatchdog,
    acl: runAcl,
    orphan: runOrphan,
  };
  if (!Object.hasOwn(runners, subcommand)) {
    out(`FAIL ${subcommand || "(none)"}: unknown subcommand\n\n${HELP_TEXT}`);
    return 1;
  }
  const artifact = checkArtifact();
  if (!artifact.ok) {
    out(`FAIL ${subcommand}: ${artifact.detail}\n`);
    out(`${JSON.stringify({ subcommand, pass: false, ...artifact })}\n`);
    return artifact.reason === "engine-artifact-missing" ? 2 : 1;
  }
  const result = await runners[subcommand]();
  out(`${result.pass ? "PASS" : "FAIL"} ${subcommand}\n`);
  out(`${JSON.stringify(result.summary)}\n`);
  return result.pass ? 0 : 1;
}
/** Set the exit code, then force-exit once stdout has had a chance to drain. */
function finish(code) {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 250);
  timer.unref();
}
const BOOT_ARGV = process.argv.slice(2);
if (BOOT_ARGV[0] === "__harness") {
  // Inner harness: stay alive so the scenario can kill this process.
  runHarnessChild(BOOT_ARGV.slice(1));
} else {
  main(BOOT_ARGV)
    .then((code) => finish(code))
    .catch((error) => {
      out(`FAIL unexpected error: ${error && error.stack ? error.stack : String(error)}\n`);
      finish(1);
    });
}
