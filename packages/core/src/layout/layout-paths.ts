/**
 * File names and paths for the layout store.
 *
 * The two shells never share a file: `layout/desktop.json` and
 * `layout/vscode.json` are separate documents, and the two draft files are
 * separate too. Keeping the mapping in one module is what makes "a write for
 * one shell cannot touch the other shell" checkable in one place
 * instead of at every call site.
 *
 * Nothing here reads or writes: this is pure name construction, so the store and
 * the draft store can be tested without a filesystem. Every function stays
 * inside `layoutDir(userData)`. `shell` is a closed union and the backup
 * timestamp is stripped of path separators, so no argument can climb out of the
 * directory.
 */

import { basename, dirname, join } from "node:path";

/**
 * The shells the layout store keeps files for. A closed union on purpose: an
 * unknown shell must not invent a key.
 */
export type LayoutShell = "desktop" | "vscode";

/** Every shell, in stable order; tests iterate this instead of hard-coding the list. */
export const LAYOUT_SHELLS = ["desktop", "vscode"] as const satisfies readonly LayoutShell[];

/** Directory under `paths.userData` that holds all four files and the backup copies. */
export const LAYOUT_DIR_NAME = "layout";

/** The directory that owns every layout file. */
export function layoutDir(userData: string): string {
  return join(userData, LAYOUT_DIR_NAME);
}

/** `layout/desktop.json` or `layout/vscode.json`. */
export function layoutPath(userData: string, shell: LayoutShell): string {
  return join(layoutDir(userData), `${shell}.json`);
}

/** `layout/drafts-desktop.json` or `layout/drafts-vscode.json`. */
export function draftPath(userData: string, shell: LayoutShell): string {
  return join(layoutDir(userData), `drafts-${shell}.json`);
}

/**
 * The name prefix of a shell's corruption backups, e.g. `desktop.corrupt-`.
 *
 * `pruneBackups` needs the prefix separately from a full path, and deriving it
 * here keeps the naming rule in one place.
 */
export function backupPrefix(shell: LayoutShell): string {
  return `${shell}.corrupt-`;
}

/**
 * `layout/desktop.corrupt-<timestamp>.json` or the vscode equivalent.
 *
 * The timestamp is sanitised rather than trusted: it only ever comes from
 * `formatTimestamp(now())` in production, but a separator smuggled into it must
 * not turn a backup name into a path.
 */
export function backupPath(userData: string, shell: LayoutShell, timestamp: string): string {
  return backupPathFor(join(layoutDir(userData), `${shell}.json`), timestamp);
}

/** The file's own name without the `.json` suffix, e.g. `desktop` or `drafts-vscode`. */
export function backupStem(target: string): string {
  const name = basename(target);
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

/**
 * The `pruneBackups` prefix for a data file, e.g. `desktop.corrupt-`.
 *
 * Derived from the file being backed up rather than from a shell name, so the
 * two stores cannot drift: a `drafts-desktop.json` gets `drafts-desktop.corrupt-`
 * and nothing else.
 */
export function corruptionPrefix(target: string): string {
  return `${backupStem(target)}.corrupt-`;
}

/**
 * `layout/desktop.corrupt-<timestamp>.json`, derived from the file it copies.
 *
 * This is the one implementation of the backup naming rule: the store and the
 * draft store both call it, so the sanitiser below has a production path and a
 * changed stem rule cannot be applied in one place only.
 */
export function backupPathFor(target: string, timestamp: string): string {
  return join(dirname(target), `${corruptionPrefix(target)}${sanitiseStamp(timestamp)}.json`);
}

/**
 * The canonical backup timestamp: ISO 8601 with `:` and `.` replaced by `-`.
 *
 * The replacement keeps names portable across Windows and POSIX while leaving
 * them lexicographically ordered, which is what makes "keep the newest three"
 * a plain name sort in `pruneBackups`.
 */
export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Drop anything that could act as a path component; never return an empty stem. */
function sanitiseStamp(timestamp: string): string {
  const cleaned = timestamp.replace(/[^0-9A-Za-z._-]/g, "");
  return /[0-9A-Za-z]/.test(cleaned) ? cleaned : "0";
}
