#!/usr/bin/env node
/**
 * release.mjs - one command that turns a clean checkout into something shippable.
 *
 * Today the sequence lives in people's heads: `pnpm install`, then
 * `fetch-engine`, then `stage-runtime`, then `lock`, then `electron-builder`.
 * A person who skips or reorders a step gets a package that looks fine and
 * fails at start - and the honest description of that state is that a human
 * decided "keep going" on the pipeline's behalf.
 *
 * Two rounds, because the middle of the pipeline and the end of it can be
 * judged separately:
 *
 *   round 1  install -> fetch -> deref -> stage -> lock        (this file, now)
 *   round 2  ... -> build -> package -> manifest               (W2/W3, wave 2)
 *
 * Round 1 produces the runtime tree and its lock, and that is what makes an
 * engine start. Round 2 wraps it into an artifact. `--skip-bundle` is what
 * separates them, and its name is deliberately not "skip checks": nothing is
 * verified less, round 1 simply ends earlier.
 *
 * Exit codes:
 *   0  every requested target succeeded, or was skipped for lack of a capability
 *   1  a target was attempted and failed
 *   2  nothing was attempted: a prerequisite failed, the command line was bad,
 *      or this version already carries a tag
 *   3  the only requested target cannot be done on this machine
 * 1 and 2 are failures; 3 is also a failure, it just reads differently.
 *
 * The three sources of 2 share a code but not a first line: each writes one of
 * the fixed prefixes in `ERROR_PREFIX`, because "nothing was attempted" has
 * three causes and a check that only reads the exit code cannot tell them apart.
 * The version guard runs before every step, so a refusal costs nothing and
 * leaves nothing behind.
 */

import { existsSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");

/** Where the engine artifact lands before `stage-runtime` copies it. */
const ENGINE_ARTIFACT = path.join(REPO_ROOT, "_research", "engine-0.6.0");

/** Files that are not part of the shipped engine and must not reach the lock. */
const NOT_SHIPPED = new Set([".bin"]);

/**
 * The only reasons a platform may be absent for, and the single list of them.
 *
 * `manifest.mjs` imports this rather than keeping its own copy: the two scripts
 * gate the same exit code on the same values, and two lists would drift the day
 * somebody adds a reason to one of them.
 */
export const NOT_BUILT_REASONS = ["docker-unavailable", "machine-offline", "toolchain-missing"];

const USAGE = `usage: node apps/desktop/scripts/release.mjs [options]

  --win-only       package Windows only (zip + win-unpacked)
  --linux-only     package Linux only (AppImage)
                   (neither) both
  --skip-install   assume node_modules is already in place
  --skip-fetch     reuse ${path.relative(REPO_ROOT, ENGINE_ARTIFACT)}
  --skip-bundle    stop after the runtime tree and its lock (round 1)
  --linux-not-built=<reason>  why no AppImage was produced; see manifest.mjs
  -h, --help       this text

A version that is already a git tag is refused before any step runs: two patches
sharing a number are indistinguishable where users download them. A leftover
release/ document for the same version is only a warning, because the same
command has to be re-runnable.

exit codes
  0  every requested target succeeded, or was skipped for lack of a capability
  1  a target was attempted and failed
  2  nothing was attempted: a prerequisite failed, the command line was bad, or
     this version already carries a tag. The first line says which
  3  the only requested target cannot be done on this machine`;

/**
 * Parse the command line.
 *
 * `--win-only` and `--linux-only` together are refused instead of guessed: the
 * natural reading of "both given" is "do both", which is exactly what giving
 * neither means, so the flag pair would only exist to look like control.
 *
 * `--linux-not-built=` says why no AppImage came out, which is only a statement
 * about a platform this run was asked for. Saying it while asking Windows not to
 * touch Linux is two assertions about one platform - `skipped, not-required` and
 * `not-built, <reason>` - and a manifest can only carry one of them. Dropping
 * either would leave the document saying something nobody decided, so the pair is
 * refused before any step rather than resolved by precedence.
 *
 * @param {string[]} argv
 * @returns {{ targets: ("win32"|"linux")[], skipInstall: boolean, skipFetch: boolean, skipBundle: boolean, linuxNotBuilt: string|null }}
 */
export function parseArgs(argv) {
  const options = {
    targets: ["win32", "linux"],
    skipInstall: false,
    skipFetch: false,
    skipBundle: false,
    // Carried through to `manifest.mjs`, which refuses to guess why a platform
    // has no artifact.
    linuxNotBuilt: null,
  };
  let sawWin = false;
  let sawLinux = false;

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--win-only") {
      sawWin = true;
    } else if (arg === "--linux-only") {
      sawLinux = true;
    } else if (arg === "--skip-install") {
      options.skipInstall = true;
    } else if (arg === "--skip-fetch") {
      options.skipFetch = true;
    } else if (arg === "--skip-bundle") {
      options.skipBundle = true;
    } else if (arg.startsWith("--linux-not-built=")) {
      options.linuxNotBuilt = arg.slice("--linux-not-built=".length);
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }

  if (sawWin && sawLinux) {
    throw new UsageError("--win-only and --linux-only are mutually exclusive");
  }
  if (sawWin) options.targets = ["win32"];
  if (sawLinux) options.targets = ["linux"];

  // Checked after the flags are resolved, so the answer is about the platforms
  // this run will actually attempt rather than about the order they were typed.
  if (options.linuxNotBuilt !== null && !options.targets.includes("linux")) {
    throw new UsageError(
      `--linux-not-built=${options.linuxNotBuilt} says why Linux has no artifact, ` +
        `but --win-only says Linux was never asked of this run. ` +
        `Drop one of the two: a manifest cannot report that platform as both ` +
        `skipped (not-required) and not-built (${options.linuxNotBuilt}).`,
    );
  }

  // The reason becomes a field of the manifest, so it is checked here - before
  // any step - rather than after a multi-minute build has already happened.
  if (options.linuxNotBuilt !== null && !NOT_BUILT_REASONS.includes(options.linuxNotBuilt)) {
    throw new UsageError(
      `--linux-not-built=<reason> must be one of ${NOT_BUILT_REASONS.join(", ")}; ` +
        `got ${JSON.stringify(options.linuxNotBuilt)}. ` +
        `"the image was built but will not start" is a failure, not a missing capability.`,
    );
  }

  return options;
}

