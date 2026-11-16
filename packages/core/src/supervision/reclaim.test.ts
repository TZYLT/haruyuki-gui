/**
 * Tests for the reclaim decision and the bounded kill.
 *
 * The truth table is the contract: a live PID alone is never confident, one
 * identity fact needs the token file as a second fact, and both identity facts
 * must agree. `portListening` is asserted to be irrelevant because D4 cannot
 * observe the port (RD-07).
 *
 * The kill cases use a real `node -e` child spawned by this test and its
 * recorded PID; no existing process is ever targeted.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
  decideReclaim,
  DEFAULT_TIME_TOLERANCE_MS,
  isProcessAlive,
  killStaleEngine,
} from "./reclaim";
import type { EngineMarker, ProcessEvidence, ReclaimDecision } from "./types";

const STARTED_AT = "2026-11-16T12:00:00.000Z";
const MATCHING_CREATED_AT = new Date(Date.parse(STARTED_AT) + 5_000).toISOString();
const EDGE_CREATED_AT = new Date(Date.parse(STARTED_AT) + DEFAULT_TIME_TOLERANCE_MS).toISOString();
const OUTSIDE_CREATED_AT = new Date(
  Date.parse(STARTED_AT) + DEFAULT_TIME_TOLERANCE_MS + 1,
).toISOString();

const EXE = process.platform === "win32" ? "C:\\Program Files\\nodejs\\node.exe" : "/usr/bin/node";
const OTHER_EXE = process.platform === "win32" ? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";

const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      continue;
    }

    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited.catch(() => undefined);
  }
});

function engineMarker(overrides: Partial<EngineMarker> = {}): EngineMarker {
  return {
    pid: 4242,
    startedAt: STARTED_AT,
    exePath: EXE,
    bundlePath: "/app/haruyuki.js",
    runToken: "run-token-1",
    watchdog: "active",
    tokenFile: "/app/engine-token",
    port: null,
    ...overrides,
  };
}

function processEvidence(overrides: Partial<ProcessEvidence> = {}): ProcessEvidence {
  return {
    pid: 4242,
    alive: true,
    imagePath: EXE,
    createdAt: MATCHING_CREATED_AT,
    runToken: "run-token-1",
    tokenFileExists: false,
    portListening: false,
    matched: false,
    reason: "",
    ...overrides,
  };
}

async function startFakeChild(detached = false): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
    windowsHide: true,
    detached,
  });
  children.push(child);
  await once(child, "spawn");
  return child;
}

function childPid(child: ChildProcess): number {
  if (child.pid === undefined) {
    throw new Error("the fake engine child was not spawned");
  }

  return child.pid;
}

describe("decideReclaim truth table", () => {
  const cases: ReadonlyArray<{
    name: string;
    evidence: ProcessEvidence;
    marker?: EngineMarker;
    expected: ReclaimDecision;
  }> = [
    {
      name: "a dead PID is gone",
      evidence: processEvidence({ alive: false }),
      expected: "gone",
    },
    {
      name: "a dead PID stays gone even when its identity would match",
      evidence: processEvidence({ alive: false, tokenFileExists: true }),
      expected: "gone",
    },
    {
      name: "both identity facts matching is confident",
      evidence: processEvidence(),
      expected: "confident",
    },
    {
      name: "both identity facts at the tolerance edge are confident",
      evidence: processEvidence({ createdAt: EDGE_CREATED_AT }),
      expected: "confident",
    },
    {
      name: "a creation time outside the tolerance is ambiguous",
      evidence: processEvidence({ createdAt: OUTSIDE_CREATED_AT }),
      expected: "ambiguous",
    },
    {
      name: "a different image path is ambiguous",
      evidence: processEvidence({ imagePath: OTHER_EXE }),
      expected: "ambiguous",
    },
    {
      name: "both facts disagreeing is ambiguous",
      evidence: processEvidence({ createdAt: OUTSIDE_CREATED_AT, imagePath: OTHER_EXE }),
      expected: "ambiguous",
    },
    {
      name: "creation time plus a token file is confident",
      evidence: processEvidence({ imagePath: null, tokenFileExists: true }),
      expected: "confident",
    },
    {
      name: "creation time without a token file is ambiguous",
      evidence: processEvidence({ imagePath: null, tokenFileExists: false }),
      expected: "ambiguous",
    },
    {
      name: "a matching creation time outside the tolerance stays ambiguous",
      evidence: processEvidence({
        imagePath: null,
        createdAt: OUTSIDE_CREATED_AT,
        tokenFileExists: true,
      }),
      expected: "ambiguous",
    },
    {
      name: "image path plus a token file is confident",
      evidence: processEvidence({ createdAt: null, tokenFileExists: true }),
      expected: "confident",
    },
    {
      name: "image path without a token file is ambiguous",
      evidence: processEvidence({ createdAt: null, tokenFileExists: false }),
      expected: "ambiguous",
    },
    {
      name: "a different image path plus a token file is ambiguous",
      evidence: processEvidence({
        createdAt: null,
        imagePath: OTHER_EXE,
        tokenFileExists: true,
      }),
      expected: "ambiguous",
    },
    {
      name: "only the PID plus a token file is ambiguous",
      evidence: processEvidence({
        imagePath: null,
        createdAt: null,
        tokenFileExists: true,
      }),
      expected: "ambiguous",
    },
    {
      name: "only the PID with a listening port is ambiguous",
      evidence: processEvidence({
        imagePath: null,
        createdAt: null,
        tokenFileExists: true,
        portListening: true,
      }),
      expected: "ambiguous",
    },
    {
      name: "an unparseable creation time cannot be confident",
      evidence: processEvidence({ createdAt: "not-a-date" }),
      expected: "ambiguous",
    },
    {
      name: "an unparseable marker time cannot be confident",
      evidence: processEvidence({ createdAt: MATCHING_CREATED_AT }),
      marker: engineMarker({ startedAt: "not-a-date" }),
      expected: "ambiguous",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(decideReclaim(testCase.marker ?? engineMarker(), testCase.evidence)).toBe(
        testCase.expected,
      );
    });
  }

  it("honours a caller-supplied tolerance", () => {
    const evidence = processEvidence({ createdAt: MATCHING_CREATED_AT });

    expect(decideReclaim(engineMarker(), evidence, 1_000)).toBe("ambiguous");
    expect(decideReclaim(engineMarker(), evidence, DEFAULT_TIME_TOLERANCE_MS)).toBe("confident");
  });

  it("ignores the stored matched flag and the human reason", () => {
    const evidence = processEvidence({
      imagePath: null,
      createdAt: null,
      matched: true,
      reason: "createdAt and imagePath both match",
    });

    expect(decideReclaim(engineMarker(), evidence)).toBe("ambiguous");
  });

  it.runIf(process.platform === "win32")(
    "treats Windows separators and case as the same image",
    () => {
      const marker = engineMarker({ exePath: "C:\\Program Files\\NodeJS\\node.exe" });
      const evidence = processEvidence({ imagePath: "c:/program files/nodejs/node.exe" });

      expect(decideReclaim(marker, evidence)).toBe("confident");
    },
  );

  it.runIf(process.platform !== "win32")("requires exact paths on POSIX", () => {
    const evidence = processEvidence({ imagePath: EXE.toUpperCase() });
    const expected = EXE.toUpperCase() === EXE ? "confident" : "ambiguous";

    expect(decideReclaim(engineMarker(), evidence)).toBe(expected);
  });
});

describe("killStaleEngine", () => {
  it("rejects a malformed PID without running a command", async () => {
    expect(await killStaleEngine(engineMarker({ pid: 0 }))).toEqual({
      ok: false,
      reason: "invalid pid",
    });
  });

  it("kills a fake engine child and reports success", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);

    const result = await killStaleEngine(engineMarker({ pid }));

    expect(result).toEqual({ ok: true });
    expect(isProcessAlive(pid)).toBe(false);
  });

  it("treats an already-gone process as success", async () => {
    const child = await startFakeChild();
    const pid = childPid(child);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;

    expect(await killStaleEngine(engineMarker({ pid }))).toEqual({ ok: true });
  });

  it.runIf(process.platform !== "win32")(
    "kills a detached child through its process group",
    async () => {
      const child = await startFakeChild(true);
      const pid = childPid(child);

      const result = await killStaleEngine(engineMarker({ pid }));

      expect(result).toEqual({ ok: true });
      expect(isProcessAlive(pid)).toBe(false);
    },
  );
});
