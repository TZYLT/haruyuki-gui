/**
 * The runtime's small persistent memory: which app version was last verified and
 * which external engine the user chose.
 *
 * This is not the lock. The lock ships with the app and says what the engine
 * must be; this file lives under `userData` and says what this installation has
 * already checked. Corrupting it must never prevent the app from starting -- the
 * worst case is one extra full-tree verification, which is exactly what a
 * missing state should mean.
 *
 * Writes are atomic (temp file + rename): a crash during a write leaves either
 * the previous state or the new one, never a truncated JSON document.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** The only supported state shape. */
export const RUNTIME_STATE_VERSION = 1 as const;

/** What the last verification concluded. */
export type RuntimeLastResult =
  "ok" | "entry-mismatch" | "tree-mismatch" | "missing" | "external-invalid";

/** `runtime-state.json`, version 1. */
export interface RuntimeStateV1 {
  readonly stateVersion: typeof RUNTIME_STATE_VERSION;
  readonly lastAppVersion: string;
  readonly lastVerifiedAt: string;
  readonly lastResult: RuntimeLastResult;
  readonly externalEngineDir?: string;
  readonly externalEngineVersion?: string;
}

/** Result of reading state; `recovered` means the file was missing/corrupt. */
export interface RuntimeStateRead {
  readonly state: RuntimeStateV1;
  readonly recovered: boolean;
  readonly detail?: string;
}

/**
 * The state a first run starts from.
 *
 * `lastAppVersion` is empty on purpose: it differs from every real app version,
 * so the first start takes the full-tree path. `lastResult: "missing"` says the
 * state is not evidence of a successful check; it is not a claim that files are
 * missing.
 *
 * @returns a fresh state object
 */
export function defaultRuntimeState(): RuntimeStateV1 {
  return {
    stateVersion: RUNTIME_STATE_VERSION,
    lastAppVersion: "",
    lastVerifiedAt: "",
    lastResult: "missing",
  };
}

/**
 * Read state, recovering from missing/corrupt files.
 *
 * @param file absolute `runtime-state.json` path
 * @returns state plus whether it was recovered
 */
export async function readRuntimeState(file: string): Promise<RuntimeStateRead> {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return {
      state: defaultRuntimeState(),
      recovered: true,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      state: defaultRuntimeState(),
      recovered: true,
      detail: `not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isRuntimeState(parsed)) {
    return {
      state: defaultRuntimeState(),
      recovered: true,
      detail: "shape does not match RuntimeStateV1",
    };
  }

  return { state: parsed, recovered: false };
}

/**
 * Write state atomically: temp file in the same directory, then rename.
 *
 * A failed write is not fatal. The caller logs it; the next start treats the
 * state as missing and verifies again, which is safe if slower. Refusing to
 * start because a bookkeeping file could not be written would be worse.
 *
 * @param file absolute `runtime-state.json` path
 * @param state state to persist
 * @throws {Error} when the write or rename fails
 */
export async function writeRuntimeState(file: string, state: RuntimeStateV1): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `${path.basename(file)}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/** Narrow `unknown` to the frozen state shape. */
function isRuntimeState(value: unknown): value is RuntimeStateV1 {
  if (!isRecord(value)) return false;
  if (value["stateVersion"] !== RUNTIME_STATE_VERSION) return false;
  if (typeof value["lastAppVersion"] !== "string") return false;
  if (typeof value["lastVerifiedAt"] !== "string") return false;
  if (!isLastResult(value["lastResult"])) return false;

  const externalDir = value["externalEngineDir"];
  const externalVersion = value["externalEngineVersion"];

  if (externalDir !== undefined && typeof externalDir !== "string") return false;
  if (externalVersion !== undefined && typeof externalVersion !== "string") return false;

  return true;
}

/** The five values the state may carry. */
function isLastResult(value: unknown): value is RuntimeLastResult {
  return (
    value === "ok" ||
    value === "entry-mismatch" ||
    value === "tree-mismatch" ||
    value === "missing" ||
    value === "external-invalid"
  );
}

/** A JSON object, not `null` or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
