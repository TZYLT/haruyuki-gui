/**
 * Reclaim and the two directions it can point: process evidence and the
 * two-condition decision.
 *
 * A reclamation needs a real leak: a child that outlives the process which wrote
 * its marker, reclaimed by the shell's own boot scan. The opposite case is a live
 * PID whose identity does not match the marker, which must be listed as
 * `ambiguous` and must never be signalled.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  TOKEN_FILE_NAME,
  collectEvidence as collectProcessEvidence,
  decideReclaim,
  isProcessAlive,
  readRuntimeMarker,
  writeRuntimeMarker,
  type EngineMarker,
  type ProcessEvidence,
  type ReclaimDecision,
  type RuntimeMarker,
} from "@haruyuki/core";

import { PROBE_APP_VERSION, TEMP_ROOT } from "../environment.js";
import {
  childPid,
  killOwned,
  spawnIdleNode,
  spawnNode,
  untrack,
  waitFor,
  waitForFile,
  waitUntilTasklistGone,
} from "../processes.js";
import { logged, logSink, record } from "../report.js";
import { runBootSupervision } from "../../../src/main/supervision/boot.js";
import type { StaleCandidate } from "../../../src/main/supervision/boot.js";
import { showStaleCleanupDialog } from "../../../src/main/supervision/stale-cleanup.js";

// ---------------------------------------------------------------------------
// A leaked child is reclaimed at boot on two-condition evidence
// ---------------------------------------------------------------------------

/** What the leak helper reports once the leaked child and marker are in place. */
interface LeakReady {
  readonly childPid: number;
  readonly helperPid: number;
}

/**
 * Spawn a real child, let its parent die, then boot-reclaim it.
 *
 * The helper is a real Node process: it spawns a long-lived child, writes the
 * runtime marker exactly as a shell would, then waits to be killed. Killing it
 * leaves the child orphaned -- the leak. `runBootSupervision` then has to prove
 * the child is the engine from the marker using the OS creation time and image
 * path, kill the tree, remove our token file, and rewrite the marker.
 */
