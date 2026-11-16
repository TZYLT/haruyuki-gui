/**
 * Checking an IPC payload that claims to describe dropped files.
 *
 * This lives outside `main.ts` for one concrete reason: importing `main.ts` runs it,
 * and the first thing it does is register listeners on `app`, which is `undefined`
 * under plain Node. A validator that could only be tested inside a real Electron
 * process would be a validator whose refusal paths were never exercised -- and every
 * refusal path here is a security boundary.
 *
 * The sender is the renderer, which is the side an attacker would rather control, so
 * the payload is data rather than a description: the preload is *expected* to have
 * converted the drop already, and this module's job is to make sure what arrived
 * really has the shape that conversion produces.
 */

import path from "node:path";

/**
 * Check an IPC payload that claims to describe dropped files.
 *
 * Validated rather than trusted because the sender is the renderer, which is the side
 * an attacker would rather control. The preload is expected to have converted the drop
 * already; this function's job is to make sure that what arrived really has the shape
 * the conversion produces, so a compromised page cannot invent paths.
 *
 * @param payload whatever arrived on the channel
 * @returns the normalised report, or `null` if the payload is not that shape
 */
export function validateDroppedPayload(
  payload: unknown,
): { entries: { name: string; path?: string }[] } | null {
  if (typeof payload !== "object" || payload === null) return null;

  const entries = (payload as { entries?: unknown }).entries;

  if (!Array.isArray(entries)) return null;

  const normalised: { name: string; path?: string }[] = [];

  for (const candidate of entries) {
    if (typeof candidate !== "object" || candidate === null) return null;

    const name = (candidate as { name?: unknown }).name;

    // A name is required: an entry with no name describes nothing, and a caller
    // showing a list would render a blank row.
    if (typeof name !== "string" || name === "") return null;

    const candidatePath = (candidate as { path?: unknown }).path;

    if (candidatePath === undefined) {
      normalised.push({ name });
      continue;
    }

    if (typeof candidatePath !== "string") return null;

    // An absolute path only. A relative one would resolve against this process's cwd
    // rather than the renderer's, which is the same trap `buildSpawnSpec` avoids -- and
    // here it would silently authorise the wrong directory.
    if (!path.isAbsolute(candidatePath)) {
      normalised.push({ name });
      continue;
    }

    normalised.push({ name, path: candidatePath });
  }

  return { entries: normalised };
}
