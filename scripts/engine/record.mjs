#!/usr/bin/env node
/**
 * record.mjs - real-engine wire recorder.
 * Starts the pinned engine bundle, connects with the capability token, sends the
 * commands from --send in order, and writes every frame as one JSON object per
 * line (the frozen "wire" header, then { dir, at, msg } rows). Scenarios and
 * redaction are other packages; spawn/token/port plumbing mirrors
 * scripts/engine/acceptance.mjs. The token only travels through
 * --ws-token-file and is never printed; the port comes from the `WebSocket:`
 * stdout line; temp trees are removed pointwise. Raw output stays under
 * `_research/` (gitignored) as redaction "r0"; redaction rewrites it to "r1".
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..");
const BUNDLE_PATH = path.join(REPO_ROOT, "_research", "engine-0.6.0", "package", "haruyuki.js");
const CORE_PACKAGE_JSON = path.join(REPO_ROOT, "packages", "core", "package.json");
const FETCH_HINT = "node scripts/engine/fetch-engine.mjs";
const RAW_ROOT = path.join(REPO_ROOT, "_research", "engine-raw");
/** The only port-discovery path (F-6): same shape as the product parser. */
const PORT_LINE = /^WebSocket:\s+(ws:\/\/\S+)$/m;
const ENGINE_VERSION = "0.6.0",
  ENGINE_COMMIT = "1641a4f";
const URL_TIMEOUT_MS = 10000,
  SOCKET_TIMEOUT_MS = 5000;
const STOP_GRACE_MS = 2000,
  STOP_KILL_MS = 2000,
  CLOSE_GRACE_MS = 500;
const SEND_GAP_MS = 80,
  POLL_MS = 25,
  TOKEN_BYTES = 32,
  TOKEN_NAME = "engine-token";
const DEFAULT_IDLE_MS = 1500,
  DEFAULT_TIMEOUT_MS = 20000;