/** A bad command line, as opposed to a failed step. */
export class UsageError extends Error {}

/**
 * The first line of every message that ends the run with exit code 2.
 *
 * Three unrelated things share that code, and all of them mean "nothing was
 * attempted". A caller that only reads the exit code cannot tell a typo from a
 * broken `install` from a version that is already published, and the three want
 * different reactions - so the code stays the same and the prefix does not.
 *
 * The version conflict splits again, into "the tag is there" and "git could not
 * say whether it is": the second is a broken checkout, not a published number.
 */
export const ERROR_PREFIX = {
  /** `install`/`fetch` failed: a prerequisite of the build is missing. */
  prerequisite: "error: prerequisite failed",
  /** The command line cannot be acted on. */
  usage: "error: usage",
  /** `git tag v<version>` already exists. */
  tagTaken: "error: version conflict: tag exists",
  /** The tag list could not be read, so the answer is unknown. */
  tagUnknown: "error: version conflict: tag list unreadable",
  /**
   * The only requested target cannot be done on this machine (exit 3).
   *
   * Distinct from every `2` above on purpose: those mean "nothing was attempted
   * and something is wrong with the request or the tree", this one means
   * "nothing was attempted and nothing is wrong - this box lacks the route".
   */
  cannotBuild: "error: cannot build here",
};

/**
 * The version this build would be a release of, from the one place that owns it.
 *
 * @param {string} [desktopDir]
 * @returns {Promise<string|null>} null when package.json does not name a version
 */
export async function readAppVersion(desktopDir = DESKTOP_DIR) {
  const raw = JSON.parse(await readFile(path.join(desktopDir, "package.json"), "utf8"));
  return typeof raw.version === "string" && raw.version.length > 0 ? raw.version : null;
}

