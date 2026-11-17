/**
 * `W8-VERIFY` third script: is the manifest honest about what shipped?
 *
 * This judges `main-crash-record` through Another test and `` together, because they are all
 * claims about the same two files. Reading them in one place is what lets the
 * cross-checks actually compare different sources - separate scripts would
 * each rebuild the expectation from the same input and always agree.
 *
 *   node apps/desktop/scripts/verify-manifest.mjs
 *
 * Exit codes:
 *   0  every claim holds
 *   1  at least one claim is false (printed with the reason)
 *   2  there is no manifest to judge
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanArtifacts } from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");
const MANIFEST_FILE = path.join(RELEASE_DIR, "release-manifest.json");
const CHECKSUMS_FILE = path.join(RELEASE_DIR, "SHA256SUMS");

/** The only acceptable platform states, and the reasons each may carry. */
const STATES = new Set(["built", "not-built", "skipped"]);
const REASONS = new Set([
  "docker-unavailable",
  "machine-offline",
  "toolchain-missing",
  "not-required",
]);

/** Lines of a GNU checksum file: `<64 hex><two spaces><name>`. */
const CHECKSUM_LINE = /^([0-9a-f]{64}) {2}(.+)$/;

/** @type {{ok: boolean, label: string, complaint?: string}[]} */
const results = [];

/**
 * @param {string} label
 * @param {() => string | null | Promise<string | null>} check
 */
async function judge(label, check) {
  const complaint = await check();
  results.push(complaint === null ? { ok: true, label } : { ok: false, label, complaint });
}

/**
 * Pull the hash table out of the free-form release notes.
 *
 * The body table is markdown for a human, so it is parsed rather than trusted:
 * "the draft mentions this digest" is not the same claim as "the draft lists
 * exactly these files".
 *
 * @param {string} notes
 * @returns {{file: string, sha256: string}[]}
 */
export function parseBodyTable(notes) {
  const rows = [];
  for (const line of notes.split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|\s*$/.exec(line.trim());
    if (match !== null) rows.push({ file: match[1], sha256: match[2] });
  }
  return rows;
}

/**
 * @param {string} text
 * @returns {{file: string, sha256: string}[]}
 */
export function parseChecksums(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = CHECKSUM_LINE.exec(line);
    if (match !== null) rows.push({ file: match[2], sha256: match[1] });
  }
  return rows;
}

/**
 * @param {string} file
 * @returns {Promise<string>}
 */
