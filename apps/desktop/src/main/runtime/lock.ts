/**
 * The runtime lock: read, validate and verify the engine against it.
 *
 * Two checks, deliberately different:
 *
 *   entry  one file (`haruyuki.js`), on every start. 23 ms measured; cheap
 *          enough to run before the engine process is spawned.
 *   tree   every file, only after the application version changed. ~15 s
 *          measured; it gates the engine start so a corrupted tree cannot run,
 *          but it is not on the normal-start path.
 *
 * The tree algorithm is frozen here and in the build's lock generator: sort
 * relative paths, one line per file (`sha256 + "  " + relativePath`), join with
 * `"\n"` and hash that string. No trailing newline. A second algorithm would
 * produce a second answer to "is this tree intact".
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

/** The only supported lock shape. */
export const RUNTIME_LOCK_VERSION = 1 as const;

/** Engine entry metadata recorded in the lock. */
export interface RuntimeLockBundle {
  readonly name: string;
  readonly entry: string;
  readonly bytes: number;
}

/** Where the staged engine came from. */
export interface RuntimeLockSource {
  readonly kind: "npm" | "file";
  readonly spec: string;
  readonly integrity?: string;
}

/** The runtime that built the lock; not the runtime that reads it. */
export interface RuntimeLockRuntime {
  readonly electron: string;
  readonly node: string;
  readonly modules: string;
}

/** The full-tree digest and its size. */
export interface RuntimeLockTree {
  readonly files: number;
  readonly bytes: number;
  readonly sha256: string;
}

/** `runtime-lock.json`, version 1. */
export interface RuntimeLockV1 {
  readonly lockVersion: typeof RUNTIME_LOCK_VERSION;
  readonly engineVersion: string;
  readonly bundle: RuntimeLockBundle;
  readonly sha256: string;
  readonly source: RuntimeLockSource;
  readonly builtAt: string;
  readonly runtime: RuntimeLockRuntime;
  readonly tree: RuntimeLockTree;
}

/** Why the lock could not be used. */
export type RuntimeLockProblem = "missing" | "invalid";

/** Result of reading the lock. */
export type RuntimeLockRead =
  | { readonly ok: true; readonly lock: RuntimeLockV1 }
  | { readonly ok: false; readonly problem: RuntimeLockProblem; readonly detail: string };

/** Result of hashing one file. */
export interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

/** Result of hashing a tree. */
export interface TreeDigest {
  readonly sha256: string;
  readonly files: number;
  readonly bytes: number;
}

/** Why verification failed. */
export type RuntimeVerifyProblem = "missing" | "entry-mismatch" | "tree-mismatch";

/** Result of verifying the engine against the lock. */
export type RuntimeVerifyResult =
  | {
      readonly ok: true;
      readonly lock: RuntimeLockV1;
      readonly entry: FileDigest;
      readonly tree?: TreeDigest;
    }
  | {
      readonly ok: false;
      readonly problem: RuntimeVerifyProblem;
      readonly expected: string;
      readonly actual: string;
      readonly expectedBytes?: number;
      readonly actualBytes?: number;
    };

/**
 * Read and validate `runtime-lock.json`.
 *
 * A missing lock and an invalid lock are distinct: the first is a packaging
 * problem (the file was not included), the second is a corrupted/edited file.
 * Both refuse the engine, but the log line should say which.
 *
 * @param file absolute lock path
 * @returns the parsed lock or a problem
 */
export async function readRuntimeLock(file: string): Promise<RuntimeLockRead> {
  let text: string;

  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return { ok: false, problem: "missing", detail: messageOf(error) };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, problem: "invalid", detail: `not JSON: ${messageOf(error)}` };
  }

  if (!isRuntimeLock(parsed)) {
    return { ok: false, problem: "invalid", detail: "shape does not match RuntimeLockV1" };
  }

  return { ok: true, lock: parsed };
}

/**
 * Hash one file with sha256, streaming so a 16 MB entry does not need a copy.
 *
 * @param file absolute path
 * @returns digest and byte count
 */
export async function hashFile(file: string): Promise<FileDigest> {
  const hash = createHash("sha256");
  let bytes = 0;

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);

    stream.on("data", (chunk: string | Buffer) => {
      const bytesRead = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

      bytes += bytesRead.byteLength;
      hash.update(bytesRead);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });

  return { sha256: hash.digest("hex"), bytes };
}

