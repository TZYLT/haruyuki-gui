#!/usr/bin/env node
/**
 * manifest.mjs - describe one build: what was produced, from what, and how.
 *
 * `release-manifest.json` and `SHA256SUMS` say the same hashes in two formats:
 * one for people reading a Release page and one for `sha256sum -c`. Two
 * producers would eventually disagree, and the disagreement would be invisible
 * until a user's verification failed, so both come from this file and the
 * body table is parsed back out of the markdown before either is written.
 *
 * The manifest is judged as something a person can act on, not as a record:
 * the release body and the upload steps are part of it for that reason. A
 * document that lists hashes but not which files to attach leaves the reader to
 * decide, and that decision is the one thing it was meant to save them.
 *
 * Usage:
 *   node apps/desktop/scripts/manifest.mjs [--dirty] [--targets=win32,linux] [--linux-not-built=<reason>]
 *
 * Exit codes:
 *   0  a manifest was written and both hash tables agree
 *   1  a platform this run was asked for has no artifact and no reason was given
 *   2  the inputs cannot describe a build (no artifacts, bad reason)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NOT_BUILT_REASONS as NOT_BUILT_REASON_LIST,
  scanArtifacts,
  scanTrees,
} from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const MANIFEST_FILE = path.join(RELEASE_DIR, "release-manifest.json");
const CHECKSUMS_FILE = path.join(RELEASE_DIR, "SHA256SUMS");

/** Every platform this item knows how to build a package for. */
const PLATFORMS = ["win32", "linux"];

/** The only acceptable ways a platform can be absent, and why each exists. */
const NOT_BUILT_REASONS = new Set(NOT_BUILT_REASON_LIST);

/**
 * Linux images are recorded by digest, not by tag, so the build is repeatable.
 *
 * The shape is `docker:<image>:<digest>`, as the requirement spells it. A full
 * registry reference (`...@sha256:...`) says the same thing, but the judgement
 * looks for a docker prefix and a trailing digest, and the two spellings meant
 * the assertion could only ever hold on a platform the manifest does not build.
 * Written the way it is checked, with the registry host kept inside the image
 * part so the digest is still the last colon-separated segment.
 */
const LINUX_IMAGE_NAME = "docker.m.daocloud.io/library/node:24-bookworm-slim";
const LINUX_IMAGE_DIGEST = `docker:${LINUX_IMAGE_NAME}:sha256:5ba3c1ded6eada2ea16582327a87c672fb3889fca362ee3ac0d78ed742b583c0`;

/** @param {string} file */
async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** @param {string} args */
function git(args) {
  try {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  } catch {
    // A tree that is not a checkout cannot name its commit. That is a fact
    // about the build, and it belongs in the manifest rather than being
    // papered over with an invented hash.
    return "unknown";
  }
}

/**
 * Which platform an artifact belongs to, from its extension rather than from
 * the caller's intent: the file that exists is the authority on what it is.
 *
 * @param {string} file
 * @returns {"win32"|"linux"|null}
 */
export function platformOf(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".appimage") || lower.endsWith(".deb") || lower.endsWith(".rpm"))
    return "linux";
  if (lower.endsWith(".exe") || lower.endsWith(".msi")) return "win32";
  // The zip is ambiguous by extension alone, so the name breaks the tie. A zip
  // whose name says neither is left out rather than guessed at.
  if (lower.endsWith(".zip")) {
    if (lower.includes("win")) return "win32";
    if (lower.includes("linux")) return "linux";
  }
  return null;
}

/**
 * Render the hash table that goes into the release body.
 *
 * Deliberately byte-identical to `SHA256SUMS`: the same lines, so a reader can
 * compare one against the other without translating between formats.
 *
 * @param {{ file: string, sha256: string }[]} artifacts
 * @returns {string}
 */
export function hashTable(artifacts) {
  const width = Math.max(...artifacts.map((artifact) => artifact.file.length), 4);
  const rows = artifacts.map(
    (artifact) =>
      `| \`${artifact.file}\`${" ".repeat(Math.max(0, width - artifact.file.length))} | \`${artifact.sha256}\` |`,
  );
  return ["| 文件 | SHA-256 |", "|---|---|", ...rows].join("\n");
}