/**
 * Is `tag` already a local tag?
 *
 * Separate from the guard below so the guard can be judged without creating a
 * tag: a test that has to mutate the repository to prove a refusal is a test
 * nobody runs twice.
 *
 * @param {string} tag
 * @param {string} [cwd]
 * @returns {boolean|null} null when git cannot answer, which is not "no"
 */
export function localTagExists(tag, cwd = REPO_ROOT) {
  try {
    // A directory that is not a checkout is an expected answer here, not an
    // error to show the user: git's own message would read like a crash.
    const listed = execFileSync("git", ["tag", "--list", tag], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return listed.split("\n").some((line) => line.trim() === tag);
  } catch {
    return null;
  }
}

/**
 * Why this version must not be packaged, or null when it may be.
 *
 * A tag that already carries this number means the number has been published,
 * so a second package under it is indistinguishable from the first one at the
 * place users download from - and no checksum can tell them apart afterwards.
 * That is the only authority: an old `release/` manifest is the residue of a
 * previous build, not a record of publication, so it never refuses anything.
 *
 * Refusal is exit code 2 rather than 1 or 3: nothing was attempted, so there is
 * no failed target and no manifest to write, which is exactly what 2 means
 * here. 1 would claim a build ran and broke; 3 would claim this machine lacks
 * the capability, and any machine with git has it.
 *
 * The answer "git could not say" also refuses: the check exists to make a
 * silent re-release impossible, and "unknown" has to be louder than "no", not
 * quieter. It is a different refusal from a tag that exists - one means bump the
 * version, the other means fix the checkout - so it carries its own prefix.
 *
 * @param {() => Promise<string|null>} [getVersion]
 * @param {(tag: string) => boolean|null} [tagExists]
 * @returns {Promise<{prefix: string, message: string}|null>} refusal, or null
 */
export async function versionConflict(getVersion = readAppVersion, tagExists = localTagExists) {
  const version = await getVersion();
  if (version === null) {
    // No version is a prerequisite this run cannot invent: the tag to compare
    // against and the number on the package both come from that one field.
    return {
      prefix: ERROR_PREFIX.prerequisite,
      message:
        "apps/desktop/package.json has no version, so there is no tag to compare against " +
        "and no honest number to package under. Nothing was built.",
    };
  }

  const tag = `v${version}`;
  const taken = tagExists(tag);

  if (taken === false) return null;
  if (taken === true) {
    return {
      prefix: ERROR_PREFIX.tagTaken,
      message:
        `git tag ${tag} already exists, so ${version} has been published. Refusing to build ` +
        `a second package under the same number: a user downloading either one could not tell ` +
        `them apart, and no checksum would say which is which.\n` +
        `Bump "version" in apps/desktop/package.json and run again. Nothing was built.`,
    };
  }
  return {
    prefix: ERROR_PREFIX.tagUnknown,
    message:
      `could not read the tag list from git, so it is unknown whether ${tag} already exists. ` +
      `Refusing rather than packaging a version that may already be taken; ` +
      `run the command from a checkout. Nothing was built.`,
  };
}

/**
 * A note about the build `release/` still holds, or null when there is none.
 *
 * A second run of the same version is not an error - the same command has to be
 * re-runnable, and refusing would make it not so. But the leftover documents
 * describe an older build, and silently overwriting them is how somebody
 * attaches yesterday's checksums to today's package. So they are named, with
 * the three fields that say which build they are, and the run continues.
 *
 * @param {string} [version] the version to compare against; read from
 *   `package.json` next to `releaseDir` when omitted
 * @param {string} [releaseDir]
 * @returns {Promise<{message: string}|{unreadable: string}|null>}
 */
export async function previousBuildNote(version, releaseDir = path.join(DESKTOP_DIR, "release")) {
  // The version is read here rather than required from the caller: a default
  // that silently receives nothing would compare `appVersion` against
  // `undefined` and stay quiet for every leftover document, which is the one
  // failure this note exists to prevent.
  const wanted = version ?? (await readAppVersion(path.dirname(releaseDir)));
  const file = path.join(releaseDir, "release-manifest.json");
  if (!existsSync(file)) return null;

  /** @type {any} */
  let old;
  try {
    old = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    // A half-written manifest is exactly the case where saying nothing is
    // worst: the next step is about to overwrite it.
    return { unreadable: `${file} exists but cannot be read (${String(error)})` };
  }

  if (String(old?.appVersion) !== wanted) return null;

  return {
    message:
      `release/release-manifest.json already describes ${String(wanted)}: ` +
      `builtAt=${old?.builtAt ?? "unknown"} commit=${old?.commit ?? "unknown"} ` +
      `dirty=${old?.dirty === undefined ? "unknown" : String(old.dirty)}. ` +
      `This is a previous local build, not a publication, so it does not stop this run - ` +
      `but its SHA256SUMS must not be attached to the new package.`,
  };
}

/**
 * Run a step, printing what it is and how long it took.
 *
 * Every step is reported whether it passes or fails: a log that only shows the
 * steps that worked cannot be used to find out where they stopped.
 *
 * @param {string} label
 * @param {() => { status: number|null, stdout?: string, stderr?: string }} body
 * @returns {boolean} true when the step succeeded
 */
function step(label, body) {
  const started = Date.now();
  process.stdout.write(`\n==> ${label}\n`);
  const result = body();
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status === 0) {
    process.stdout.write(`<== ${label} ok (${seconds}s)\n`);
    return true;
  }
  process.stdout.write(`<== ${label} FAILED (${seconds}s, exit ${result.status})\n`);
  const noise = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (noise.length > 0) process.stdout.write(`${noise}\n`);
  return false;
}