async function checkV01(): Promise<void> {
  const id = "leaked-child-reclaimed";
  const userData = path.join(TEMP_ROOT, "v01");
  const tokenDir = path.join(userData, "engine-token");
  const tokenFile = path.join(tokenDir, TOKEN_FILE_NAME);
  const readyFile = path.join(userData, "leak-ready.json");
  const instanceId = "probe-v01-instance";
  const runToken = "probe-v01-run-token";
  const helperPath = path.join(userData, "leak-host.cjs");
  let leakedPid: number | null = null;
  let helper: ChildProcess | null = null;

  try {
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(tokenFile, "probe-token-value\n", "utf8");

    // The helper writes the marker itself, before it reports ready, so the file
    // is on disk before the helper is killed -- which is what a crashed shell
    // leaves behind.
    writeFileSync(
      helperPath,
      `"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const userData = process.env.HP_USER_DATA;
const readyPath = process.env.HP_READY;
const tokenFile = process.env.HP_TOKEN_FILE;
const instanceId = process.env.HP_INSTANCE;
const runToken = process.env.HP_RUN_TOKEN;

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  // Detached on purpose: this child is the leak, so it must outlive the process
  // that spawned it. A non-detached grandchild on Windows dies with its parent
  // here, which would make the reclaim check pass against no leak at all.
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  env: process.env,
});
child.unref();

const startedAt = new Date().toISOString();
const marker = {
  schemaVersion: 1,
  instanceId,
  startedAt,
  appVersion: "0.1.0-supervision-probe",
  engine: {
    pid: child.pid,
    startedAt,
    exePath: process.execPath,
    bundlePath: "probe-leaked-engine",
    runToken,
    watchdog: "unknown",
    tokenFile,
    port: null,
  },
};

fs.writeFileSync(path.join(userData, "runtime.json"), JSON.stringify(marker, null, 2));
fs.writeFileSync(readyPath, JSON.stringify({ childPid: child.pid, helperPid: process.pid }));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    helper = spawnNode(helperPath, {
      HP_USER_DATA: userData,
      HP_READY: readyFile,
      HP_TOKEN_FILE: tokenFile,
      HP_INSTANCE: instanceId,
      HP_RUN_TOKEN: runToken,
    });

    const helperPid = await childPid(helper);

    if (helperPid === null) throw new Error("the leak helper never reported a pid");

    if (!(await waitForFile(readyFile, 10_000))) {
      throw new Error("the leak helper wrote no ready file within 10 s");
    }

    const ready = JSON.parse(readFileSync(readyFile, "utf8")) as LeakReady;
    const pid = ready.childPid;

    leakedPid = pid;

    // Kill the process that spawned and recorded the child -- the crashed-shell
    // simulation. The child must survive it; that is the leak this check needs.
    process.kill(ready.helperPid, "SIGKILL");
    await waitFor(() => (isProcessAlive(ready.helperPid) ? null : true), 5_000, 50);
    untrack(ready.helperPid);

    if (!isProcessAlive(pid)) {
      throw new Error(
        `the leaked child ${String(pid)} died with its parent, so no leak was simulated`,
      );
    }

    // Independent, pre-boot evidence: this is what makes the decision
    // "confident" rather than "ambiguous", so it is measured and printed.
    const read = await readRuntimeMarker(userData);

    if (!read.ok) throw new Error(`the helper's marker is not readable: ${read.reason}`);

    const engineMarker = read.marker.engine;

    if (engineMarker === null) throw new Error("the helper's marker names no engine");

    const evidence = await collectProcessEvidence(engineMarker);
    const decision = decideReclaim(engineMarker, evidence);
    const startedAt = Date.now();
    const boot = await runBootSupervision({
      userData,
      appVersion: PROBE_APP_VERSION,
      onLog: logSink,
    });
    const reclaimMs = Date.now() - startedAt;

    // Two observers: Node's existence check and the OS process list.
    const nodeGone = await waitFor(() => (isProcessAlive(pid) ? null : true), 5_000, 50);
    const tasklist = await waitUntilTasklistGone(pid, 5_000);

    const after = await readRuntimeMarker(userData);
    const tokenExists = existsSync(tokenFile);
    const stale = readdirSync(userData).filter((name) => name.startsWith("runtime-stale-"));
    const problems: string[] = [];

    if (decision !== "confident") problems.push(`decision=${decision}`);
    if (evidence.createdAt === null) problems.push("no OS creation time");
    if (evidence.imagePath === null) problems.push("no OS image path");
    if (boot.reclaimed.length !== 1) problems.push(`reclaimed=${String(boot.reclaimed.length)}`);
    if (boot.stale.length !== 0) problems.push(`stale=${String(boot.stale.length)}`);
    if (nodeGone === null) problems.push("the child was still alive after boot");
    if (tasklist !== false) problems.push(`tasklist says alive=${String(tasklist)}`);
    if (tokenExists) problems.push("the token file survived a confident reclaim");
    if (stale.length !== 0) problems.push(`stale markers left: ${stale.join(",")}`);
    if (!logged("supervision.reclaim.killed")) problems.push("no supervision.reclaim.killed log");

    if (!after.ok) {
      problems.push("the marker was not rewritten");
    } else if (after.marker.engine !== null) {
      problems.push("the rewritten marker still names an engine");
    } else if (after.marker.instanceId === instanceId) {
      problems.push("the rewritten marker kept the old instance id");
    }

    if (problems.length > 0) {
      record(id, "FAIL", problems.join("; "));
      return;
    }

    record(
      id,
      "PASS",
      `pid=${String(pid)} evidence=createdAt+imagePath decision=confident reclaimed=1 in ` +
        `${String(reclaimMs)}ms nodeKill=gone tasklist=gone token=removed marker=engine:null`,
    );
  } finally {
    helper?.kill("SIGKILL");

    if (leakedPid !== null && isProcessAlive(leakedPid)) killOwned(leakedPid);
  }
}

// ---------------------------------------------------------------------------
// The two-condition decision, and an ambiguous PID that must not be killed
// ---------------------------------------------------------------------------

/** The marker the pure decision table is evaluated against. */
function decisionMarker(): EngineMarker {
  return {
    pid: 4242,
    startedAt: "2026-01-01T00:00:00.000Z",
    exePath: path.join("C:", "Apps", "electron.exe"),
    bundlePath: "bundle.js",
    runToken: "decision-run-token",
    watchdog: "unknown",
    tokenFile: null,
    port: null,
  };
}

/** Build one evidence row with explicit facts. */
function decisionEvidence(overrides: Partial<ProcessEvidence>): ProcessEvidence {
  return {
    pid: 4242,
    alive: true,
    imagePath: null,
    createdAt: null,
    runToken: "decision-run-token",
    tokenFileExists: false,
    portListening: false,
    matched: false,
    reason: "",
    ...overrides,
  };
}

/**
 * The pure truth table, then a real live process whose marker does not
 * match. The live process proves the decision is wired to "do not kill"; the
 * table proves the rule itself.
 */
async function checkV04(): Promise<void> {
  const id = "ambiguous-pid-not-killed";
  const marker = decisionMarker();
  const samePath = marker.exePath;
  const sameTime = "2026-01-01T00:00:30.000Z";
  const otherTime = "2026-01-01T04:00:00.000Z";
  const otherPath = path.join("C:", "Windows", "System32", "notepad.exe");

  const cases: { name: string; evidence: ProcessEvidence; expected: ReclaimDecision }[] = [
    { name: "gone", evidence: decisionEvidence({ alive: false }), expected: "gone" },
    { name: "pid-only", evidence: decisionEvidence({}), expected: "ambiguous" },
    {
      name: "time+token-missing",
      evidence: decisionEvidence({ createdAt: sameTime }),
      expected: "ambiguous",
    },
    {
      name: "time+token",
      evidence: decisionEvidence({ createdAt: sameTime, tokenFileExists: true }),
      expected: "confident",
    },
    {
      name: "image+token-missing",
      evidence: decisionEvidence({ imagePath: samePath }),
      expected: "ambiguous",
    },
    {
      name: "image+token",
      evidence: decisionEvidence({ imagePath: samePath, tokenFileExists: true }),
      expected: "confident",
    },
    {
      name: "time+image-both-match",
      evidence: decisionEvidence({ createdAt: sameTime, imagePath: samePath }),
      expected: "confident",
    },
    {
      name: "time-mismatch",
      evidence: decisionEvidence({ createdAt: otherTime, imagePath: samePath }),
      expected: "ambiguous",
    },
    {
      name: "image-mismatch",
      evidence: decisionEvidence({ createdAt: sameTime, imagePath: otherPath }),
      expected: "ambiguous",
    },
    {
      name: "both-mismatch",
      evidence: decisionEvidence({ createdAt: otherTime, imagePath: otherPath }),
      expected: "ambiguous",
    },
  ];
  const wrong = cases
    .filter((testCase) => decideReclaim(marker, testCase.evidence) !== testCase.expected)
    .map((testCase) => testCase.name);

  // The real half: a live child this probe spawned, but a marker describing a
  // different executable and a different time. A genuine PID with a genuine
  // (wrong) identity is exactly the PID-reuse shape.
  const userData = path.join(TEMP_ROOT, "v04");
  mkdirSync(userData, { recursive: true });

  const child = spawnIdleNode();
  const livePid = await childPid(child);

  if (livePid === null) {
    record(
      id,
      "FAIL",
      `pure table wrong: ${wrong.join(",") || "none"}; the live child never spawned`,
    );
    return;
  }

  try {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const staleMarker: RuntimeMarker = {
      schemaVersion: 1,
      instanceId: "probe-v04-instance",
      startedAt: twoHoursAgo,
      appVersion: PROBE_APP_VERSION,
      engine: {
        pid: livePid,
        startedAt: twoHoursAgo,
        exePath: process.platform === "win32" ? otherPath : "/usr/bin/not-a-real-engine",
        bundlePath: "probe-ambiguous",
        runToken: "probe-v04-token",
        watchdog: "unknown",
        tokenFile: null,
        port: null,
      },
    };

    await writeRuntimeMarker(userData, staleMarker);

    const boot = await runBootSupervision({
      userData,
      appVersion: PROBE_APP_VERSION,
      onLog: logSink,
    });
    const aliveAfter = isProcessAlive(livePid);
    const staleFiles = readdirSync(userData).filter((name) => name.startsWith("runtime-stale-"));
    const after = await readRuntimeMarker(userData);
    const decision = boot.stale[0]?.decision;

    if (wrong.length > 0) {
      record(id, "FAIL", `pure decisions wrong: ${wrong.join(",")}`);
      return;
    }

    if (boot.reclaimed.length !== 0 || decision !== "ambiguous") {
      record(
        id,
        "FAIL",
        `a mismatched PID was treated as ${String(decision)}; reclaimed=${String(boot.reclaimed.length)}`,
      );
      return;
    }

    if (!aliveAfter) {
      record(id, "FAIL", "the ambiguous process was killed");
      return;
    }

    if (staleFiles.length !== 1) {
      record(id, "FAIL", `expected one stale marker, found ${String(staleFiles.length)}`);
      return;
    }

    if (!after.ok || after.marker.engine !== null) {
      record(id, "FAIL", "the fresh marker does not replace the ambiguous one");
      return;
    }

    record(
      id,
      "PASS",
      `table=10/10 pid=${String(livePid)} decision=ambiguous kept=alive reclaimed=0 staleMarkers=1`,
    );
  } finally {
    if (isProcessAlive(livePid)) killOwned(livePid);
    untrack(livePid);
  }
}

/**
 * Another shell's live marker plus an unrelated live PID must not be killed, and
 * the manual dialog must show that evidence, cancel without a kill, and only kill
 * after the explicit confirm.
 *
 * The marker deliberately names a different image and a younger start time, so
 * the double-condition decision is `ambiguous`; that is the honest "another
 * shell may own this PID" shape.
 */
async function checkV05V06(): Promise<void> {
  const userData = path.join(TEMP_ROOT, "v06");
  const child = spawnIdleNode();
  const livePid = await childPid(child);

  if (livePid === null) {
    record("foreign-shell-pid-kept", "FAIL", "the live child never spawned");
    record("manual-cleanup-dialog", "FAIL", "no candidate to show in the dialog");
    return;
  }

  try {
    mkdirSync(userData, { recursive: true });

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const otherShell: RuntimeMarker = {
      schemaVersion: 1,
      instanceId: "probe-v06-other-shell",
      startedAt: twoHoursAgo,
      appVersion: PROBE_APP_VERSION,
      engine: {
        pid: livePid,
        startedAt: twoHoursAgo,
        exePath: path.join("C:", "Windows", "System32", "notepad.exe"),
        bundlePath: "another-shell-engine",
        runToken: "probe-v06-other-shell-token",
        watchdog: "unknown",
        tokenFile: null,
        port: null,
      },
    };

    await writeRuntimeMarker(userData, otherShell);

    const boot = await runBootSupervision({
      userData,
      appVersion: PROBE_APP_VERSION,
      onLog: logSink,
    });
    const candidate = boot.stale[0];
    const aliveAfter = isProcessAlive(livePid);
    const sixProblems: string[] = [];

    if (boot.reclaimed.length !== 0) sixProblems.push(`reclaimed=${String(boot.reclaimed.length)}`);
    if (candidate === undefined || candidate.decision !== "ambiguous") {
      sixProblems.push(`decision=${String(candidate?.decision)}`);
    }
    if (!aliveAfter) sixProblems.push("the other shell's live PID was killed");

    if (sixProblems.length > 0) {
      record("foreign-shell-pid-kept", "FAIL", sixProblems.join("; "));
    } else {
      record(
        "foreign-shell-pid-kept",
        "PASS",
        `pid=${String(livePid)} decision=ambiguous reclaimed=0 kept=alive marker=other-shell`,
      );
    }

    const shown: StaleCandidate = candidate ?? {
      pid: 4242,
      evidence: decisionEvidence({
        pid: 4242,
        imagePath: path.join("C:", "Apps", "engine.exe"),
        createdAt: twoHoursAgo,
        reason: "image and time do not match",
      }),
      decision: "ambiguous",
      reason: "image and time do not match",
    };
    const labels = {
      title: "Leftover engine processes",
      message: (count: number, details: string): string =>
        `${String(count)} engine process(es) from an earlier run:\n\n${details}`,
      confirm: "End Processes",
      cancel: "Cancel",
    };
    let captured: { readonly message: string; readonly buttons: readonly string[] } | null = null;
    let killed = 0;

    const cancelled = await showStaleCleanupDialog([shown], {
      labels,
      showMessageBox: async (options) => {
        captured = { message: options.message, buttons: options.buttons };

        return { response: 1 };
      },
      kill: async () => {
        killed += 1;
      },
      isAlive: () => true,
      settle: async () => undefined,
    });
    const confirmed = await showStaleCleanupDialog([shown], {
      labels,
      showMessageBox: async (options) => {
        captured = { message: options.message, buttons: options.buttons };

        return { response: 0 };
      },
      kill: async () => {
        killed += 1;
      },
      isAlive: () => false,
      settle: async () => undefined,
    });
    const fiveProblems: string[] = [];

    if (captured === null) {
      fiveProblems.push("the dialog was never shown");
    } else {
      if (!captured.message.includes(`PID ${String(shown.pid)}`)) {
        fiveProblems.push("the message has no PID");
      }
      if (!captured.message.includes("image")) fiveProblems.push("the message has no image");
      if (!captured.message.includes("started")) fiveProblems.push("the message has no start time");
      if (!captured.message.includes(shown.reason)) fiveProblems.push("the message has no reason");
      if (!captured.buttons.includes("End Processes") || !captured.buttons.includes("Cancel")) {
        fiveProblems.push("the confirm/cancel buttons are missing");
      }
    }

    if (killed !== 1) fiveProblems.push(`kills=${String(killed)} (expected only the confirm)`);
    if (cancelled.removed.length !== 0) fiveProblems.push("cancel removed a process");
    if (confirmed.removed.length !== 1 || confirmed.removed[0] !== shown.pid) {
      fiveProblems.push("confirm did not remove the shown pid");
    }

    if (fiveProblems.length > 0) {
      record("manual-cleanup-dialog", "FAIL", fiveProblems.join("; "));
    } else {
      record(
        "manual-cleanup-dialog",
        "PASS",
        `pid=${String(shown.pid)} evidence=pid+image+started+reason cancel=no-kill confirm=removed`,
      );
    }
  } finally {
    if (isProcessAlive(livePid)) killOwned(livePid);
    untrack(livePid);
  }
}

export { checkV01, checkV04, checkV05V06 };