/**
 * Read the hash table back out of a finished release body.
 *
 * The notes are parsed from the text that would actually be pasted into GitHub,
 * not compared against the array they were rendered from: the claim a reader
 * cares about is about the markdown, and a rendering bug would keep an
 * array-to-array comparison green.
 *
 * @param {string} markdown
 * @returns {{ file: string, sha256: string }[]}
 */
export function parseHashTable(markdown) {
  const rows = [];
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/.exec(line.trim());
    if (match !== null) rows.push({ file: match[1], sha256: match[2] });
  }
  return rows;
}

/**
 * The files a user must attach to the Release.
 *
 * The two documents are on the list because a downloader needs something to
 * check the download against; leaving them off would describe an upload that
 * cannot be verified afterwards.
 *
 * @param {string[]} artifactFiles
 * @returns {string[]}
 */
export function uploadedFiles(artifactFiles) {
  return [...artifactFiles, ...WRITTEN_DOCUMENTS];
}

/**
 * How to publish this build, as the four things a person actually does.
 *
 * Written out rather than pointed at by name: a list that says "upload the
 * artifacts" leaves the reader to decide which files those are, and that
 * decision is exactly what this document exists to remove. The tag is created
 * locally and not pushed - publishing is the user's step, and a pipeline that
 * pushed would be doing it for them.
 *
 * @param {{ version: string, files: string[] }} input
 * @returns {string[]}
 */
export function uploadSteps({ version, files }) {
  const tag = `v${version}`;
  return [
    `git tag -a ${tag} -m "Haruyuki ${version}"（用户在本地建，不推送）`,
    `GitHub → Releases → Draft a new release → 选择 tag ${tag}`,
    `上传：${files.join("、")}`,
    "正文粘贴 releaseNotes",
  ];
}

/**
 * The file names an upload step list tells a person to attach.
 *
 * Read back from the rendered steps rather than taken from the array they were
 * rendered from, so a step list that names a file nobody produced is caught by
 * comparing two different sources instead of by trusting one.
 *
 * @param {string[]} steps
 * @returns {string[]}
 */