/**
 * @param {string[]} command
 * @param {string} cwd
 * @param {NodeJS.ProcessEnv} [env]
 */
function run(command, args, cwd, env) {
  // On Windows `pnpm` is `pnpm.cmd`, a batch file, and Node refuses to spawn it
  // without a shell (ENOENT, not EACCES). The repository already solves this in
  // scripts/lib/verify-command.mjs, so the same rule is reused rather than
  // re-derived: only a real `.exe` may be spawned directly.
  const shell = process.platform === "win32" && !/\.exe$/i.test(command);

  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell,
    // `ELECTRON_RUN_AS_NODE` is set globally on the verification machine and
    // would make the Electron binary behave as plain Node for every child
    // process, including the packaged app. Strip it rather than inherit it.
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: undefined },
  });
}

/**
 * Replace symlinks in the engine tree with the files they point at.
 *
 * npm creates `node_modules/.bin/*` as symlinks on POSIX and as `.cmd`/`.ps1`
 * shims on Windows, so a tree installed on one platform has entries the other
 * never sees. The lock hashes content, and a symlink is another way of reaching
 * that content - so the content is what gets hashed, and the link is replaced
 * instead of being skipped (skipping would leave the lock describing a tree
 * with fewer files than the one on disk).
 *
 * @param {string} root
 * @returns {Promise<{ replaced: number, links: string[] }>}
 */
export async function dereferenceTree(root) {
  const { lstat, readlink, unlink, copyFile, stat } = await import("node:fs/promises");
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const links = [];

  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    links.push(path.join(entry.parentPath ?? root, entry.name));
  }

  for (const link of links) {
    const target = await readlink(link);
    const absolute = path.resolve(path.dirname(link), target);
    const info = await stat(absolute).catch(() => null);
    if (info === null) {
      throw new Error(`dangling symlink in engine tree: ${link} -> ${target}`);
    }
    if (!info.isFile()) {
      throw new Error(`symlink in engine tree points at a non-file: ${link} -> ${target}`);
    }
    await unlink(link);
    await copyFile(absolute, link);
  }

  return { replaced: links.length, links };
}

/** Keep node_modules/.bin from being walked into the lock. */
async function pruneBinDirectories(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  /** @type {string[]} */
  const remnants = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !NOT_SHIPPED.has(entry.name)) continue;
    remnants.push(path.join(entry.parentPath ?? root, entry.name));
  }
  for (const directory of remnants) await rm(directory, { recursive: true, force: true });
  return remnants.length;
}

/**
 * Round 1: everything up to and including the runtime lock.
 *
 * @param {{ skipInstall: boolean, skipFetch: boolean }} options
 * @returns {Promise<number>} exit code
 */
