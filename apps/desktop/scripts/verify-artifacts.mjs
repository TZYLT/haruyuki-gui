/**
 * `W8-VERIFY` second script: did packaging produce what a user downloads?
 *
 * This judge is deliberately separate from the round-one judge. Round one proves
 * judge. Round one proves the runtime tree and its lock exist; that is a
 * different claim from "there is an archive and an unpacked tree", and one
 * green does not imply the other. Collapsing them is the defect this item
 * exists to remove, so the two have two judges and two exit codes.
 *
 *   node apps/desktop/scripts/verify-artifacts.mjs
 *
 * Exit codes mirror release.mjs:
 *
 *   0  an unpacked tree and at least one archive are both present
 *   1  something a target platform was supposed to produce is missing
 *   2  the release directory does not exist (packaging never ran)
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanArtifacts, scanTrees } from "./release.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");

/** File extensions a user can actually download. */
const DOWNLOADABLE = [".zip", ".AppImage", ".tar.gz", ".dmg", ".exe"];

/**
 * One named judgement, so a failure says which claim is false.
 *
 * @param {string} label
 * @param {() => string | null} check returns a complaint, or null when it holds
 * @returns {boolean}
 */
function judge(label, check) {
  const complaint = check();
  if (complaint === null) {
    process.stdout.write(`  ok    ${label}\n`);
    return true;
  }
  process.stdout.write(`  FAIL  ${label}: ${complaint}\n`);
  return false;
}

async function main() {
  const releaseDir = path.join(DESKTOP_DIR, "release");

  if (!existsSync(releaseDir)) {
    process.stderr.write(`no ${releaseDir}: packaging has not run\n`);
    // Not a failed judgement: there is nothing to judge yet, and saying
    // "failed" would be indistinguishable from "the archive is broken".
    return 2;
  }

  const artifacts = await scanArtifacts(releaseDir);
  const trees = await scanTrees(releaseDir);
  const downloads = artifacts.filter((artifact) =>
    DOWNLOADABLE.some((extension) => artifact.file.endsWith(extension)),
  );

  process.stdout.write(`\nrelease directory ${releaseDir}\n`);
  for (const tree of trees) process.stdout.write(`  tree      ${tree}/\n`);
  for (const artifact of artifacts) {
    process.stdout.write(`  artifact  ${artifact.file}  ${artifact.bytes} B\n`);
  }
  process.stdout.write("\n");

  const checks = [
    judge("an unpacked tree exists", () =>
      trees.length > 0 ? null : "no *-unpacked directory; that is what the smoke test launches",
    ),
    judge("at least one downloadable archive exists", () =>
      downloads.length > 0
        ? null
        : `found ${String(artifacts.length)} file(s) but none of ${DOWNLOADABLE.join(", ")}`,
    ),
    judge("every downloadable archive is non-empty", () => {
      const empty = downloads.filter((artifact) => artifact.bytes === 0);
      return empty.length === 0 ? null : `${empty.map((item) => item.file).join(", ")} is 0 bytes`;
    }),
    judge("no artifact is a builder debug file", () => {
      const debugging = artifacts.filter((artifact) => artifact.file.startsWith("builder-"));
      return debugging.length === 0
        ? null
        : `${debugging.map((item) => item.file).join(", ")} leaked into the download list`;
    }),
  ];

  const failed = checks.filter((ok) => !ok).length;
  if (failed > 0) {
    process.stderr.write(`\n${String(failed)} of ${String(checks.length)} assertions failed\n`);
    return 1;
  }

  process.stdout.write(
    `\nall ${String(checks.length)} assertions hold: there is something to download\n`,
  );
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
