/**
 * Process evidence collection for a PID recorded by an earlier shell run.
 *
 * Evidence source: docs/33-D4 section 3.3 (measured commands and timings) and
 * section 4.4 (field semantics). The goal is to answer "is this PID still the
 * engine that marker describes?" without ever relying on the PID alone.
 *
 * This file owns the public contract and the decision wiring. The measured
 * platform commands and their parsers live in `identity.ts`: the Windows
 * wmic/PowerShell fallback and the POSIX `/proc`/`ps` paths are a separate
 * concern, and the split keeps both files below the repository file-size limit.
 *
 * Every command has a hard timeout so a wedged PowerShell cannot block start-up.
 * Commands are executed directly (never through a shell): the PID is numeric by
 * construction and no argument is user-controlled text.
 *
 * `portListening` is always `false`: B1 exposes no engine port, so D4 writes
 * `port: null` and does not scan ports (RD-07). It is not part of the decision.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";

import {
  collectPlatformIdentity,
  EMPTY_IDENTITY,
  type EvidenceCommandRunner,
  type ProcessIdentity,
} from "./identity";
import { evaluateReclaim, isProcessAlive } from "./reclaim";
import type { EngineMarker, ProcessEvidence } from "./types";

export type { EvidenceCommandRunner } from "./identity";

/** Per-command ceiling; measured Windows commands need well under this. */
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;

/** A process table row is tiny; the cap only protects against a broken command. */
const MAX_COMMAND_OUTPUT_BYTES = 1 * 1024 * 1024;

/**
 * Optional dependency overrides.
 *
 * Production callers pass nothing. Tests use `runCommand` and `platform` to
 * exercise the Windows parse and fallback branches on a host without `wmic`
 * (including POSIX CI), and `toleranceMs` to place a marker at a known distance
 * from the evidence.
 */
export type CollectEvidenceOptions = {
  readonly timeoutMs?: number;
  readonly toleranceMs?: number;
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: EvidenceCommandRunner;
};

/**
 * Collect everything the OS will say about `marker.pid`, then grade it.
 *
 * Never rejects for a missing process: absence is reported as `alive: false`,
 * which `decideReclaim` classifies as `gone`. `matched` and `reason` are filled
 * from the same pure evaluation, so evidence and decision cannot disagree.
 */
export async function collectEvidence(
  marker: EngineMarker,
  options: CollectEvidenceOptions = {},
): Promise<ProcessEvidence> {
  const pid = marker.pid;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  const run = options.runCommand ?? runCommand;

  const alive = isProcessAlive(pid);
  const tokenFileExists = await tokenFileExistsFor(marker.tokenFile);

  let identity: ProcessIdentity = EMPTY_IDENTITY;
  if (alive && Number.isInteger(pid) && pid > 0) {
    identity = await collectPlatformIdentity(pid, platform, run, timeoutMs);
  }

  return finalizeEvidence(marker, {
    alive,
    imagePath: identity.imagePath,
    createdAt: identity.createdAt,
    tokenFileExists,
    toleranceMs: options.toleranceMs,
  });
}

/**
 * Build the public evidence object and derive `matched` / `reason` from the
 * decision. Keeping this in one place is why a caller can trust that
 * `matched === (decideReclaim(...) === "confident")` for every record.
 */
function finalizeEvidence(
  marker: EngineMarker,
  facts: {
    alive: boolean;
    imagePath: string | null;
    createdAt: string | null;
    tokenFileExists: boolean;
    toleranceMs: number | undefined;
  },
): ProcessEvidence {
  const evidence: ProcessEvidence = {
    pid: marker.pid,
    alive: facts.alive,
    imagePath: facts.imagePath,
    createdAt: facts.createdAt,
    // Correlation only: there is no way to read a foreign process's token, and
    // `runToken` is never evidence on its own.
    runToken: marker.runToken,
    tokenFileExists: facts.tokenFileExists,
    portListening: false,
    matched: false,
    reason: "",
  };

  const evaluation = evaluateReclaim(marker, evidence, facts.toleranceMs);
  evidence.matched = evaluation.decision === "confident";
  evidence.reason = evaluation.reason;

  return evidence;
}

/** Check the token file with `access`; a missing or unreadable file is `false`. */
async function tokenFileExistsFor(tokenFile: string | null): Promise<boolean> {
  if (tokenFile === null) {
    return false;
  }

  try {
    await access(tokenFile);
    return true;
  } catch {
    return false;
  }
}

/** Default runner: no shell, a hard timeout, and a bounded output buffer. */
function runCommand(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      },
      (error, stdout) => {
        if (error !== null) {
          rejectPromise(error);
          return;
        }

        resolvePromise(stdout);
      },
    );
  });
}
