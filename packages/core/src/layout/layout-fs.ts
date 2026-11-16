/**
 * The injectable filesystem for the layout store.
 *
 * C4 must not touch `node:fs` directly: the headless shell (A3) and the tests
 * need to inject failures, and the store has to survive a rename that dies
 * halfway. So this module defines the eight-operation surface the store uses,
 * a `node:fs/promises` adapter, and the three helpers that carry the durability
 * the durability rules:
 *
 *   atomicWrite   write a temporary sibling, then rename over the target, so a
 *                 reader never sees half a JSON document and a failed write
 *                 leaves the old file intact (invariant I-6).
 *   backupFile    copy a file before it is overwritten; missing source is a
 *                 `false`, not an exception, because a backup is diagnostic.
 *   pruneBackups  keep the newest `keep` corruption copies. Best effort: a
 *                 cleanup that fails must never fail the load that triggered it.
 *
 * The interface reads ENOENT as "absent" (`null`) and rethrows everything else,
 * so callers distinguish "first run" from "permission denied" without knowing
 * Node error codes.
 */

import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/** The only filesystem surface the layout store and draft store may use. */
export interface LayoutFs {
  /** File text, or `null` when the file does not exist. Other errors rethrow. */
  readFile(path: string): Promise<string | null>;
  /** Replace the file's contents. Creates or truncates. */
  writeFile(path: string, data: string): Promise<void>;
  /** Atomically move `from` over `to` (the target is replaced). */
  rename(from: string, to: string): Promise<void>;
  /** Copy `from` to `to`, replacing `to`. */
  copyFile(from: string, to: string): Promise<void>;
  /** Create the directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Remove one file. A missing file rethrows. */
  unlink(path: string): Promise<void>;
  /** Entry names inside `path`, unsorted as the platform returns them. */
  readdir(path: string): Promise<string[]>;
  /** `{ size }`, or `null` when the path does not exist. Other errors rethrow. */
  stat(path: string): Promise<{ size: number } | null>;
}

/** `node:fs/promises`, adapted to the `LayoutFs` contract. */
export function createNodeLayoutFs(): LayoutFs {
  return {
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },
    async writeFile(path, data) {
      await writeFile(path, data, "utf8");
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async copyFile(from, to) {
      await copyFile(from, to);
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async unlink(path) {
      await unlink(path);
    },
    async readdir(path) {
      return readdir(path);
    },
    async stat(path) {
      try {
        const info = await stat(path);
        return { size: info.size };
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },
  };
}

/**
 * Write `text` to `file` without ever leaving a half-written target.
 *
 * The temporary file is a sibling of the target, which is what makes the final
 * `rename` atomic on one volume. If either step throws, the temporary file is
 * removed (best effort) and the error is rethrown with the old file still in
 * place. The caller owns directory creation: `mkdir` runs once at startup, not
 * on every save.
 */
export async function atomicWrite(fs: LayoutFs, file: string, text: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  try {
    await fs.writeFile(temporary, text);
    await fs.rename(temporary, file);
  } catch (error) {
    try {
      await fs.unlink(temporary);
    } catch {
      // The temporary file may never have been created, or may already be gone.
      // Either way the caller's error is the one that matters.
    }
    throw error;
  }
}

/**
 * Copy `file` to `backupPath` before the original is replaced or discarded.
 *
 * Returns `false` instead of throwing when the copy fails, including when the
 * source is missing: a missing original means there was nothing to preserve, and
 * any other failure is a diagnostic detail the caller logs rather than a reason
 * to refuse the load. The caller decides whether the backup matters.
 */
export async function backupFile(fs: LayoutFs, file: string, backupPath: string): Promise<boolean> {
  try {
    await fs.copyFile(file, backupPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete all but the newest `keep` files in `dir` whose names start with
 * `prefix` and end in `.json`.
 *
 * Backups carry a lexicographically ordered timestamp, so a descending name sort
 * is a newest-first sort. Failures are swallowed on purpose: pruning is
 * housekeeping after a corrupt load, and a directory that cannot be listed or a
 * file that cannot be removed must not turn into a load failure. A non-positive
 * or fractional `keep` is coerced to a non-negative integer.
 */
export async function pruneBackups(
  fs: LayoutFs,
  dir: string,
  prefix: string,
  keep = 3,
): Promise<void> {
  const limit = Math.max(0, Math.trunc(keep));
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const backups = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
  for (const name of backups.slice(limit)) {
    try {
      await fs.unlink(join(dir, name));
    } catch {
      // Best effort: leave the extra copy in place rather than fail the load.
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