const SCENARIO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const HELP_TEXT = `Real-engine wire recorder.

Usage:
  node scripts/engine/record.mjs --scenario <name> --send <commands.json>
    [--out <file.jsonl>] [--idle <ms>] [--timeout <ms>] [--gap <ms>] [--keep-raw]
    [--provider-auth <auth.json>]

  --scenario  scenario name; also the default output file name
  --send      JSON array of raw c2s commands, sent in order, one frame each;
              a value written {{<request_id>.<path>}} is filled from the
              response to that request_id (runtime scopes, tool ids, ...)
  --out       default _research/engine-raw/<scenario>.jsonl (gitignored)
  --idle      stop after this long without a frame (default 1500 ms)
  --timeout   hard stop for the listening window (default 20000 ms)
  --gap       pause between sent commands (default 80 ms; raise it when a
              command bootstraps a runtime that needs real work first)
  --keep-raw  accepted for forward compatibility; raw output stays under _research/
  --auto-approve <allow|deny>  answer an interactive tool request without a human:
              the recorder replies to a control_request (subtype can_use_tool) with an
              approval_response carrying the same permission id, so the turn can run
              to completion. Without it a static command list can only record the
              request half of the approval flow.
  --provider-auth  provider credentials file copied into the run's throwaway home
              (<auth.json>/providers/auth.json layout is reproduced verbatim); the
              run root is deleted afterwards, so the caller's own home is never used
  --help      show this text

Output starts with the frozen "wire" header, then one
{ "dir": "s2c" | "c2s", "at": <ms since connect>, "msg": <object> } row per frame.
Exit codes: 0 recorded, 1 run failed, 2 usage or missing engine artifact.
Engine artifact: ${BUNDLE_PATH} (missing? run: ${FETCH_HINT})
`;
const out = (text) => process.stdout.write(text);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Run a best-effort action and swallow the error (closing dead sockets, pid races). */
const quietly = (action) => {
  try {
    action();
  } catch {
    /* best effort */
  }
};
/** Usage or artifact problems are exit 2; the message names the fix. */
function fail(message) {
  process.stderr.write(`record: ${message}\n`);
  process.exit(2);
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
/** Parse argv; an unknown flag or a missing value is a usage error (exit 2). */
function parseArgs(argv) {
  const options = {
    help: false,
    scenario: null,
    send: null,
    out: null,
    idleMs: DEFAULT_IDLE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    gapMs: SEND_GAP_MS,
    keepRaw: false,
    providerAuth: null,
    autoApprove: null,
  };
  const valueFlags = [
    "--scenario",
    "--send",
    "--out",
    "--idle",
    "--timeout",
    "--gap",
    "--provider-auth",
    "--auto-approve",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--keep-raw") options.keepRaw = true;
    else if (valueFlags.includes(flag)) {
      const raw = argv[(index += 1)];
      if (raw === undefined || raw.startsWith("--")) fail(`missing value for ${flag}`);
      if (flag === "--scenario") options.scenario = raw;
      else if (flag === "--send") options.send = raw;
      else if (flag === "--out") options.out = raw;
      else if (flag === "--provider-auth") options.providerAuth = raw;
      else if (flag === "--auto-approve") {
        if (raw !== "allow" && raw !== "deny") fail("--auto-approve expects allow or deny");
        options.autoApprove = raw;
      } else {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) fail(`${flag} expects a positive integer`);
        if (flag === "--idle") options.idleMs = parsed;
        else if (flag === "--timeout") options.timeoutMs = parsed;
        else options.gapMs = parsed;
      }
    } else if (flag.startsWith("--")) fail(`unknown flag: ${flag}`);
    else fail(`unexpected argument: ${flag}`);
  }
  if (options.help) return options;
  if (options.scenario === null) fail("missing required flag: --scenario");
  if (!SCENARIO_PATTERN.test(options.scenario))
    fail(`invalid --scenario name: ${options.scenario}`);
  if (options.send === null) fail("missing required flag: --send");
  return options;
}
/** Read the command list; a malformed file is a usage error before any spawn. */
function loadCommands(sendPath) {
  const absolute = path.resolve(process.cwd(), sendPath);
  let text;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    fail(`cannot read --send file ${absolute}: ${(error && error.code) || error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(`--send file is not valid JSON: ${(error && error.message) || error}`);
  }
  if (!Array.isArray(parsed)) fail("--send file must be a JSON array of command objects");
  if (parsed.length === 0) fail("--send file must contain at least one command");
  return parsed;
}
/** Frozen header row; r0 means not redacted yet. */
const headerLine = (scenario) => ({
  kind: "wire",
  schemaVersion: 1,
  engine: { version: ENGINE_VERSION, commit: ENGINE_COMMIT },
  scenario,
  redaction: "r0",
  clock: "real",
  recordedAt: new Date().toISOString(),
});
/** Explicit --out is cwd relative; the default is _research/engine-raw (gitignored). */
const resolveOutPath = (options) =>
  options.out === null
    ? path.join(RAW_ROOT, `${options.scenario}.jsonl`)
    : path.resolve(process.cwd(), options.out);
/** Resolve `ws` from packages/core so the recorder uses the host's own copy. */
function loadWebSocket() {
  try {
    return createRequire(CORE_PACKAGE_JSON)("ws");
  } catch (error) {
    throw new Error(
      `cannot resolve "ws" from ${CORE_PACKAGE_JSON}: ${(error && error.message) || error}`,
    );
  }
}
/**
 * Answer one interactive tool request, when the caller asked for it.
 *
 * The permission id lives on the request (`perm-<toolCallId>`), not on the command
 * that started the turn, so this is the one place a recording needs to react to a
 * frame instead of replaying a fixed list. `deny` carries the message the protocol
 * requires; `allow` needs nothing else.
 */
function answerApproval(ws, msg, behavior, record) {
  if (msg === null || typeof msg !== "object" || msg.type !== "control_request") return;
  if (msg.request === null || typeof msg.request !== "object") return;
  if (msg.request.subtype !== "can_use_tool") return;
  if (typeof msg.request_id !== "string" || typeof msg.request.tool_call_id !== "string") return;
  const decision =
    behavior === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: "denied by the recorder" };
  const reply = {
    type: "input",
    request_id: `approval-${msg.request.tool_call_id}`,
    runtime: msg.runtime,
    payload: { kind: "approval_response", request_id: msg.request_id, decision },
  };
  ws.send(JSON.stringify(reply));
  record("c2s", reply);
}

/** Isolated run root plus the `work` directory used as the engine cwd. */
async function createRunRoot() {
  const rootDir = await mkdtemp(path.join(tmpdir(), "haruyuki-record-"));
  const workDir = path.join(rootDir, "work");
  await mkdir(workDir);
  return { rootDir, workDir };
}
/**
 * Copy a provider credential file into the throwaway home, if one was given.
 *
 * The engine reads provider auth from `<home>/lc-local-backend/providers/auth.json`, so
 * seeding it there is the only way to record a real model turn without pointing the
 * engine at the machine's own home. The file lands inside the run root, which the
 * cleanup removes pointwise afterwards.
 */
function seedProviderAuth(rootDir, authPath) {
  if (authPath === null || authPath === undefined) return;
  if (!existsSync(authPath)) fail(`provider auth file not found: ${authPath}`);
  const target = path.join(rootDir, "lc-local-backend", "providers");
  mkdirSync(target, { recursive: true });
  copyFileSync(authPath, path.join(target, "auth.json"));
}

const isolatedEnv = (rootDir) => ({
  ...process.env,
  HARUYUKI_HOME: rootDir,
  USERPROFILE: rootDir,
  HOME: rootDir,
});
/** Write a capability token: 32 random bytes as hex, to a file only. */
async function writeToken(dir) {
  const value = randomBytes(TOKEN_BYTES).toString("hex");
  const tokenPath = path.join(dir, TOKEN_NAME);
  await writeFile(tokenPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") await chmod(tokenPath, 0o600);
  return { value, tokenPath };
}
/**
 * Remove a tree with single-path operations only: every file is unlinked and
 * every directory is rmdir'd bottom-up (no recursive delete API). The run root
 * is the only tree this script creates.
 */
function removeTreePointwise(rootDir) {
  const counts = { files: 0, directories: 0, failures: [] };
  const attempt = (target, action) => {
    try {
      action();
      return true;
    } catch (error) {
      if (!error || error.code !== "ENOENT")
        counts.failures.push({ path: target, error: (error && error.code) || error });
      return false;
    }
  }; // one point of failure recording for unlink and rmdir
  const walk = (dir) => {
    let entries = [];
    attempt(dir, () => {
      entries = readdirSync(dir, { withFileTypes: true });
    });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (attempt(target, () => unlinkSync(target))) counts.files += 1;
    }
    if (attempt(dir, () => rmdirSync(dir))) counts.directories += 1;
  };
  walk(path.resolve(rootDir));
  return counts;
}
/** Remove the temp tree, retrying briefly for handles Windows has not dropped. */
async function cleanupTemp(rootDir, attempts = 4) {
  let last = { files: 0, directories: 0, failures: [] };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = removeTreePointwise(rootDir);
    if (last.failures.length === 0) break;
    await sleep(150);
  }
  return { ...last, failureCount: last.failures.length, failures: last.failures.slice(0, 10) };
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
/** Spawn the engine as a direct child and capture stdout/stderr/port/exit. */
function spawnEngine({ rootDir, workDir, tokenPath }) {
  const child = spawn(process.execPath, [BUNDLE_PATH, ...engineArgs(tokenPath)], {
    cwd: workDir,
    env: isolatedEnv(rootDir),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = {
    startedAt: Date.now(),
    stdout: "",
    stderr: "",
    url: null,
    urlAt: 0,
    exited: false,
    exitCode: null,
    exitSignal: null,
    spawnError: undefined,
  };
  for (const stream of ["stdout", "stderr"]) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk) => {
      state[stream] += chunk;
      const match = stream === "stdout" && state.url === null ? PORT_LINE.exec(state.stdout) : null;
      if (match) {
        state.url = match[1];
        state.urlAt = Date.now();
      }
    });
  }
  child.on("error", (error) => {
    state.exited = true;
    state.spawnError = (error && error.message) || String(error);
  });
  child.on("exit", (code, signal) => {
    state.exited = true;
    state.exitCode = code;
    state.exitSignal = signal;
  });
  return { child, state };
}
/** Wait for the parsed `WebSocket:` URL, failing on exit or timeout. */
async function waitForUrl(engine, timeoutMs = URL_TIMEOUT_MS) {
  await waitFor(() => engine.state.url !== null || engine.state.exited, timeoutMs, 10);
  if (engine.state.url !== null)
    return { url: engine.state.url, spawnToUrlMs: engine.state.urlAt - engine.state.startedAt };
  if (engine.state.spawnError !== undefined)
    throw new Error(`engine spawn failed: ${engine.state.spawnError}`);
  if (engine.state.exited)
    throw new Error(`engine exited before publishing a URL (code ${engine.state.exitCode})`);
  throw new Error(`no WebSocket URL within ${timeoutMs} ms`);
}
/** Connect with the same `Authorization: Bearer <token>` shape acceptance uses. */
function connectSocket(url, token, timeoutMs = SOCKET_TIMEOUT_MS) {
  const WebSocket = loadWebSocket();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    const failWith = (message) => {
      clearTimeout(timer);
      quietly(() => ws.terminate());
      reject(new Error(message));
    };
    const timer = setTimeout(
      () => failWith(`websocket did not open within ${timeoutMs} ms`),
      timeoutMs,
    );
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, openedAt: Date.now(), OPEN: WebSocket.OPEN });
    });
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      failWith(`unexpected-response ${response.statusCode}`);
    });
    ws.on("error", (error) =>
      failWith(`websocket error ${(error && error.code) || "WS_ERROR"}: ${error && error.message}`),
    );
  });
}
/** Close the socket, then terminate it if the close handshake does not settle. */
async function closeSocket(ws) {
  // 3 is CLOSED in the ws instance state machine.
  if (ws.readyState === 3) return;
  const closed = new Promise((resolve) => ws.once("close", resolve));
  try {
    ws.close();
  } catch {
    /* the close event or terminate is the truth */
  }
  if (!(await Promise.race([closed.then(() => true), sleep(CLOSE_GRACE_MS).then(() => false)])))
    quietly(() => ws.terminate());
}
/** Stop the engine: SIGTERM, 2 s, then SIGKILL for a final 2 s. */
async function stopEngine({ child, state }) {
  const startedAt = Date.now();
  const result = () => ({
    exited: state.exited,
    ms: Date.now() - startedAt,
    code: state.exitCode,
    signal: state.exitSignal,
  });
  for (const [signal, budgetMs] of [
    ["SIGTERM", STOP_GRACE_MS],
    ["SIGKILL", STOP_KILL_MS],
  ]) {
    if (state.exited) return result();
    try {
      child.kill(signal);
    } catch {
      /* the exit event is the source of truth */
    }
    if (await waitFor(() => state.exited, budgetMs)) return result();
  }
  return result();
}
/** Replace secrets before anything reaches stdout. */
function scrub(text, token, tokenPath) {
  let value = typeof text === "string" ? text : "";
  for (const secret of [token, tokenPath])
    if (secret) value = value.split(secret).join("<redacted>");
  return value;
}
/**
 * Resolve a command's `{{<request_id>.<dotted.path>}}` placeholders from frames
 * already received. Static lists cannot know a runtime scope before the engine
 * answers runtime_start, so a command may reference the earlier response; the
 * wait is bounded by --timeout. Values without a placeholder pass through.
 */
async function resolvePlaceholders(value, responseOf) {
  if (typeof value === "string") {
    const match = /^\{\{([^.}]+)\.(.+)\}\}$/.exec(value);
    if (match === null) return value;
    let current = await responseOf(match[1]);
    for (const key of match[2].split("."))
      current = current === undefined || current === null ? undefined : current[key];
    if (current === undefined) throw new Error(`unresolved placeholder ${value}`);
    return current;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const entry of value) items.push(await resolvePlaceholders(entry, responseOf));
    return items;
  }
  if (value && typeof value === "object") {
    const resolved = {};
    for (const [key, entry] of Object.entries(value))
      resolved[key] = await resolvePlaceholders(entry, responseOf);
    return resolved;
  }
  return value;
}
/** Wait until the socket goes quiet (idle), the engine dies, or the hard limit hits. */
async function waitForSettle(ws, OPEN, engine, lastActivity, options) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    if (Date.now() - lastActivity() >= options.idleMs) return "idle";
    if (engine.state.exited) return "engine-exit";
    if (ws.readyState !== OPEN) return "socket-closed";
    await sleep(POLL_MS);
  }
  return "timeout";
}
/**
 * Record one session: isolated root, token file, engine, socket, commands,
 * settle window, then stop and pointwise cleanup. A thrown error is kept as a
 * string so cleanup always runs.
 */
async function runRecording(options) {
  const commands = loadCommands(options.send);
  const outPath = resolveOutPath(options);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const stats = { s2c: 0, c2s: 0 };
  const state = {
    engine: null,
    token: null,
    tokenPath: null,
    openedAt: 0,
    spawnToUrlMs: null,
    socketToOpenMs: null,
    sessionMs: null,
    settle: null,
    stop: null,
    cleanup: null,
    error: null,
  };
  const run = await createRunRoot();
  seedProviderAuth(run.rootDir, options.providerAuth);
  const fd = openSync(outPath, "w");
  let ws = null;
  let recording = true;
  let lastActivityAt = Date.now();
  const record = (dir, msg) => {
    if (!recording) return;
    writeSync(
      fd,
      `${JSON.stringify({ dir, at: Math.max(0, Math.round(Date.now() - state.openedAt)), msg })}\n`,
    );
    stats[dir] += 1;
    lastActivityAt = Date.now();
  };
  try {
    writeSync(fd, `${JSON.stringify(headerLine(options.scenario))}\n`);
    const token = await writeToken(run.rootDir);
    state.token = token.value;
    state.tokenPath = token.tokenPath;
    state.engine = spawnEngine({
      rootDir: run.rootDir,
      workDir: run.workDir,
      tokenPath: token.tokenPath,
    });
    const started = await waitForUrl(state.engine);
    state.spawnToUrlMs = started.spawnToUrlMs;
    const socketStart = Date.now();
    const opened = await connectSocket(started.url, token.value);
    state.socketToOpenMs = Date.now() - socketStart;
    ws = opened.ws;
    state.openedAt = opened.openedAt;
    lastActivityAt = Date.now();
    const responses = new Map();
    ws.on("message", (data, isBinary) => {
      const raw = isBinary ? `[binary frame: ${data.length} bytes]` : data.toString("utf8");
      // A frame that cannot be parsed is still recorded: a silent hole is worse.
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        msg = { unparsed: raw };
      }
      if (msg && typeof msg.request_id === "string") responses.set(msg.request_id, msg);
      record("s2c", msg);
      if (options.autoApprove !== null) answerApproval(ws, msg, options.autoApprove, record);
    });
    const responseOf = async (requestId) => {
      if (!(await waitFor(() => responses.has(requestId), options.timeoutMs)))
        throw new Error(`no response for request_id ${requestId}`);
      return responses.get(requestId);
    };
    for (const [index, command] of commands.entries()) {
      if (index > 0) await sleep(options.gapMs);
      if (ws.readyState !== opened.OPEN)
        throw new Error("socket closed before all commands were sent");
      const wire = await resolvePlaceholders(command, responseOf);
      ws.send(JSON.stringify(wire));
      record("c2s", wire);
    }
    state.settle = await waitForSettle(
      ws,
      opened.OPEN,
      state.engine,
      () => lastActivityAt,
      options,
    );
    state.sessionMs = Date.now() - state.openedAt;
  } catch (error) {
    state.error = (error && error.message) || String(error);
  } finally {
    recording = false;
    if (ws !== null) await closeSocket(ws);
    if (state.engine !== null) state.stop = await stopEngine(state.engine);
    if (state.tokenPath !== null) await unlink(state.tokenPath).catch(() => undefined);
    state.cleanup = await cleanupTemp(run.rootDir);
    closeSync(fd);
  }
  const ok =
    state.error === null &&
    state.stop !== null &&
    state.stop.exited &&
    state.cleanup.failureCount === 0;
  const ms = (value) => `${Math.round(value === null ? -1 : value)}ms`;
  out(
    `recording: ${outPath}\nscenario: ${options.scenario}  lines: ${1 + stats.s2c + stats.c2s}  s2c: ${stats.s2c}  c2s: ${stats.c2s}\n`,
  );
  out(
    `timings: spawn->url ${ms(state.spawnToUrlMs)}, socket ${ms(state.socketToOpenMs)}, session ${ms(state.sessionMs)}, stop ${ms(state.stop === null ? null : state.stop.ms)}  settle: ${state.settle === null ? "n/a" : state.settle}\n`,
  );
  out(
    `engine exit: ${state.stop === null ? "n/a" : `${state.stop.exited} code=${state.stop.code} signal=${state.stop.signal}`}\n`,
  );
  out(
    `cleanup: ${state.cleanup.files} files, ${state.cleanup.directories} dirs, ${state.cleanup.failureCount} left behind\n`,
  );
  out(`status: ${ok ? "ok" : "failed"}\n`);
  if (state.error !== null) out(`error: ${scrub(state.error, state.token, state.tokenPath)}\n`);
  return { ok };
}
/** Entry point; exit codes: 0 recorded, 1 run failed, 2 usage or artifact. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    out(HELP_TEXT);
    return 0;
  }
  if (!existsSync(BUNDLE_PATH)) fail(`engine bundle not found: ${BUNDLE_PATH}\nrun: ${FETCH_HINT}`);
  return (await runRecording(options)).ok ? 0 : 1;
}
main().catch((error) => {
  process.stderr.write(`record: ${(error && error.message) || String(error)}\n`);
  process.exitCode = 1;
});