/**
 * Print a failure under one of the fixed prefixes, so the source of exit code 2
 * is readable from the log rather than only inferable.
 *
 * @param {string} prefix
 * @param {string} message
 */
function fail(prefix, message) {
  process.stderr.write(`${prefix}\n${message}\n`);
}

/**
 * Round 1: everything up to and including the runtime lock.
 *
 * `spawn` is a parameter so a missing prerequisite can be reached without
 * actually breaking the machine: the prefix this path writes is the only thing
 * that tells "install failed" from "the version is taken", and a branch nobody
 * can reach in a test is a branch nobody would notice going quiet.
 *
 * @param {{ skipInstall: boolean, skipFetch: boolean }} options
 * @param {(command: string, args: string[], cwd: string) => {status: number|null}} [spawn]
 * @returns {Promise<number>} exit code
 */
export async function roundOne(options, spawn = run) {
  if (!options.skipInstall) {
    const ok = step("install", () => spawn("pnpm", ["install", "--frozen-lockfile"], REPO_ROOT));
    if (!ok) {
      fail(ERROR_PREFIX.prerequisite, "pnpm install did not finish; nothing can be built on it.");
      return 2;
    }
  }

  const lockFile = path.join(DESKTOP_DIR, "runtime-lock.json");
  const engineDir = path.join(DESKTOP_DIR, "runtime", "engine");

  if (!options.skipFetch) {
    const ok = step("fetch engine", () =>
      spawn(
        process.execPath,
        ["scripts/engine/fetch-engine.mjs", "--out", ENGINE_ARTIFACT],
        REPO_ROOT,
      ),
    );
    if (!ok) {
      fail(ERROR_PREFIX.prerequisite, `could not fetch the engine into ${ENGINE_ARTIFACT}.`);
      return 2;
    }
  } else if (!existsSync(path.join(ENGINE_ARTIFACT, "package", "haruyuki.js"))) {
    fail(
      ERROR_PREFIX.prerequisite,
      `--skip-fetch was given but ${ENGINE_ARTIFACT} has no package to reuse.`,
    );
    return 2;
  }

  // electron@45 has no postinstall; the binary downloads on first require().
  // lock.mjs spawns electron.exe to read process.versions, so a fresh worktree
  // has no dist/ until something requires it. Doing it here keeps the promise
  // one command: nobody has to remember a fourth script.
  //
  // Skip when dist/ is already populated: the download is 234 MB and the
  // common case is a tree that has been installed once already.
  const electronDist = path.join(REPO_ROOT, "node_modules", "electron", "dist");
  if (!existsSync(electronDist)) {
    const okElectron = step("electron binary", () =>
      spawn(process.execPath, ["node_modules/electron/install.js"], REPO_ROOT),
    );
    if (!okElectron) {
      fail(ERROR_PREFIX.prerequisite, "the electron binary could not be downloaded.");
      return 2;
    }
  }

  const deref = await dereferenceTree(path.join(ENGINE_ARTIFACT, "package"));
  process.stdout.write(`\n==> dereference\n<== dereference ok (${deref.replaced} symlinks)\n`);

  const ok = step("stage runtime", () =>
    run(process.execPath, ["scripts/engine/stage-runtime.mjs"], REPO_ROOT),
  );
  if (!ok) return 1;

  const okLock = step("lock", () => run(process.execPath, ["scripts/engine/lock.mjs"], REPO_ROOT));
  if (!okLock) return 1;

  if (!existsSync(lockFile)) {
    process.stderr.write(`lock reported success but ${lockFile} is missing\n`);
    return 1;
  }

  process.stdout.write(`\nruntime tree  ${engineDir}\nruntime lock  ${lockFile}\n`);
  process.stdout.write("\nround 1 complete: the runtime tree and its lock are in place.\n");
  return 0;
}

/**
 * Every file electron-builder left in `release/`, found by reading the
 * directory rather than by assembling expected names.
 *
 * Names come from `artifactName` in the builder configuration, so an
 * implementation that builds them would keep working until somebody renames an
 * artifact and then quietly emit an empty list. Scanning cannot do that: its
 * worst case is listing too much, which is visible.
 *
 * @returns {Promise<{ file: string, bytes: number }[]>}
 */
