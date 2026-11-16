/**
 * Crash-page query strings, built in the main process.
 *
 * The renderer route is a normal page load with `?crash=...`; the facts a user
 * needs (why, and what the exit code was) travel in the URL rather than in a
 * preload member or a second IPC channel. Building the string here, rather than
 * in the page, keeps the route's input shape testable without a DOM.
 *
 * Every value is normalised to a string. `URLSearchParams` turns `null` into
 * `"null"`, which would reach the page as an exit code of the word "null"; empty
 * is the absence the page already has to handle for a signal-less exit.
 */

import type { EngineExitLike, RendererGoneDetails } from "./capture.js";

/** A string, or empty when the value was absent or not a string. */
function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/** An integer, or empty when the value was absent or not finite. */
function integer(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * Build the query string for a renderer crash page.
 *
 * `signal` is always empty for a renderer: Electron reports a reason and an exit
 * code, not a signal. It is still present so the page reads one shape for both
 * kinds instead of branching on which fields exist.
 *
 * @param details Electron's `render-process-gone` facts
 */
export function rendererCrashQuery(details: RendererGoneDetails): string {
  return new URLSearchParams({
    crash: "renderer",
    reason: text(details.reason),
    code: integer(details.exitCode),
    signal: "",
  }).toString();
}

/**
 * Build the query string for an engine crash page.
 *
 * @param exit the engine's last exit facts
 */
export function engineCrashQuery(exit: EngineExitLike): string {
  return new URLSearchParams({
    crash: "engine",
    reason: "",
    code: integer(exit.code),
    signal: text(exit.signal),
  }).toString();
}
