/**
 * The user's position-trust decision, read from `userData/media-access.json`.
 *
 * This file exists because the switch belongs to the user, not to this item: the
 * requirement gives the switch's *interface and writes* to `F5` (doc 29 `T-15`)
 * and gives this item only the **read** side. So there is no writer here, and no
 * UI. That is also why it is a separate file from `shell-settings.json`: that
 * document's field set is pinned by `D1`'s key-set assertion, and adding a security
 * decision to a file about window geometry would turn a `done` item's test red and
 * put two unrelated concerns in one document.
 *
 * The default is closed. Every way this file can fail to say "yes" -- absent,
 * unreadable, malformed, a version this build does not know, a `trustAllPaths` that
 * is not `true` -- resolves to "the position check stays on". A switch that fails
 * open would silently turn a convenience range into a whole-disk browser, which is
 * the one outcome the requirement is explicit about.
 *
 * Note what the switch does and does not widen. It skips the *location* check only.
 * Type decisions live in `media-mime.ts` and never see this value, so `"trust all
 * paths"` cannot make an `.exe` previewable or make an `.html` file executable --
 * the wording matters because "trust all files" would be a false description of
 * what happens.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** The format this build understands. */
export const MEDIA_ACCESS_VERSION = 1 as const;

/**
 * What `media-access.json` may contain.
 *
 * `decidedAt` is for the log and for diagnosis only; nothing branches on it. It is
 * required in the shape so that a hand-written file has to think about when the
 * decision was made, which is the question anyone reading the log will ask.
 */
export interface MediaAccess {
  readonly version: typeof MEDIA_ACCESS_VERSION;
  readonly trustAllPaths: boolean;
  readonly decidedAt: string;
}

/** The default: the position check is on, because nothing has said otherwise. */
export const MEDIA_ACCESS_DEFAULT: MediaAccess = Object.freeze({
  version: MEDIA_ACCESS_VERSION,
  trustAllPaths: false,
  decidedAt: "",
});

/**
 * Where the decision lives.
 *
 * Exported so `F5` writes the same path this module reads; a second spelling of
 * the location would be a second file that never gets read.
 *
 * @param userData the directory Electron reports for this app
 */
export function mediaAccessPath(userData: string): string {
  return path.join(userData, "media-access.json");
}

/**
 * Parse the document.
 *
 * Never throws. A missing file, a truncated write, a hand edit and a hostile file
 * all produce the default, for the reason in the file header: this decision can
 * only fail closed.
 *
 * An unknown `version` is also treated as "no decision", not as "keep what you
 * understood". A newer build may have written `trustAllPaths: true` next to a
 * field that changes its meaning; honouring the flag while ignoring the field would
 * be acting on half a document.
 *
 * @param text the file's contents
 */
export function parseMediaAccess(text: string): MediaAccess {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return MEDIA_ACCESS_DEFAULT;
  }

  if (typeof raw !== "object" || raw === null) return MEDIA_ACCESS_DEFAULT;

  const record = raw as Record<string, unknown>;

  if (record["version"] !== MEDIA_ACCESS_VERSION) return MEDIA_ACCESS_DEFAULT;

  // Strictly `true`. `"true"`, `1` and `"yes"` are all refused: this is a security
  // decision being read, and a truthy check would accept a hand-edited file whose
  // author did not mean to switch anything on.
  if (record["trustAllPaths"] !== true) return MEDIA_ACCESS_DEFAULT;

  const decidedAt = typeof record["decidedAt"] === "string" ? record["decidedAt"] : "";

  return { version: MEDIA_ACCESS_VERSION, trustAllPaths: true, decidedAt };
}

/**
 * Read the decision from disk.
 *
 * Read once per call rather than cached, because the file is the user's and can
 * change while the app runs: `F5`'s switch would otherwise need a message to this
 * module to take effect, and a cache is how a switch appears not to work.
 *
 * @param userData the directory Electron reports for this app
 */
export async function readMediaAccess(userData: string): Promise<MediaAccess> {
  try {
    return parseMediaAccess(await readFile(mediaAccessPath(userData), "utf8"));
  } catch {
    // Absent is the normal case before `F5` ships, and it is not an error.
    return MEDIA_ACCESS_DEFAULT;
  }
}

/**
 * Whether the position check should be skipped, given a decision.
 *
 * A function rather than a property read so the call site reads as a question about
 * behaviour ("should the check be skipped") rather than about a flag, which keeps
 * the meaning of the flag in one place.
 *
 * @param access the parsed decision
 */
export function skipsPositionCheck(access: MediaAccess): boolean {
  return access.trustAllPaths === true;
}