export async function scanArtifacts(releaseDir) {
  if (!existsSync(releaseDir)) return [];

  const entries = await readdir(releaseDir, { recursive: true, withFileTypes: true });
  const artifacts = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath ?? releaseDir, entry.name);
    const relative = path.relative(releaseDir, absolute).split(path.sep).join("/");
    // `win-unpacked/` holds the files a user downloads, assembled. It is not
    // itself a download, so it stays out of the artifact list - but it does
    // have to be reported, because the artifact claim is about the tree as much
    // A listing that silently dropped it would make that criterion unjudgeable
    // from the manifest, which is the same defect this item exists to remove.
    if (relative.startsWith("win-unpacked/") || relative.startsWith("linux-unpacked/")) continue;
    // Files that are this pipeline's own output rather than its product. They
    // describe a build; they are never part of one. A second run in the same
    // directory finds yesterday's copies, and listing them would present stale
    // hashes as if they described what just shipped - while the manifest is
    // written after this list is read, so its output cannot be its input.
    if (isWrittenDocument(relative)) continue;
    const info = await stat(absolute);
    artifacts.push({ file: relative, bytes: info.size });
  }

  return artifacts.sort((left, right) => left.file.localeCompare(right.file));
}

/**
 * The unpacked trees, which are assembled output rather than downloads.
 *
 * Kept separate from the artifact list instead of dropped: the claim is about
 * "win-unpacked plus a zip", so a manifest that does not mention the tree
 * cannot be used to judge it.
 *
 * @param {string} releaseDir
 * @returns {Promise<string[]>} tree directory names that exist
 */
export async function scanTrees(releaseDir) {
  if (!existsSync(releaseDir)) return [];

  const entries = await readdir(releaseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-unpacked"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Round 2: package, then describe what was packaged.
 *
 * The build and package steps belong to the Windows and Linux work packages and
 * are not wired here yet. What is wired is the half that can be judged without
 * them: if artifacts are already sitting in `release/`, they get described
 * correctly, and when there are none the command says so instead of writing an
 * empty manifest that reads like success.
 *
 * @param {{ targets: ("win32"|"linux")[] }} options
 * @returns {Promise<number>} exit code
 */
/** Files that are neither a download nor attributable to a platform. */
const NOT_ARTIFACTS = new Set(["builder-debug.yml", "SHA256SUMS", "release-manifest.json"]);

/**
 * Is this file one of the builds's outputs rather than something it produced?
 *
 * The builder's own log and the two documents `manifest.mjs` writes are named
 * here so one list decides for both the printed summary and the manifest: they
 * are, by definition, never part of what a downloader receives from the
 * artifact list.
 *
 * @param {string} file
 * @returns {boolean}
 */
export function isWrittenDocument(file) {
  return file.startsWith("builder-") || NOT_ARTIFACTS.has(file);
}

/**
 * Is this process already inside the container that builds Linux?
 *
 * Detected by marker file, not by "am I on Linux" and not by asking Docker: the
 * image has no daemon inside it, so `docker info` fails there. A host check on
 * top of that would call a Linux workstation capable (it is not - the toolchain
 * lives in the image) and call the container incapable (it is the one place that
 * can), which is backwards in both directions.
 *
 * @param {(path: string) => boolean} [exists]
 * @returns {boolean}
 */
export function insideContainer(exists = existsSync) {
  return exists("/.dockerenv") || exists("/run/.containerenv");
}

/**
 * Can the Linux route run here: either we are in the container, or a container
 * can be started.
 *
 * Two separate failures, one answer: the `docker` command missing, and the
 * daemon not answering it. Both mean the Linux build cannot run from here, which
 * is what the caller needs to know. Which of the two it was is printed, not
 * returned, so the caller cannot accidentally treat one as recovery.
 *
 * @param {(command: string, args: string[], cwd: string) => {status: number|null}} [spawn]
 * @param {(path: string) => boolean} [exists]
 * @returns {boolean}
 */
export function containerAvailable(spawn = spawnProbe, exists = existsSync) {
  // Already inside: the work can be done right here, and no daemon is involved.
  if (insideContainer(exists)) return true;
  try {
    return spawn("docker", ["info"], REPO_ROOT).status === 0;
  } catch {
    return false;
  }
}

/**
 * The probe behind `containerAvailable`, bounded so a wedged daemon cannot stall
 * the command: a machine that takes a minute to say "no" is a machine that says
 * nothing useful.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{status: number|null}}
 */
function spawnProbe(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: "ignore",
    timeout: 20_000,
    shell: process.platform === "win32" && !/\.exe$/i.test(command),
  });
}

