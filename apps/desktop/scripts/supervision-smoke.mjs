#!/usr/bin/env node
/**
 * supervision-smoke.mjs - one command that judges P11 on a real machine.
 *
 * It builds the Electron-hosted probe (and the renderer the probe drives), launches
 * the probe under the Electron binary, streams its PASS/FAIL/SKIP lines, and exits
 * with the verdict. The probe owns the actual assertions; this script owns
 * prerequisites, environment isolation, the timeout and the exit code.
 *
 * Exit codes (the same split the other smoke scripts use, so CI can tell "broken"
 * from "not fetched"):
 *
 *   0  every required id printed PASS
 *   1  a required id printed FAIL or SKIP, the probe crashed, or it timed out
 *   2  an artifact is missing before the probe could run (Electron binary, engine
 *      bundle, or the toolchain that builds the probe)
 *
 * What it builds and why:
 *
 *   `vite.probe.mts` bundles the probe against `apps/desktop/src/main`, because the
 *   probe drives the product's own modules (supervision, crash capture, protocol,
 *   diagnostics) rather than copies of them.
 *
 *   `vite.renderer.mts` builds the renderer the crash page lives in. renderer-recovery-sequence has to
 *   load the real crash page, not a fixture: its title and its three actions are
 *   part of the judgment, and a stand-in would make that judgment fake. A stale
 *   `dist/renderer` would judge yesterday's page, so the build is not optional.
 *
 * The environment trap this script exists to survive: this machine sets
 * `ELECTRON_RUN_AS_NODE=1` globally. Inherited, the Electron binary runs as plain
 * Node, `app.whenReady()` never resolves, and the probe looks wedged. It is removed
 * from the child environment here, as is `NODE_OPTIONS`.
 *
 * Nothing here can leave a process behind: the probe cleans its own children, and a
 * timeout kills the tree of the one process this script spawned.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This script, and the repository root derived from it -- never from cwd. */
const SELF_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF_PATH), "..", "..", "..");
const DESKTOP_DIR = path.join(REPO_ROOT, "apps", "desktop");

/** The platform's Electron binary. */
const DEFAULT_ELECTRON_BIN =
  process.platform === "win32"
    ? path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron");

/** The engine package unpacked by `scripts/engine/fetch-engine.mjs`. */
const DEFAULT_ENGINE_BUNDLE = path.join(
  REPO_ROOT,
  "_research",
  "engine-0.6.0",
  "package",
  "haruyuki.js",
);

/** The probe bundle this script builds and runs. */
const PROBE_PATH = path.join(DESKTOP_DIR, "dist", "probe", "supervision-probe.cjs");

/** The built renderer the probe loads through the real `app://` handler. */
const RENDERER_ROOT = path.join(DESKTOP_DIR, "dist", "renderer");

/** The workspace's Vite CLI; `apps/desktop` does not install its own copy. */
const VITE_BIN = path.join(REPO_ROOT, "node_modules", "vite", "bin", "vite.js");

/** Every id the probe must judge; a missing line is a failure. */
const REQUIRED_IDS = ["leaked-child-reclaimed", "engine-stop-exit-record", "ambiguous-pid-not-killed", "engine-crash-record", "renderer-recovery-sequence", "main-crash-record", "diagnostic-bundle-tree"];

/** Total budget. The probe runs seven checks, two engine starts and three renderer
 * crashes; 120 s is generous without hiding a hang. */
const TIMEOUT_MS = 120_000;

/** Build ceiling; a Vite build that takes longer than this is wedged. */
const BUILD_TIMEOUT_MS = 120_000;

/** Print and exit. */
function fail(message, code = 1) {
  process.stderr.write(`\n${message}\n`);
  process.exit(code);
}

/**
 * Resolve an artifact path, preferring an environment override.
 *
 * The overrides exist for the CI-shaped case where the engine package lives outside
 * this checkout: the probe is still run against a real engine, just not at the
 * default path.
 *
 * @param {string} name environment variable name
 * @param {string} fallback default path
 * @returns {string}
 */
function artifactPath(name, fallback) {
  const override = process.env[name];

  if (override !== undefined && override.trim() !== "") return path.resolve(override);

  return fallback;
}

/**
 * Check the artifacts that must exist before anything is spawned.
 *
 * @returns {{ electronBin: string, engineBundle: string }}
 */
