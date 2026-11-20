#!/usr/bin/env node
/**
 * scan-history.mjs - count private references that survive in the commit history.
 *
 * The working tree is checked by `check-forbidden-literals.mjs`, but a published
 * repository also publishes every earlier version of every file. A rewrite aims to
 * remove those too, and a rewrite that cannot be measured cannot be reported: this
 * script walks every unique blob reachable from any ref, counts the same families
 * the gate counts, and prints where they are.
 *
 * Usage:
 *   node scripts/docs/scan-history.mjs [--root <dir>] [--json] [--samples <n>]
 *
 * Exit codes: 0 the scan completed (finding references is not an error: the
 * numbers are the output), 2 the scan could not run.
 */

import { execFileSync } from "node:child_process";

const USAGE = `scan-history - count private references left in the git history

Usage:
  node scripts/docs/scan-history.mjs [--root <dir>] [--json] [--samples <n>]

--root <dir>    repository to inspect (default: current directory)
--json          print one JSON object instead of the human summary
--samples <n>   how many example locations to print (default 10)

Exit codes: 0 scan completed, 2 the scan could not run.
`;

/**
 * The families counted, in the same order the working-tree gate uses.
 *
 * Written as patterns rather than examples so the gate does not fire on this file.
 */
const FAMILIES = [
  ["document path", /docs\/\d+/],
  ["document number", /《\d+》/],
  ["invariant", /\bINV-\d+\b/],
  ["event or decision", /\b[ER]-\d{3}\b/],
  ["frozen surface", /\bFZ-\d+\b/],
  ["work item", /\b[VWD]-\d{1,2}[a-z]?\b/],
  ["review finding", /\bB\d-[A-Z]\d+\b/],
  ["bare section", /\b\d{2}\s*§/],
];

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

const argv = process.argv.slice(2);
const rootIndex = argv.indexOf("--root");
const samplesIndex = argv.indexOf("--samples");
const asJson = argv.includes("--json");

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

const root = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
const sampleLimit = samplesIndex === -1 ? 10 : Number.parseInt(argv[samplesIndex + 1] ?? "10", 10);

/**
 * Run a git command in the repository.
 *
 * @param {string[]} args
 * @returns {string}
 */
function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

let objects;
try {
  objects = git(["rev-list", "--objects", "--all"]);
} catch (error) {
  console.error(`ERROR: cannot read the object list: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

/** @type {Map<string, string>} blob sha -> an example path */
const blobs = new Map();

for (const line of objects.split("\n")) {
  if (line.length === 0) continue;
  const space = line.indexOf(" ");
  if (space === -1) continue;
  const sha = line.slice(0, space);
  const file = line.slice(space + 1);
  if (!SOURCE.test(file)) continue;
  if (!blobs.has(sha)) blobs.set(sha, file);
}

const shas = [...blobs.keys()];
let batch;

try {
  batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${shas.join("\n")}\n`,
    maxBuffer: 512 * 1024 * 1024,
  });
} catch (error) {
  console.error(`ERROR: cannot read blob contents: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const counts = new Map(FAMILIES.map(([name]) => [name, 0]));
const locations = [];
let index = 0;
let offset = 0;
let lines = 0;

while (index < shas.length && offset < batch.length) {
  const headerEnd = batch.indexOf(10, offset);
  if (headerEnd === -1) break;
  const header = batch.subarray(offset, headerEnd).toString("utf8");
  const size = Number.parseInt(header.split(" ")[2] ?? "0", 10);
  const start = headerEnd + 1;
  const content = batch.subarray(start, start + size).toString("utf8");
  offset = start + size + 1;
  index += 1;

  for (const [lineNumber, line] of content.split("\n").entries()) {
    let hit = false;
    for (const [name, pattern] of FAMILIES) {
      if (!pattern.test(line)) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      hit = true;
    }
    if (hit) {
      lines += 1;
      if (locations.length < sampleLimit) {
        locations.push(`${blobs.get(shas[index - 1]) ?? "?"}:${String(lineNumber + 1)}`);
      }
    }
  }
}

const total = [...counts.values()].reduce((sum, count) => sum + count, 0);

if (asJson) {
  console.log(
    JSON.stringify({ blobs: shas.length, lines, byFamily: Object.fromEntries(counts), total, samples: locations }),
  );
} else {
  console.log(`scan-history: ${String(shas.length)} unique source blob(s) reachable from all refs`);
  for (const [name, count] of counts) {
    console.log(`  ${name.padEnd(18)} ${String(count)}`);
  }
  console.log(`  ${"lines".padEnd(18)} ${String(lines)}`);
  console.log(`  ${"total references".padEnd(18)} ${String(total)}`);
  for (const location of locations) console.log(`  sample ${location}`);
}