/**
 * What this command line can and cannot do here, decided before any work starts.
 *
 * Linux has one route in this item: the container. So "asked for Linux only, and
 * no container" is a single fact with a single answer - `3`, "the only requested
 * target cannot be done on this machine" - and it holds on every host platform,
 * because the host being Linux does not provide the toolchain the route needs.
 *
 * `3` is deliberately narrow. It is not "the build did not work": a container
 * that exists and then fails is a failure, `1`, and turning that into `3` would
 * tell the reader the machine was incapable when it was not. And it never
 * applies when another target was also requested - then the run has something
 * else to do, and its verdict is about what it did, not about what was missing.
 *
 * @param {{ targets: string[], linuxNotBuilt: string|null }} options
 * @param {{ available: boolean }} container
 * @returns {{code: number, message: string}|null} the refusal, or null to run
 */
export function targetDecision(options, container) {
  const linuxOnly = options.targets.length === 1 && options.targets[0] === "linux";
  if (!linuxOnly) return null;
  if (container.available) return null;

  // Nothing is attempted, so nothing can fail: `1` would report a build that
  // never started, and `2` would claim a bad command line. Only `3` says what
  // happened - this machine cannot produce the one target that was asked for.
  const stated =
    options.linuxNotBuilt === null
      ? ""
      : ` You also passed --linux-not-built=${options.linuxNotBuilt}; that explains a ` +
        `missing artifact from a run that happened, and this run cannot start one, ` +
        `so the reason is not recorded.`;

  return {
    code: 3,
    message:
      `--linux-only was requested, and the Linux build has no route here without a ` +
      `container: docker is not on PATH or its daemon does not answer. This is not a ` +
      `build failure - nothing was attempted. Install Docker and run again, or ask for ` +
      `both platforms (dropping --linux-only), which records Linux as ` +
      `skipped (not-required) instead.${stated}`,
  };
}

/**
 * The arguments `manifest.mjs` is called with, from what this run decided.
 *
 * The requested targets have to travel: without them the manifest cannot tell
 * "nobody asked for Linux" from "Linux was asked for and did not happen", and
 * it treats the first as the second - reporting a request-only run as if this
 * machine were incapable, and failing the whole command over it.
 *
 * @param {{ targets: string[], linuxNotBuilt: string | null }} options
 * @returns {string[]}
 */
export function manifestArgs(options) {
  const args = [`--targets=${options.targets.join(",")}`];
  if (options.linuxNotBuilt !== null) args.push(`--linux-not-built=${options.linuxNotBuilt}`);
  return args;
}