function requireArtifacts() {
  const electronBin = artifactPath("HARUYUKI_ELECTRON_BIN", DEFAULT_ELECTRON_BIN);
  const engineBundle = artifactPath("HARUYUKI_ENGINE_BUNDLE", DEFAULT_ENGINE_BUNDLE);

  if (!existsSync(electronBin)) {
    process.stderr.write(`the electron binary is missing: ${electronBin}\n`);
    process.stderr.write("run: pnpm --filter @haruyuki/desktop run setup:electron\n");
    process.stderr.write(
      "or set HARUYUKI_ELECTRON_BIN to an Electron binary of the same version\n",
    );
    process.exit(2);
  }

  if (!existsSync(engineBundle)) {
    process.stderr.write(`the engine artifact is missing: ${engineBundle}\n`);
    process.stderr.write("run: node scripts/engine/fetch-engine.mjs\n");
    process.stderr.write("or set HARUYUKI_ENGINE_BUNDLE to an unpacked engine entry\n");
    process.exit(2);
  }

  return { electronBin, engineBundle };
}

/**
 * Build one Vite config.
 *
 * `--config` is resolved from the desktop package directory, so the configs' own
 * `import.meta.dirname`-based output paths are used rather than re-derived here.
 *
 * @param {string} config file name inside `apps/desktop`
 * @param {string} label for the failure message
 */
function build(config, label) {
  if (!existsSync(VITE_BIN)) {
    process.stderr.write(`the build tool is missing: ${VITE_BIN}\n`);
    process.stderr.write("run: pnpm install\n");
    process.exit(2);
  }

  const result = spawnSync(process.execPath, [VITE_BIN, "build", "--config", config], {
    cwd: DESKTOP_DIR,
    encoding: "utf8",
    timeout: BUILD_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
  });

  if (result.error !== undefined) {
    fail(`${label} could not start: ${String(result.error)}`);
  }

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    fail(`${label} failed with exit ${String(result.status)}`);
  }

  process.stdout.write(`INFO build ${label} ok\n`);
}

/**
 * Remove the variables that would change what the child does.
 *
 * `ELECTRON_RUN_AS_NODE` turns the binary into plain Node. `NODE_OPTIONS` is
 * inherited from whatever shell started us and can inject a `--require` the probe
 * did not ask for. Neither is a legitimate part of this test's environment.
 *
 * @param {string} engineBundle the resolved engine entry
 * @param {string} tempRoot the probe's temp root, removed after it exits
 * @returns {Record<string, string>}
 */
function childEnv(engineBundle, tempRoot) {
  /** @type {Record<string, string>} */
  const env = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "ELECTRON_RUN_AS_NODE") continue;
    if (key === "NODE_OPTIONS") continue;
    env[key] = value;
  }

  env["HARUYUKI_ENGINE_BUNDLE"] = engineBundle;
  env["HARUYUKI_RENDERER_ROOT"] = RENDERER_ROOT;
  env["HARUYUKI_PROBE_TEMP"] = tempRoot;
  env["HARUYUKI_PROBE_ROOT"] = REPO_ROOT;

  return env;
}

/**
 * Kill a process and its tree.
 *
 * Only ever called with the PID of the Electron process this script spawned. On
 * Windows `taskkill /T` also reaches the engine child and Chromium's helpers; on
 * POSIX the direct child is enough because the probe never detaches anything.
 *
 * @param {number} pid the process id
 */
function killTree(pid) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * The line shape the probe prints. `INFO` and `SUMMARY` are not judgments.
 *
 * @param {string} line one line of probe stdout
 * @returns {{ status: string, id: string, detail: string } | null}
 */
function parseJudgment(line) {
  const match = /^(PASS|FAIL|SKIP) (V-\d{2}) (.*)$/.exec(line.trim());

  if (match === null) return null;

  return { status: match[1], id: match[2], detail: match[3] };
}

/**
 * Run the Electron-hosted probe and collect its output.
 *
 * @param {string} electronBin the Electron binary
 * @param {string} engineBundle the engine entry
 * @param {string} tempRoot the probe's temp root
 * @param {string[]} electronFlags extra flags forwarded from this script's argv
 * @returns {Promise<{ code: number | null, signal: string | null, judgments: Map<string, { status: string, detail: string }>, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runProbe(electronBin, engineBundle, tempRoot, electronFlags) {
  return new Promise((resolve) => {
    const child = spawn(electronBin, [...electronFlags, PROBE_PATH], {
      cwd: REPO_ROOT,
      env: childEnv(engineBundle, tempRoot),
      // A hidden window still has a real renderer; the probe needs one to crash.
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    /** @type {Map<string, { status: string, detail: string }>} */
    const judgments = new Map();
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let pending = "";

    /**
     * Stream one complete stdout line: print it, and remember judgments.
     *
     * @param {string} line
     */
    function consumeLine(line) {
      if (line.trim() === "") return;

      process.stdout.write(`${line}\n`);

      const judgment = parseJudgment(line);

      if (judgment !== null)
        judgments.set(judgment.id, { status: judgment.status, detail: judgment.detail });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid ?? 0);
      settle();
    }, TIMEOUT_MS);

    /** Finish once, whichever signal arrives first. */
    function settle() {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      if (pending !== "") consumeLine(pending);

      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        judgments,
        stdout,
        stderr,
        timedOut,
      });
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;

      const lines = pending.split(/\r?\n/);

      pending = lines.pop() ?? "";

      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    child.on("error", (error) => {
      stderr += String(error);
      settle();
    });

    child.on("close", () => {
      settle();
    });
  });
}