/**
 * Hash the engine tree with the algorithm in the module comment.
 *
 * Symlinks are rejected rather than followed: a link into another directory
 * would make the digest depend on files outside the engine, and an attacker
 * who can write the tree could otherwise point a checksum at a file they
 * control. The staged engine has no symlinks.
 *
 * @param engineDir absolute engine directory
 * @returns the tree digest
 * @throws {Error} when a symlink is found or a file cannot be read
 */
export async function hashTree(engineDir: string): Promise<TreeDigest> {
  const root = path.resolve(engineDir);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: { absolute: string; relative: string; bytes: number }[] = [];
  let bytes = 0;

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink in engine tree: ${entry.name}`);
    }

    if (!entry.isFile()) continue;

    const parent = entry.parentPath ?? root;
    const absolute = path.join(parent, entry.name);
    const info = await lstat(absolute);

    files.push({
      absolute,
      relative: path.relative(root, absolute).split(path.sep).join("/"),
      bytes: info.size,
    });
    bytes += info.size;
  }

  files.sort((left, right) =>
    left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0,
  );

  const lines: string[] = [];

  for (const file of files) {
    const digest = await hashFile(file.absolute);

    lines.push(`${digest.sha256}  ${file.relative}`);
  }

  return {
    sha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
    files: files.length,
    bytes,
  };
}

/**
 * Verify the engine against the lock.
 *
 * `full` is the upgrade path: it hashes the whole tree and compares file count,
 * byte count and digest. Without it only the entry is checked, which is the
 * normal-start path.
 *
 * @param options lock, engine directory, entry path and whether to go full
 * @returns verification result
 */
export async function verifyRuntime(options: {
  readonly lock: RuntimeLockV1;
  readonly engineDir: string;
  readonly bundlePath: string;
  readonly full: boolean;
}): Promise<RuntimeVerifyResult> {
  let entry: FileDigest;

  try {
    entry = await hashFile(options.bundlePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        problem: "missing",
        expected: options.lock.sha256,
        actual: "",
      };
    }

    throw error;
  }

  if (entry.sha256 !== options.lock.sha256 || entry.bytes !== options.lock.bundle.bytes) {
    return {
      ok: false,
      problem: "entry-mismatch",
      expected: options.lock.sha256,
      actual: entry.sha256,
      expectedBytes: options.lock.bundle.bytes,
      actualBytes: entry.bytes,
    };
  }

  if (!options.full) {
    return { ok: true, lock: options.lock, entry };
  }

  const tree = await hashTree(options.engineDir);
  const expected = options.lock.tree;

  if (
    tree.sha256 !== expected.sha256 ||
    tree.files !== expected.files ||
    tree.bytes !== expected.bytes
  ) {
    return {
      ok: false,
      problem: "tree-mismatch",
      expected: expected.sha256,
      actual: tree.sha256,
      expectedBytes: expected.bytes,
      actualBytes: tree.bytes,
    };
  }

  return { ok: true, lock: options.lock, entry, tree };
}

/** Narrow `unknown` to the frozen lock shape without a schema dependency. */
function isRuntimeLock(value: unknown): value is RuntimeLockV1 {
  if (!isRecord(value)) return false;
  if (value["lockVersion"] !== RUNTIME_LOCK_VERSION) return false;
  if (!isNonEmptyString(value["engineVersion"])) return false;
  if (!isSha256(value["sha256"])) return false;
  if (!isNonEmptyString(value["builtAt"])) return false;

  const bundle = value["bundle"];
  if (!isRecord(bundle)) return false;
  if (!isNonEmptyString(bundle["name"]) || !isNonEmptyString(bundle["entry"])) return false;
  if (!isNonNegativeInteger(bundle["bytes"])) return false;

  const source = value["source"];
  if (!isRecord(source)) return false;
  if (source["kind"] !== "npm" && source["kind"] !== "file") return false;
  if (!isNonEmptyString(source["spec"])) return false;
  if (source["integrity"] !== undefined && !isNonEmptyString(source["integrity"])) return false;

  const runtime = value["runtime"];
  if (!isRecord(runtime)) return false;
  if (
    !isNonEmptyString(runtime["electron"]) ||
    !isNonEmptyString(runtime["node"]) ||
    !isNonEmptyString(runtime["modules"])
  ) {
    return false;
  }

  const tree = value["tree"];
  if (!isRecord(tree)) return false;
  if (!isSha256(tree["sha256"])) return false;
  if (!isNonNegativeInteger(tree["files"]) || !isNonNegativeInteger(tree["bytes"])) return false;

  return true;
}

/** A JSON object, not `null` or an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A sha256 digest is 64 lowercase hex characters. */
function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** A non-empty string. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A safe non-negative integer. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Read a thrown value without assuming it is an `Error`. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