async function roundTwo(options) {
  const releaseDir = path.join(DESKTOP_DIR, "release");

  // Bundle first: `electron-builder` packages `dist/`, and a tree that was
  // never built packages an empty app.asar that only fails at launch.
  const okBuild = step("build", () => run("pnpm", ["build"], DESKTOP_DIR));
  if (!okBuild) return 1;

  // One invocation per requested platform. electron-builder takes `--win`/
  // `--linux` rather than a list, and passing neither means "host platform",
  // which is not what "both" means here.
  for (const target of options.targets) {
    const flag = target === "win32" ? "--win" : "--linux";
    const okPackage = step(`package ${target}`, () =>
      run(
        "npx",
        ["electron-builder", "--config", "electron-builder.config.cjs", flag, "--x64"],
        DESKTOP_DIR,
      ),
    );
    // A platform that was attempted and failed is a failure, and stopping here
    // keeps the manifest from claiming a build that did not finish.
    if (!okPackage) return 1;
  }

  const artifacts = await scanArtifacts(releaseDir);
  const trees = await scanTrees(releaseDir);

  if (artifacts.length === 0 && trees.length === 0) {
    process.stdout.write(
      "\nrelease/ is still empty after packaging. run with --skip-bundle to stop\n" +
        "after round 1, which is a complete claim on its own.\n",
    );
    // Not zero: this run promised artifacts by omitting --skip-bundle and did
    // not produce any. Writing an empty manifest would look like success.
    return 1;
  }

  // `manifest.mjs` is the single producer of both hash documents: it hashes the
  // real artifacts and writes SHA256SUMS and release-manifest.json together.
  // Writing a checksum file here as well would mean two producers of the same
  // table, and the second one would describe the first as an artifact - which
  // is why `scanArtifacts` never returns them.
  if (trees.length > 0) {
    process.stdout.write(`\n==> unpacked trees\n${trees.map((tree) => `  ${tree}/`).join("\n")}\n`);
  }

  process.stdout.write("\n==> artifacts\n");
  for (const artifact of artifacts) {
    process.stdout.write(`  ${artifact.file}  ${artifact.bytes} B\n`);
  }

  // The manifest needs the same reasons this run knows about, and it refuses to
  // invent one, so the platform states are handed over rather than re-derived.
  const args = ["apps/desktop/scripts/manifest.mjs", ...manifestArgs(options)];
  const okManifest = step("manifest", () => run(process.execPath, args, REPO_ROOT));
  if (!okManifest) return 1;

  return 0;
}

/**
 * The whole command.
 *
 * The guard and both rounds are parameters so the refusal can be judged without
 * a tag and without packaging anything: a check that can only be exercised by
 * mutating the repository is a check that stops being exercised.
 *
 * @param {string[]} argv
 * @param {{
 *   versionConflict?: () => Promise<{prefix: string, message: string}|null>,
 *   previousBuildNote?: () => Promise<{message: string}|{unreadable: string}|null>,
 *   container?: () => boolean,
 *   roundOne?: (options: object) => Promise<number>,
 *   roundTwo?: (options: object) => Promise<number>,
 *   stderr?: (text: string) => void,
 *   stdout?: (text: string) => void,
 * }} [deps]
 * @returns {Promise<number>} exit code
 */
export async function runPipeline(argv, deps = {}) {
  const stderr = deps.stderr ?? ((text) => process.stderr.write(text));
  const stdout = deps.stdout ?? ((text) => process.stdout.write(text));

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`${ERROR_PREFIX.usage}\n${error.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw error;
  }

  // Before any step, and therefore before `electron-builder` can leave a file in
  // release/: a refusal has to be cheap and has to leave no trace.
  const conflict = await (deps.versionConflict ?? versionConflict)();
  if (conflict !== null) {
    stderr(`${conflict.prefix}\n${conflict.message}\n`);
    return 2;
  }

  // Also before any step: whether this machine can produce the target at all is
  // a property of the machine, not of the build, and finding it out after a
  // twenty-minute runtime stage would be finding it out too late.
  const decision = targetDecision(options, {
    available: (deps.container ?? containerAvailable)(),
  });
  if (decision !== null) {
    stderr(`${ERROR_PREFIX.cannotBuild} ${decision.message}\n`);
    return decision.code;
  }

  // A leftover document for this same version is a warning, never a refusal:
  // the same command has to be re-runnable. It is named rather than silently
  // overwritten, because yesterday's checksums attached to today's package is
  // the one mistake a reader cannot detect from the files.
  const note = await (deps.previousBuildNote ?? previousBuildNote)();
  if (note !== null) {
    stderr(
      "unreadable" in note
        ? `warning: ${note.unreadable}; it will be overwritten by this run.\n`
        : `warning: ${note.message}\n`,
    );
  }

  const code = await (deps.roundOne ?? ((options) => roundOne(options)))(options);
  if (code !== 0) return code;

  if (options.skipBundle) return 0;

  return (deps.roundTwo ?? ((options) => roundTwo(options)))(options);
}

async function main() {
  return runPipeline(process.argv.slice(2));
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