/**
 * The Windows status a Chromium process aborts with when its parent job object
 * forbids the desktop window station: `0x80000003`, `STATUS_BREAKPOINT`.
 *
 * It is not an Electron failure: the same binary reaches `ready` when it is
 * launched outside that job (measured on this host). A shell tool that puts every
 * command in a restricted job therefore needs one retry from a process the job
 * does not own.
 */
const CHROMIUM_JOB_ABORT = -2147483645;

/**
 * Whether an exit is the job-object abort rather than a probe failure.
 *
 * Node reports Windows exit codes as signed 32-bit or unsigned depending on the
 * path it took, so both spellings are accepted.
 *
 * @param {number | null} code the child's exit code
 * @returns {boolean}
 */
function isChromiumJobAbort(code) {
  if (process.platform !== "win32" || code === null) return false;

  return code === CHROMIUM_JOB_ABORT || code >>> 0 === 0x80000003;
}

/** Quote one value for a single-quoted PowerShell string. */
function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/**
 * Run the probe through a launcher that Windows creates outside this shell's job.
 *
 * `Invoke-CimMethod Win32_Process Create` asks the WMI service to create the
 * process, so the new process tree is not a child of this script's job. A small
 * PowerShell launcher then starts Electron with redirected stdout/stderr and
 * writes the exit code to a file; this function polls for that file and returns
 * the same shape as the direct path.
 *
 * Only used after the direct launch has already produced the Chromium job abort.
 *
 * @param {string} electronBin the Electron binary
 * @param {string} engineBundle the engine entry
 * @param {string} tempRoot the probe's temp root (must exist)
 * @param {string[]} electronFlags extra flags forwarded from this script's argv
 * @returns {Promise<{ code: number | null, signal: string | null, judgments: Map<string, { status: string, detail: string }>, stdout: string, stderr: string, timedOut: boolean }>}
 */
