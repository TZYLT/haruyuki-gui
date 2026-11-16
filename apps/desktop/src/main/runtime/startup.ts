/**
 * Startup verification: choose a bundle, check the lock, and report a plan the
 * composition root can hand to the existing engine lifecycle.
 *
 * This module deliberately does not start or stop the engine. D4's
 * `EngineHost` owns process lifetime and the crash callback; duplicating that
 * here would create a second start/stop point and a second marker writer. The
 * plan only answers "which bundle and watchdog should D4 start, and if not,
 * what should the window show".
 *
 * The full-tree check is gated on the app version, not run on every launch:
 * measured ~15 s; the window opens first and the engine waits for the check. A
 * normal start hashes only the entry (~23 ms).
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  readRuntimeLock,
  verifyRuntime,
  type RuntimeLockV1,
  type RuntimeVerifyResult,
} from "./lock.js";
import type { RuntimeLayout } from "./layout.js";
import { selectBundle, type InvalidExternal } from "./selection.js";
import { readRuntimeState, writeRuntimeState, type RuntimeStateV1 } from "./state.js";
import type { RuntimeFailure } from "../../shared/runtime.js";

/** The plan handed to the composition root. */
export type RuntimePlan =
  | {
      readonly ok: true;
      readonly source: "bundled" | "external" | "path";
      readonly bundlePath: string;
      readonly watchdogPath: string;
      readonly engineVersion?: string;
      readonly externalInvalid?: InvalidExternal;
      readonly state: RuntimeStateV1;
      readonly treeChecked: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: RuntimeFailure;
      readonly externalInvalid?: InvalidExternal;
      readonly state: RuntimeStateV1;
      readonly treeChecked: false;
    };

/** What startup needs that only the shell can provide. */
export interface PrepareRuntimeOptions {
  readonly layout: RuntimeLayout;
  readonly appVersion: string;
  readonly now?: () => string;
  /** Dev keeps the pre-G1 behaviour: no lock, no full-tree gate. */
  readonly mode?: "dev" | "packaged";
}

/**
 * Decide whether the engine may start.
 *
 * Packaged: select, verify the bundled entry, and run the tree check only when
 * the app version changed (or the state was missing/corrupt). External and PATH
 * bundles are version-read but not checksummed -- they have no lock; that is the
 * signed Q49 behaviour.
 *
 * @param options layout, app version and log directory
 * @returns a start plan or a failure the page can explain
 */
export async function prepareRuntime(options: PrepareRuntimeOptions): Promise<RuntimePlan> {
  const mode = options.mode ?? options.layout.mode;
  const stateRead = await readRuntimeState(options.layout.statePath);
  const externalDir = stateRead.state.externalEngineDir;

  if (mode === "dev") {
    return await prepareDev(options, stateRead.state);
  }

  const selection = await selectBundle({
    bundledDir: options.layout.engineDir,
    ...(externalDir === undefined ? {} : { externalDir }),
  });

  if (selection.kind === "missing") {
    const failure: RuntimeFailure = {
      kind: "missing",
      detail: selection.reason,
      enginePath: options.layout.engineDir,
      logPath: options.layout.logsDir,
      ...(selection.externalInvalid === undefined
        ? {}
        : { externalInvalid: selection.externalInvalid }),
    };
    const state = await recordFailure(options, stateRead.state, "missing");

    return {
      ok: false,
      failure,
      ...(selection.externalInvalid === undefined
        ? {}
        : { externalInvalid: selection.externalInvalid }),
      state,
      treeChecked: false,
    };
  }

  const location = selection.location;

  if (location.source !== "external" && location.source !== "path") {
    const lock = await readRuntimeLock(options.layout.lockPath);

    if (!lock.ok) {
      const failure: RuntimeFailure = {
        kind: "mismatch",
        detail:
          lock.problem === "missing"
            ? "The bundled engine lock is missing from app.asar."
            : `The bundled engine lock is invalid: ${lock.detail}`,
        enginePath: location.engineDir,
        logPath: options.layout.logsDir,
      };
      const state = await recordFailure(options, stateRead.state, "missing");

      return { ok: false, failure, state, treeChecked: false };
    }

    const full = stateRead.recovered || stateRead.state.lastAppVersion !== options.appVersion;
    const verified = await verifyRuntime({
      lock: lock.lock,
      engineDir: location.engineDir,
      bundlePath: location.bundlePath,
      full,
    });

    if (!verified.ok) {
      const state = await recordFailure(options, stateRead.state, verified.problem);
      const failure = failureOf(verified, options.layout.logsDir);

      return { ok: false, failure, state, treeChecked: false };
    }

    const state = await recordSuccess(
      options,
      stateRead.state,
      lock.lock,
      location.source,
      location.version,
    );

    return {
      ok: true,
      source: location.source,
      bundlePath: location.bundlePath,
      watchdogPath: options.layout.watchdogPath,
      ...(location.version === undefined ? {} : { engineVersion: location.version }),
      ...(selection.externalInvalid === undefined
        ? {}
        : { externalInvalid: selection.externalInvalid }),
      state,
      treeChecked: full,
    };
  }

  const state = await recordSuccess(
    options,
    stateRead.state,
    null,
    location.source,
    location.version,
  );

  return {
    ok: true,
    source: location.source,
    bundlePath: location.bundlePath,
    watchdogPath: options.layout.watchdogPath,
    ...(location.version === undefined ? {} : { engineVersion: location.version }),
    ...(selection.externalInvalid === undefined
      ? {}
      : { externalInvalid: selection.externalInvalid }),
    state,
    treeChecked: false,
  };
}

