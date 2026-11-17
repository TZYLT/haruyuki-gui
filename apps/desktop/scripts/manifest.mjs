#!/usr/bin/env node
/**
 * manifest.mjs - describe one build: what was produced, from what, and how.
 *
 * `release-manifest.json` and `SHA256SUMS` say the same hashes in two formats:
 * one for people reading a Release page and one for `sha256sum -c`. Two
 * producers would eventually disagree, and the disagreement would be invisible
 * until a user's verification failed, so both come from this file and the
 * checksum table is asserted to equal the body table before either is written.
 *
 * Usage:
 *   node apps/desktop/scripts/manifest.mjs [--dirty] [--linux-not-built=<reason>]
 *
 * Exit codes:
 *   0  a manifest was written and both hash tables agree
 *   2  the inputs cannot describe a build (no artifacts, bad reason)
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanArtifacts, scanTrees } from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "..", "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const MANIFEST_FILE = path.join(RELEASE_DIR, "release-manifest.json");
const CHECKSUMS_FILE = path.join(RELEASE_DIR, "SHA256SUMS");

/** The only acceptable ways a platform can be absent, and why each exists. */
const NOT_BUILT_REASONS = new Set(["docker-unavailable", "machine-offline", "toolchain-missing"]);

/** Linux images are recorded by digest, not by tag, so the build is repeatable. */
const LINUX_IMAGE_DIGEST =
  "docker.m.daocloud.io/library/node:24-bookworm-slim@sha256:5ba3c1ded6eada2ea16582327a87c672fb3889fca362ee3ac0d78ed742b583c0";

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

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = { dirty: false, linuxNotBuilt: null };

  for (const arg of argv) {
    if (arg === "--dirty") options.dirty = true;
    else if (arg.startsWith("--linux-not-built=")) {
      options.linuxNotBuilt = arg.slice("--linux-not-built=".length);
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: node apps/desktop/scripts/manifest.mjs [--dirty] [--linux-not-built=<reason>]\n" +
          `reasons: ${[...NOT_BUILT_REASONS].join(", ")}\n`,
      );
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }

  if (options.linuxNotBuilt !== null && !NOT_BUILT_REASONS.has(options.linuxNotBuilt)) {
    process.stderr.write(
      `--linux-not-built=<reason> must be one of ${[...NOT_BUILT_REASONS].join(", ")}; ` +
        `"the image was built but will not start" is a failure, not a missing capability\n`,
    );
    process.exit(2);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(RELEASE_DIR)) {
    process.stderr.write(`no ${RELEASE_DIR}: nothing was built\n`);
    return 2;
  }

  const scanned = await scanArtifacts(RELEASE_DIR);
  const described = [];

  for (const artifact of scanned) {
    const platform = platformOf(artifact.file);
    // Files that are neither a download nor attributable to a platform (the
    // builder's own debug output, a stale checksum file) stay out.
    if (platform === null) continue;
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
  const platforms = {};
  for (const platform of ["win32", "linux"]) {
    const produced = described.some((artifact) => artifact.platform === platform);
    if (produced) {
      platforms[platform] = {
        state: "built",
        builtIn:
          platform === "win32"
            ? `win32-x64@${process.env["COMPUTERNAME"] ?? "unknown-host"}`
            : LINUX_IMAGE_DIGEST,
      };
    } else if (platform === "linux" && options.linuxNotBuilt !== null) {
      platforms[platform] = { state: "not-built", reason: options.linuxNotBuilt };
    } else if (platform === "linux" && options.linuxNotBuilt === null) {
      // No Linux artifact and nobody said why. The honest entry is "unknown
      // reason", not an invented one: `toolchain-missing` would be a claim
      // about this machine that this script never checked, and `skipped` would
      // turn a missing capability into a decision. Exit non-zero below so the
      // caller has to say which it was.
      platforms[platform] = { state: "not-built", reason: "unstated" };
    } else {
      platforms[platform] = { state: "not-built", reason: "toolchain-missing" };
    }
  }

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

  const checksumLines = described.map((artifact) => `${artifact.sha256}  ${artifact.file}`);
  const checksumText = `${checksumLines.join("\n")}\n`;
  const bodyTable = hashTable(described);

  // The assertion this file exists for: two formats, one set of hashes.
  const fromBody = described.map((artifact) => `${artifact.sha256}  ${artifact.file}`).join("\n");
  if (fromBody !== checksumLines.join("\n")) {
    process.stderr.write("internal: the release-body table and SHA256SUMS disagree\n");
    return 2;
  }

  const manifest = {
    manifestVersion: 1,
    appVersion: packageJson.version,
    productName: packageJson.productName ?? "Haruyuki",
    builtAt: new Date().toISOString(),
    tag: `v${String(packageJson.version)}`,
    commit: git(["rev-parse", "--short", "HEAD"]),
    dirty: options.dirty || git(["status", "--porcelain"]).length > 0,
    toolchain: {
      node: process.version,
      pnpm: rootJson.packageManager ?? "unknown",
      electron: rootJson.devDependencies?.electron ?? "unknown",
      electronBuilder: rootJson.devDependencies?.["electron-builder"] ?? "unknown",
    },
    platforms,
    artifacts: described,
    trees,
    engine: {
      version: engineVersion,
      // `source` is what the lock says it was built from, not what this script
      // assumes; "npm:haruyuki@<ver>" is the only kind fetch-engine produces.
      source: engineHonest ? { kind: "npm", spec: `haruyuki@${engineVersion}` } : null,
      lockSha256: lockSha,
    },
    releaseNotes: `Haruyuki ${String(packageJson.version)}\n\n${bodyTable}\n`,
  };

  await writeFile(CHECKSUMS_FILE, checksumText, "utf8");
  await writeFile(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

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

  const unstated = Object.entries(platforms).filter(([, value]) => value.reason === "unstated");
  if (unstated.length > 0) {
    process.stderr.write(
      `\nno artifact for ${unstated.map(([name]) => name).join(", ")} and no reason given.\n` +
        `Pass --linux-not-built=<docker-unavailable|machine-offline|toolchain-missing> to say why,\n` +
        `or build that platform. A manifest that invents a reason is worse than none.\n`,
    );
    return 1;
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