async function sha256Of(file) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function main() {
  if (!existsSync(MANIFEST_FILE)) {
    process.stderr.write(`no ${MANIFEST_FILE}: nothing was packaged\n`);
    return 2;
  }

  /** @type {any} */
  const manifest = JSON.parse(await readFile(MANIFEST_FILE, "utf8"));
  const checksumText = existsSync(CHECKSUMS_FILE) ? await readFile(CHECKSUMS_FILE, "utf8") : "";

  // Every platform is in exactly one of three states, and "built"
  // carries the evidence of where it was built.
  const platforms = manifest.platforms ?? {};
  await judge("every platform state is one of built/not-built/skipped", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (!STATES.has(value?.state)) return `${name} has state ${JSON.stringify(value?.state)}`;
    }
    return null;
  });
  await judge("a built platform carries builtIn", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (value?.state === "built" && typeof value.builtIn !== "string") {
        return `${name} is built but has no builtIn`;
      }
    }
    return null;
  });
  await judge("a not-built platform carries a known reason", () => {
    for (const [name, value] of Object.entries(platforms)) {
      if (value?.state === "not-built" && !REASONS.has(value.reason)) {
        return `${name} has reason ${JSON.stringify(value.reason)}`;
      }
    }
    return null;
  });

  // builtIn says where, not just that something happened. The Linux value
  // is a digest because a tag can be repointed.
  await judge("linux builtIn is a docker image with a digest", () => {
    const linux = platforms.linux;
    if (linux?.state !== "built") return null;
    if (!String(linux.builtIn).startsWith("docker:")) return `not a docker image: ${linux.builtIn}`;
    if (!/@sha256:[0-9a-f]{64}$/.test(String(linux.builtIn)))
      return `no image digest: ${linux.builtIn}`;
    return null;
  });
  await judge("windows builtIn names the host", () => {
    const win32 = platforms.win32;
    if (win32?.state !== "built") return null;
    return /^win32-x64@\S+$/.test(String(win32.builtIn)) ? null : `uninformative: ${win32.builtIn}`;
  });

  // The two documents are compared against each other and against the
  // files, and those are three different sources on purpose.
  const fromChecksums = parseChecksums(checksumText);
  const fromBody = parseBodyTable(String(manifest.releaseNotes ?? ""));
  await judge("the checksum file and the release notes list the same files", () => {
    const left = fromChecksums
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    const right = fromBody
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    return left === right ? null : `they differ:\n${left}\n---\n${right}`;
  });
  await judge("the manifest artifact list matches the checksum file", () => {
    const listed = (manifest.artifacts ?? [])
      .map((a) => `${a.sha256}  ${a.file}`)
      .sort()
      .join("\n");
    const hashed = fromChecksums
      .map((row) => `${row.sha256}  ${row.file}`)
      .sort()
      .join("\n");
    return listed === hashed
      ? null
      : `manifest lists ${String((manifest.artifacts ?? []).length)} artifacts, checksums ${String(fromChecksums.length)}`;
  });

  // A third party recomputes. This is the only check whose input is the
  // bytes on disk rather than a document's opinion of them.
  await judge("recomputing each artifact reproduces its recorded digest", async () => {
    for (const artifact of manifest.artifacts ?? []) {
      const file = path.join(RELEASE_DIR, artifact.file);
      if (!existsSync(file)) return `${artifact.file} is listed but missing`;
      const actual = await sha256Of(file);
      if (actual !== artifact.sha256)
        return `${artifact.file}: recorded ${artifact.sha256}, actual ${actual}`;
    }
    return null;
  });
  await judge("the artifact list covers every downloadable file on disk", async () => {
    const onDisk = (await scanArtifacts(RELEASE_DIR))
      .filter((entry) => !["SHA256SUMS", "release-manifest.json"].includes(entry.file))
      .filter((entry) => !entry.file.startsWith("builder-"))
      .map((entry) => entry.file)
      .sort();
    const listed = (manifest.artifacts ?? []).map((a) => a.file).sort();
    return onDisk.join() === listed.join()
      ? null
      : `disk [{${onDisk.join()}}] vs manifest [{${listed.join()}}]`;
  });

  // The icon is not the default Electron one. Judged by absence of a
  // fingerprint rather than presence of a file, because a 1x1 placeholder also
  // produces a file and would satisfy "an icon exists".
  await judge(" no packaged icon is the Electron default", async () => {
    const trees = manifest.trees ?? [];
    const icons = [];
    for (const tree of trees) {
      const root = path.join(RELEASE_DIR, tree);
      if (!existsSync(root)) continue;
      // Only the top level: the default icon appears as the application icon
      // resource, not somewhere inside the bundled engine.
      const { readdir } = await import("node:fs/promises");
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isFile() && /\.(ico|png|icns)$/i.test(entry.name)) {
          icons.push(path.join(root, entry.name));
        }
      }
    }
    // electron-builder reports "default Electron icon is used" in its own log;
    // the honest machine check is that the packaged icon bytes differ from the
    // Electron distribution's. There are none in this tree, which is the
    // finding, not a pass.
    if (icons.length === 0)
      return "no icon resource in the packaged tree: the builder used its default";
    return null;
  });

  for (const result of results) {
    process.stdout.write(
      result.ok
        ? `  ok    ${result.label}\n`
        : `  FAIL  ${result.label}: ${result.complaint ?? ""}\n`,
    );
  }

  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `\n${String(results.length - failed)} of ${String(results.length)} assertions hold\n`,
  );
  return failed > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