/** Development: use the checkout's bundle without a packaged lock. */
async function prepareDev(
  options: PrepareRuntimeOptions,
  state: RuntimeStateV1,
): Promise<RuntimePlan> {
  try {
    await stat(options.layout.bundlePath);
  } catch {
    return {
      ok: false,
      failure: {
        kind: "missing",
        detail: `development engine not found: ${options.layout.bundlePath}`,
        enginePath: options.layout.engineDir,
        logPath: options.layout.logsDir,
      },
      state,
      treeChecked: false,
    };
  }

  return {
    ok: true,
    source: "bundled",
    bundlePath: options.layout.bundlePath,
    watchdogPath: options.layout.watchdogPath,
    state,
    treeChecked: false,
  };
}

/** Turn a verification failure into the page's shape. */
function failureOf(result: RuntimeVerifyResult & { ok: false }, logsDir: string): RuntimeFailure {
  return {
    kind: "mismatch",
    detail:
      result.problem === "entry-mismatch"
        ? "The engine entry does not match runtime-lock.json."
        : "The engine tree does not match runtime-lock.json.",
    expected: result.expected,
    actual: result.actual,
    logPath: logsDir,
  };
}

/** Persist the successful facts; the full-tree marker only advances after a pass. */
async function recordSuccess(
  options: PrepareRuntimeOptions,
  state: RuntimeStateV1,
  lock: RuntimeLockV1 | null,
  source: string,
  version: string | undefined,
): Promise<RuntimeStateV1> {
  const next: RuntimeStateV1 = {
    ...state,
    lastAppVersion: options.appVersion,
    lastVerifiedAt: options.now?.() ?? new Date().toISOString(),
    lastResult: "ok",
    ...(source === "external" && version !== undefined ? { externalEngineVersion: version } : {}),
    ...(lock === null ? {} : {}),
  };

  await writeRuntimeState(options.layout.statePath, next).catch(() => undefined);

  return next;
}

/** Persist a failure without clearing the external pick. */
async function recordFailure(
  options: PrepareRuntimeOptions,
  state: RuntimeStateV1,
  result: "missing" | "entry-mismatch" | "tree-mismatch",
): Promise<RuntimeStateV1> {
  const next: RuntimeStateV1 = {
    ...state,
    lastVerifiedAt: options.now?.() ?? new Date().toISOString(),
    lastResult: result,
  };

  await writeRuntimeState(options.layout.statePath, next).catch(() => undefined);

  return next;
}

/** Re-export for tests that need the lock type without a deep import. */
export type { RuntimeLockV1 };