async function runProbeDetached(electronBin, engineBundle, tempRoot, electronFlags) {
  mkdirSync(tempRoot, { recursive: true });

  const stdoutFile = path.join(tempRoot, "detached-stdout.txt");
  const stderrFile = path.join(tempRoot, "detached-stderr.txt");
  const codeFile = path.join(tempRoot, "detached-code.txt");
  const launcher = path.join(tempRoot, "launch-detached.ps1");
  const argumentList = [...electronFlags, PROBE_PATH].map((argument) => `"${argument}"`).join(" ");

  writeFileSync(
    launcher,
    `$ErrorActionPreference = 'Stop'
$env:HARUYUKI_ENGINE_BUNDLE = ${powershellLiteral(engineBundle)}
$env:HARUYUKI_RENDERER_ROOT = ${powershellLiteral(RENDERER_ROOT)}
$env:HARUYUKI_PROBE_TEMP = ${powershellLiteral(tempRoot)}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$p = Start-Process -FilePath ${powershellLiteral(electronBin)} -ArgumentList ${powershellLiteral(argumentList)} -WorkingDirectory ${powershellLiteral(REPO_ROOT)} -RedirectStandardOutput ${powershellLiteral(stdoutFile)} -RedirectStandardError ${powershellLiteral(stderrFile)} -PassThru -Wait
Set-Content -Path ${powershellLiteral(codeFile)} -Value $p.ExitCode
`,
    "utf8",
  );

  const create = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${powershellLiteral(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${launcher}"`,
      )} }; $r.ProcessId`,
    ],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  const wmiPid = Number((create.stdout ?? "").trim().split(/\r?\n/).pop());

  const deadline = Date.now() + TIMEOUT_MS;
  let timedOut = false;

  while (!existsSync(codeFile)) {
    if (Date.now() >= deadline) {
      timedOut = true;

      if (Number.isInteger(wmiPid) && wmiPid > 0) killTree(wmiPid);

      break;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Give the launcher a moment to flush its files after the tree is gone.
  await new Promise((resolve) => setTimeout(resolve, timedOut ? 500 : 0));

  const stdout = existsSync(stdoutFile) ? readFileSync(stdoutFile, "utf8") : "";
  const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "";
  const code = existsSync(codeFile) ? Number(readFileSync(codeFile, "utf8").trim()) : null;
  /** @type {Map<string, { status: string, detail: string }>} */
  const judgments = new Map();

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;

    process.stdout.write(`${line}\n`);

    const judgment = parseJudgment(line);

    if (judgment !== null)
      judgments.set(judgment.id, { status: judgment.status, detail: judgment.detail });
  }

  if (stderr !== "") process.stderr.write(stderr);

  return {
    code: Number.isNaN(code) ? null : code,
    signal: null,
    judgments,
    stdout,
    stderr,
    timedOut,
  };
}

/**
 * Remove the caller-owned temp root, with retries.
 *
 * Chromium releases its session files a moment after the process exits, so a
 * single attempt can lose a race on Windows.
 *
 * @param {string} tempRoot directory to remove
 */
async function removeTempRoot(tempRoot) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  process.stderr.write(`warning: could not remove the probe temp directory: ${tempRoot}\n`);
}

/**
 * The entry point.
 */
async function main() {
  const { electronBin, engineBundle } = requireArtifacts();

  // `--no-sandbox` is forwarded for diagnostic runs; the probe itself never needs
  // it on a normal machine.
  const electronFlags = process.argv.slice(2).filter((argument) => argument.startsWith("--"));

  const skipBuild = process.env["HARUYUKI_SMOKE_NO_BUILD"] === "1";

  if (skipBuild) {
    if (!existsSync(PROBE_PATH)) {
      process.stderr.write(`the probe bundle is missing: ${PROBE_PATH}\n`);
      process.stderr.write("run: pnpm --filter @haruyuki/desktop run build:probe\n");
      process.exit(2);
    }

    if (!existsSync(path.join(RENDERER_ROOT, "index.html"))) {
      process.stderr.write(`the renderer build is missing: ${RENDERER_ROOT}\n`);
      process.stderr.write("run: pnpm --filter @haruyuki/desktop run build:renderer\n");
      process.exit(2);
    }
  } else {
    build("vite.probe.mts", "supervision-probe");
    build("vite.renderer.mts", "renderer");
  }

  if (!existsSync(PROBE_PATH)) {
    fail(`the probe bundle was not produced: ${PROBE_PATH}`);
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "haruyuki-supervision-smoke-"));
  // Diagnostic switch: forces the job-object fallback so that path can be tested
  // on a host whose shell does not need it.
  const forceDetached = process.env["HARUYUKI_SMOKE_DETACHED"] === "1";
  let result;

  try {
    result = forceDetached
      ? await runProbeDetached(
          electronBin,
          engineBundle,
          path.join(tempRoot, "detached"),
          electronFlags,
        )
      : await runProbe(electronBin, engineBundle, path.join(tempRoot, "direct"), electronFlags);

    // The direct launch is the normal path. Some service shells put their children
    // in a job object that Chromium cannot start inside; that shows up as the
    // STATUS_BREAKPOINT exit with no output at all, never as a probe judgment.
    if (!forceDetached && result.judgments.size === 0 && isChromiumJobAbort(result.code)) {
      process.stdout.write(
        `INFO launch=direct blocked by the shell's job object (exit ${String(result.code)}); ` +
          "retrying outside it\n",
      );

      result = await runProbeDetached(
        electronBin,
        engineBundle,
        path.join(tempRoot, "detached"),
        electronFlags,
      );
    }
  } finally {
    await removeTempRoot(tempRoot);
  }

  if (result.timedOut) {
    fail(
      `the probe did not finish within ${TIMEOUT_MS} ms. If it produced no output at all, ` +
        "check that ELECTRON_RUN_AS_NODE is not set.",
    );
  }

  if (result.judgments.size === 0) {
    fail(
      `the probe produced no PASS/FAIL/SKIP line (exit ${String(result.code)}). ` +
        "Read its stderr above; a load-time crash is a build problem, not a timeout.",
    );
  }

  const failures = [];

  for (const id of REQUIRED_IDS) {
    const judgment = result.judgments.get(id);

    if (judgment === undefined) {
      failures.push(`${id}: no judgment (the probe stopped before it)`);
      continue;
    }

    if (judgment.status !== "PASS") failures.push(`${id}: ${judgment.status} ${judgment.detail}`);
  }

  if (failures.length > 0) {
    process.stdout.write("\nsupervision-smoke: failed\n");

    for (const failure of failures) process.stdout.write(`  ${failure}\n`);

    process.exit(1);
  }

  if (result.code !== 0) {
    fail(
      `all ${String(REQUIRED_IDS.length)} judgments passed but the probe exited ${String(result.code)}`,
    );
  }

  process.stdout.write(
    `\nsupervision-smoke: ${String(REQUIRED_IDS.length)} of ${String(REQUIRED_IDS.length)} assertions passed\n`,
  );
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