export function parseUploadedFiles(steps) {
  const line = steps.find((step) => step.startsWith("上传："));
  if (line === undefined) return [];
  return line
    .slice("上传：".length)
    .split("、")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** The two documents this script writes, which ride along with the artifacts. */
const WRITTEN_DOCUMENTS = ["SHA256SUMS", "release-manifest.json"];

/** Inputs that cannot describe a build. Not a failed build, so not exit 1. */
export class ManifestInconsistency extends Error {}

/**
 * The lines `SHA256SUMS` contains, from the artifacts alone.
 *
 * @param {{ file: string, sha256: string }[]} artifacts
 * @returns {string[]}
 */
export function checksumLines(artifacts) {
  return artifacts.map((artifact) => `${artifact.sha256}  ${artifact.file}`);
}

/**
 * Fail unless the rendered body lists exactly the files and digests in the
 * checksum file.
 *
 * The body is parsed back from the markdown a person would paste, never
 * compared against the array it was rendered from: that array agreeing with
 * itself is what a constant-true assertion looks like, and it stays green when
 * the rendering is wrong.
 *
 * @param {string} markdown
 * @param {string[]} lines
 */
export function assertSameHashes(markdown, lines) {
  const fromBody = parseHashTable(markdown).map((row) => `${row.sha256}  ${row.file}`);
  if (fromBody.join("\n") !== lines.join("\n")) {
    throw new ManifestInconsistency(
      `the release body and SHA256SUMS disagree\n` +
        `SHA256SUMS:\n${lines.join("\n")}\nrelease body:\n${fromBody.join("\n")}`,
    );
  }
}

/**
 * Fail unless every file the upload steps name is a file this build produced.
 *
 * The steps are the part a person follows literally, and a name in them that
 * nothing produces sends them hunting for a file after the build was already
 * declared successful.
 *
 * @param {string[]} steps
 * @param {string[]} produced
 */
export function assertUploadList(steps, produced) {
  const available = new Set(produced);
  const missing = parseUploadedFiles(steps).filter((file) => !available.has(file));
  if (missing.length > 0) {
    throw new ManifestInconsistency(
      `the upload steps name files this build did not produce: ${missing.join(", ")}`,
    );
  }
}

/**
 * Everything the manifest says, from the facts about one finished build.
 *
 * Pure on purpose: the two claims that can silently be false - the body table
 * matching `SHA256SUMS`, and the upload steps naming files that were produced -
 * can then be exercised without a packaged tree.
 *
 * @param {{
 *   packageJson: Record<string, unknown>,
 *   rootJson: Record<string, unknown>,
 *   described: { platform: string, file: string, bytes: number, sha256: string }[],
 *   trees: string[],
 *   platforms: Record<string, { state: string, builtIn?: string, reason?: string }>,
 *   engine: { version: string, source: unknown, lockSha256: string | null },
 *   commit: string,
 *   builtAt: string,
 *   dirty: boolean,
 * }} facts
 * @returns {{ checksumText: string, manifest: Record<string, unknown> }}
 */
export function buildDocuments(facts) {
  const version = String(facts.packageJson.version ?? "");
  if (version.length === 0) {
    // The version is the one thing users quote back at us, and it is the one
    // thing this script only reads. A blank one would render a tag of "v" and a
    // title of "Haruyuki ", both of which read like a real release.
    throw new ManifestInconsistency("apps/desktop/package.json has no version to release under");
  }
  const productName = String(facts.packageJson.productName ?? "Haruyuki");

  const lines = checksumLines(facts.described);
  const checksumText = `${lines.join("\n")}\n`;
  const notes = releaseNotes({
    productName,
    version,
    artifacts: facts.described,
    platforms: facts.platforms,
  });
  assertSameHashes(notes, lines);

  const files = uploadedFiles(facts.described.map((artifact) => artifact.file));
  const steps = uploadSteps({ version, files });
  assertUploadList(steps, files);

  const manifest = {
    manifestVersion: 1,
    appVersion: facts.packageJson.version,
    productName,
    builtAt: facts.builtAt,
    tag: `v${version}`,
    commit: facts.commit,
    dirty: facts.dirty,
    toolchain: {
      node: process.version,
      pnpm: facts.rootJson.packageManager ?? "unknown",
      electron: facts.rootJson.devDependencies?.electron ?? "unknown",
      electronBuilder: facts.rootJson.devDependencies?.["electron-builder"] ?? "unknown",
    },
    platforms: facts.platforms,
    artifacts: facts.described,
    trees: facts.trees,
    engine: facts.engine,
    releaseNotes: notes,
    uploadSteps: steps,
  };

  return { checksumText, manifest };
}

/**
 * The release body, as markdown a person will read before downloading.
 *
 * It carries the four things a reader cannot get from the asset names: what
 * this is, what to check the download against, which platforms it covers and
 * what has not been verified about them. The platform line is taken from the
 * recorded states rather than from "the artifacts present", so a platform that
 * was not built says so instead of quietly disappearing from the body.
 *
 * @param {{
 *   productName: string,
 *   version: string,
 *   artifacts: { file: string, bytes: number, sha256: string }[],
 *   platforms: Record<string, { state: string, builtIn?: string, reason?: string }>,
 * }} input
 * @returns {string}
 */
export function releaseNotes({ productName, version, artifacts, platforms }) {
  const totalMb = (
    artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0) /
    1024 /
    1024
  ).toFixed(1);
  const platformLines = Object.entries(platforms).map(([platform, value]) => {
    if (value.state === "built")
      return `- \`${platform}\`：已产出（${value.builtIn ?? "unknown"}）`;
    if (value.state === "not-built")
      return `- \`${platform}\`：本版无产物（${value.reason ?? "原因未记录"}）`;
    return `- \`${platform}\`：本版不需要（${value.reason ?? "not-required"}）`;
  });

  // Only listed where it can apply: a claim about Linux that no Linux artifact
  // exists to carry it would make the notes longer and truer of nothing. The
  // Windows entry stays unconditional, because every build is unsigned.
  const unverified = [
    "本包未签名：Windows 首次运行会被 SmartScreen 拦，需点「更多信息 → 仍要运行」。这是预期摩擦，不是故障。",
    "仅在打包机上换目录验证过启动，没有在另一台干净的 Windows 机器上验证过。",
  ];
  if (platforms.linux?.state === "built") {
    unverified.push(
      "Linux 侧只验到进程存活与产物可解，窗口是否真的画出来未验证（构建容器里没有截图工具）。",
    );
    unverified.push("Linux 侧双击运行未验证（构建容器里没有桌面环境与 FUSE）。");
  }

  return [
    `# ${productName} ${version}`,
    "",
    "产物来自同一份构建配置，两个平台的包挂在同一个 tag 下。",
    "",
    "## 校验下载",
    "",
    "下面这张表与随附的 `SHA256SUMS` 逐行相同，两处都能复算：",
    "Linux 用 `sha256sum -c SHA256SUMS`，Windows 用 `Get-FileHash` 逐行比对。",
    "",
    hashTable(artifacts),
    "",
    `合计 ${String(artifacts.length)} 个文件，约 ${totalMb} MiB。`,
    "",
    "## 平台",
    "",
    ...platformLines,
    "",
    "## 本版未验证项",
    "",
    ...unverified.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

/**
 * What each platform's entry should say, from what was produced and what was
 * asked for.
 *
 * The three-way split is the whole point, and the two absences are not
 * interchangeable: `skipped` means this run never tried ("nobody asked for
 * Linux"), `not-built` means it was asked for and this machine could not do it.
 * Recording the first as the second says "this box cannot build Linux" about a
 * run that was told not to - and the same confusion in the other direction makes
 * a real missing capability look like a choice.
 *
 * A platform that was asked for, produced nothing and carries no reason is
 * `unstated`, which the caller turns into a non-zero exit: inventing
 * `toolchain-missing` would be a claim about the machine that nothing checked.
 *
 * @param {{
 *   produced: string[],
 *   targets: string[],
 *   linuxNotBuilt: string | null,
 *   builtInOf: (platform: string) => string,
 * }} input
 * @returns {{states: Record<string, {state: string, builtIn?: string, reason?: string}>, unstated: string[]}}
 */
export function platformStates({ produced, targets, linuxNotBuilt, builtInOf }) {
  const states = {};
  const unstated = [];

  for (const platform of PLATFORMS) {
    if (produced.includes(platform)) {
      states[platform] = { state: "built", builtIn: builtInOf(platform) };
      continue;
    }
    if (!targets.includes(platform)) {
      // Not attempted, by request. Not a capability question at all.
      states[platform] = { state: "skipped", reason: "not-required" };
      continue;
    }
    if (platform === "linux" && linuxNotBuilt !== null) {
      states[platform] = { state: "not-built", reason: linuxNotBuilt };
      continue;
    }
    states[platform] = { state: "not-built", reason: "unstated" };
    unstated.push(platform);
  }

  return { states, unstated };
}

/**
 * What is wrong with this command line, if anything, as a sentence.
 *
 * Separate from `parseArgs` so it can be judged without exiting a process: a
 * guard only observable by spawning a child is a guard nobody writes a test for,
 * and this one exists because the pipeline refused a pair that this command
 * accepted and then silently dropped half of.
 *
 * @param {{ targets: string[], linuxNotBuilt: string | null }} options
 * @returns {string | null}
 */
export function argumentRefusalFor({ targets, linuxNotBuilt }) {
  if (linuxNotBuilt === null) return null;
  if (!NOT_BUILT_REASONS.has(linuxNotBuilt)) {
    return (
      `--linux-not-built=<reason> must be one of ${[...NOT_BUILT_REASONS].join(", ")}; ` +
      `"the image was built but will not start" is a failure, not a missing capability\n`
    );
  }
  if (targets.includes("linux")) return null;
  return (
    `--linux-not-built=${linuxNotBuilt} explains a platform this run was not asked to ` +
    `build. Drop the reason (a platform nobody asked for is recorded as skipped, not-required), ` +
    `or ask for linux in --targets.\n`
  );
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { dirty: false, linuxNotBuilt: null, targets: [...PLATFORMS] };

  for (const arg of argv) {
    if (arg === "--dirty") options.dirty = true;
    else if (arg.startsWith("--linux-not-built=")) {
      options.linuxNotBuilt = arg.slice("--linux-not-built=".length);
    } else if (arg.startsWith("--targets=")) {
      const listed = arg
        .slice("--targets=".length)
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const unknown = listed.filter((name) => !PLATFORMS.includes(name));
      if (listed.length === 0 || unknown.length > 0) {
        process.stderr.write(
          `--targets= must be a comma-separated list drawn from ${PLATFORMS.join(", ")}; ` +
            `got ${JSON.stringify(arg.slice("--targets=".length))}\n`,
        );
        process.exit(2);
      }
      options.targets = listed;
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: node apps/desktop/scripts/manifest.mjs [--dirty] [--targets=win32,linux] " +
          "[--linux-not-built=<reason>]\n" +
          `targets: ${PLATFORMS.join(", ")} (default: all of them)\n` +
          `reasons: ${[...NOT_BUILT_REASONS].join(", ")}\n`,
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }

  // A reason only means something for a platform this run was asked to build.
  // Without the second branch, `--targets=win32 --linux-not-built=...` wrote
  // `skipped(not-required)` and dropped the reason without a word: the caller
  // said why Linux is missing and the document said nobody asked.
  const refusal = argumentRefusalFor(options);
  if (refusal !== null) {
    process.stderr.write(refusal);
    process.exit(2);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  try {
    return await describeBuild(options);
  } catch (error) {
    if (error instanceof ManifestInconsistency) {
      process.stderr.write(`refusing to write: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

/**
 * What stops this run from writing a publishable manifest, if anything.
 *
 * Two independent reasons, both checked before a single byte is written, because
 * a document written and then declared invalid outlives the run that refused it.
 *
 * One: a platform this run was asked for, produced nothing and carries no
 * reason. Only requested platforms can land here - one nobody asked for is
 * `skipped`, which is an answer, not a gap.
 *
 * Two: an uncommitted tree. The requirement says a dirty package must not be
 * released and nothing enforced it, so the record was written and the steps to
 * publish it were written beside it. `--dirty` still produces the document for a
 * local build that must not be published; that is a decision someone made on
 * purpose, not a default.
 *
 * @param {{ unstated: string[], dirty: boolean, allowDirty: boolean }} facts
 * @returns {{ code: number, message: string } | null}
 */
export function refusalFor({ unstated, dirty, allowDirty }) {
  if (unstated.length > 0) {
    return {
      code: 1,
      message:
        `\nno artifact for ${unstated.join(", ")} and no reason given, although this run asked for it.\n` +
        `Pass --linux-not-built=<docker-unavailable|machine-offline|toolchain-missing> to say why,\n` +
        `or drop that platform from --targets. A manifest that invents a reason is worse than none.\n`,
    };
  }

  if (dirty && !allowDirty) {
    return {
      code: 1,
      message:
        `\nrefusing to write a publishable manifest: the working tree has uncommitted changes.\n` +
        `A version number has to identify exactly one tree, and this one cannot be reproduced from\n` +
        `any commit. Commit or stash the changes, or pass --dirty to describe a local build that\n` +
        `must not be published.\n`,
    };
  }

  return null;
}

/**
 * @param {{ dirty: boolean, linuxNotBuilt: string | null }} options
 * @returns {Promise<number>} exit code
 */
async function describeBuild(options) {
  if (!existsSync(RELEASE_DIR)) {
    process.stderr.write(`no ${RELEASE_DIR}: nothing was built\n`);
    return 2;
  }

  const scanned = await scanArtifacts(RELEASE_DIR);
  const described = [];

  for (const artifact of scanned) {
    const platform = platformOf(artifact.file);
    // Files that are neither a download nor attributable to a platform (the
    // builder's own debug output, a stale checksum file) stay out. The two
    // documents this script writes are outputs, not inputs: listing
    // SHA256SUMS would make the table describe itself, and listing the
    // manifest would let a second run hash a different manifest than the one
    // being described.
    if (platform === null) continue;
    if (artifact.file === "SHA256SUMS" || artifact.file === "release-manifest.json") continue;
    described.push({
      platform,
      file: artifact.file,
      bytes: artifact.bytes,
      sha256: await sha256Of(path.join(RELEASE_DIR, artifact.file)),
    });
  }

  if (described.length === 0) {
    process.stderr.write(
      "release/ holds no platform artifacts; a manifest would describe nothing\n",
    );
    return 2;
  }

  const trees = await scanTrees(RELEASE_DIR);
  const packageJson = JSON.parse(await readFile(path.join(DESKTOP_DIR, "package.json"), "utf8"));
  const rootJson = JSON.parse(await readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

  /** @type {Record<string, {state: string, builtIn?: string, reason?: string}>} */
  const produced = PLATFORMS.filter((platform) =>
    described.some((artifact) => artifact.platform === platform),
  );
  const { states: platforms, unstated } = platformStates({
    produced,
    targets: options.targets,
    linuxNotBuilt: options.linuxNotBuilt,
    builtInOf: (platform) =>
      platform === "win32"
        ? `win32-x64@${process.env["COMPUTERNAME"] ?? "unknown-host"}`
        : LINUX_IMAGE_DIGEST,
  });

  const lockFile = path.join(DESKTOP_DIR, "runtime-lock.json");
  const lockSha = existsSync(lockFile) ? await sha256Of(lockFile) : null;

  // The engine is not a package.json dependency, so its version cannot be read
  // from there. `runtime-lock.json` is what the packaged app itself checks at
  // start-up, which makes it the one place whose answer matches what shipped.
  let engineVersion = "unknown";
  let engineHonest = false;
  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(await readFile(lockFile, "utf8"));
      if (typeof lock.engineVersion === "string" && lock.engineVersion.length > 0) {
        engineVersion = lock.engineVersion;
        engineHonest = true;
      }
    } catch {
      // Unreadable lock: leave "unknown" and say so below rather than guess.
    }
  }

  const { checksumText, manifest } = buildDocuments({
    packageJson,
    rootJson,
    described,
    trees,
    platforms,
    engine: {
      version: engineVersion,
      // `source` is what the lock says it was built from, not what this script
      // assumes; "npm:haruyuki@<ver>" is the only kind fetch-engine produces.
      source: engineHonest ? { kind: "npm", spec: `haruyuki@${engineVersion}` } : null,
      lockSha256: lockSha,
    },
    commit: git(["rev-parse", "--short", "HEAD"]),
    builtAt: new Date().toISOString(),
    dirty: options.dirty || git(["status", "--porcelain"]).length > 0,
  });

  // Two things have to hold before anything is written, because a document that
  // is written and then declared invalid is worse than no document: `release/`
  // outlives this run, and the next reader has no way to tell a refused build's
  // leftovers from a published one.
  const refusal = refusalFor({ unstated, dirty: manifest.dirty, allowDirty: options.dirty });
  if (refusal !== null) {
    process.stderr.write(refusal.message);
    return refusal.code;
  }

  // The manifest is written first so it can be hashed, and only then does the
  // checksum file get its own line. The document does not carry its own digest,
  // so this is not circular: the file that a third party downloads and checks is
  // the one they most need a digest for, and it was the one line missing.
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(MANIFEST_FILE, manifestText, "utf8");

  const manifestSha = await sha256Of(MANIFEST_FILE);
  const selfLine = `${manifestSha}  ${path.basename(MANIFEST_FILE)}`;
  await writeFile(
    CHECKSUMS_FILE,
    `${[...checksumText.trimEnd().split("\n"), selfLine].join("\n")}\n`,
    "utf8",
  );

  process.stdout.write(`\nplatforms\n`);
  for (const [name, state] of Object.entries(platforms)) {
    process.stdout.write(`  ${name}  ${JSON.stringify(state)}\n`);
  }
  process.stdout.write(`\nartifacts\n`);
  for (const artifact of described) {
    process.stdout.write(
      `  ${artifact.file}  ${String(artifact.bytes)} B  ${artifact.sha256.slice(0, 16)}…\n`,
    );
  }
  process.stdout.write(`\nwrote ${path.relative(REPO_ROOT, MANIFEST_FILE)}\n`);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, CHECKSUMS_FILE)}\n`);
  process.stdout.write(`\nupload\n`);
  for (const line of manifest.uploadSteps) process.stdout.write(`  ${line}\n`);

  return 0;
}

// Only when run as a command: importing this file must not write anything.
// The tests import its functions, and a module that rewrites `release/` on
// import makes every test run a small, unnoticed release.
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
