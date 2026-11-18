/**
 * Runtime-marker writes owned by the shell's supervision layer.
 *
 * `@haruyuki/core/supervision` owns the file format and the atomic write; this
 * module owns the two lifecycle operations boot and quit need: attach an
 * `EngineMarker` after a successful start, and remove the marker after a
 * confirmed stop. Splitting them out keeps `boot.ts` about the decision rather
 * than about JSON bookkeeping.
 */

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import {
  clearRuntimeMarker,
  readRuntimeMarker,
  writeRuntimeMarker,
  type EngineMarker,
  type RuntimeMarker,
} from "@haruyuki/core/supervision";

import type { SupervisionLog } from "./errors.js";
import { describeError } from "./errors.js";

/**
 * Write the engine facts into the marker boot wrote.
 *
 * Read-modify-write so `instanceId`, `startedAt` and `appVersion` survive. The
 * write is atomic because it goes through the core writer. A failure returns
 * `false` rather than throwing: the engine is already running, and stopping a
 * working engine because a bookkeeping file could not be written would be a
 * worse outcome (requirement section 4.6).
 *
 * The marker is always `runtime.json` in the path's directory; the argument is
 * the path so callers do not have to know that convention twice.
 */
export async function writeMarkerEngine(
  markerPath: string,
  engineMarker: EngineMarker,
): Promise<boolean> {
  const dir = dirname(markerPath);

  try {
    const read = await readRuntimeMarker(dir);
    const marker: RuntimeMarker = read.ok
      ? { ...read.marker, engine: engineMarker }
      : {
          schemaVersion: 1,
          instanceId: randomUUID(),
          startedAt: engineMarker.startedAt,
          appVersion: "unknown",
          engine: engineMarker,
        };

    await writeRuntimeMarker(dir, marker);

    return true;
  } catch {
    return false;
  }
}

/**
 * Delete this run's marker, but only for a caller that has confirmed the engine
 * is gone (the quit supervisor). Idempotent: a missing marker is success.
 */
export async function clearMarkerAfterStop(
  userData: string,
  options: { readonly onLog?: SupervisionLog } = {},
): Promise<boolean> {
  try {
    await clearRuntimeMarker(userData);
    log(options.onLog, "supervision.marker.clear", { state: "cleared" });

    return true;
  } catch (error) {
    log(options.onLog, "supervision.marker.clear", {
      state: "failed",
      detail: describeError(error),
    });

    return false;
  }
}

/** Best-effort log call; a broken sink must not change the operation's result. */
function log(
  onLog: SupervisionLog | undefined,
  event: string,
  detail: Record<string, unknown>,
): void {
  try {
    onLog?.(event, detail);
  } catch {
    // Nothing useful is left to report to.
  }
}
