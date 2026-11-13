#!/usr/bin/env node
/**
 * check-contract.mjs - the `verify` gate for the contract segment.
 *
 * This file is a wrapper, not a check. The verdict comes from
 * `checkMap()` in `./contract/map.mjs`, which compares the committed
 * artifact against a fresh generation from the two truth sources and runs the
 * six capability-table rules plus the coverage closure and the health flags.
 *
 * Contract (route doc 08 section 3.4c, gate-cli shared contract):
 *
 *   Usage
 *     node scripts/check-contract.mjs               # scan the current repository
 *     node scripts/check-contract.mjs --root <dir>  # scan another tree (self-tests only)
 *     node scripts/check-contract.mjs --verbose     # warnings and a summary on stderr
 *
 *   Output
 *     `<file>:<line> <rule> <message>` per violation, English, single line, posix
 *     paths relative to the scanned root. Rule ids: `contract-map`,
 *     `contract-stale`, `contract-cover`, `contract-health`.
 *
 *   Exit codes (exactly three)
 *     0 = the artifact is consistent with the truth sources, the capability
 *         table is valid and the coverage closure holds; warnings alone never
 *         fail the gate.
 *     1 = at least one error-level violation (a hand-edited or missing artifact,
 *         a broken capability entry, a coverage mismatch, a degraded snapshot).
 *     2 = the script itself is broken: unreadable truth source, unparsable JSON,
 *         bad argument, I/O error.
 *
 * Severity is the one trap `checkMap()` sets up: `checkMap().violations` also carries
 * warnings (`coarse` entries, a name-level-only map is still usable). Handing
 * that list straight to `finish()` would turn the one real coarse entry into a
 * red `verify`, so only `severity === "error"` reaches the gate verdict here.
 *
 * Reuse
 *   `collectContractViolations({ root })` is exported as a pure function so the
 *   Lead can call it from `cli.mjs`'s `check` subcommand instead of duplicating
 *   the same rules. The top-level `runGate()` call is guarded by an entry-point
 *   check, so importing this module from another script has no side effects.
 *
 * `--root` support is inherited from `./lib/gate-cli.mjs` and exists for the
 * fixture self-tests in `scripts/contract-gate.test.ts`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGate, toPosix } from "./lib/gate-cli.mjs";
import { CAPABILITIES_FILE, MAP_FILE, SNAPSHOT_FILE, checkMap } from "./contract/map.mjs";

/**
 * Every file the contract gate may point a violation at, as repo-relative posix
 * paths (relative to the scanned root).
 *
 * `map-checks.mjs` emits a mix of these constants and absolute paths resolved
 * from the arguments it receives; normalizing both to the scanned root keeps
 * the gate output identical for the real repository and for a `--root` fixture.
 */
const ARTIFACT_FILES = Object.freeze([SNAPSHOT_FILE, CAPABILITIES_FILE, MAP_FILE]);

/**
 * Resolve one repo-relative posix path against the scanned root.
 *
 * @param {string} root Absolute posix root.
 * @param {string} relative Repo-relative posix path.
 * @returns {string}
 */
function resolveInRoot(root, relative) {
  return path.posix.join(root, ...relative.split("/"));
}

/**
 * Rewrite a violation file to a path relative to the scanned root.
 *
 * `map-checks.mjs` uses repo-relative constants for capability and health
 * violations but `displayPath()` for the artifact, which is relative to the
 * real repository. Both forms end with the same three known paths, so the
 * suffix decides the normalized form; anything else keeps its own shape.
 *
 * @param {string} file Violation file as reported by `checkMap`.
 * @param {string} root Absolute posix scan root.
 * @returns {string}
 */
function normalizeFile(file, root) {
  const posix = toPosix(file);

  for (const relative of ARTIFACT_FILES) {
    if (posix === relative || posix.endsWith(`/${relative}`)) {
      return relative;
    }
  }

  if (path.posix.isAbsolute(posix)) {
    const relativeToRoot = toPosix(path.posix.relative(root, posix));

    if (relativeToRoot !== "" && !relativeToRoot.startsWith("..")) {
      return relativeToRoot;
    }
  }

  return posix;
}

/**
 * Line a `contract-stale` violation points at, or `undefined`.
 *
 * `checkMap()` reaches the first differing line through its own comparison and
 * names it inside the message; lifting that number into the `<file>:<line>`
 * prefix keeps the gate output line-scoped without duplicating the comparison.
 *
 * @param {{ code?: string, message: string }} entry
 * @returns {number | undefined}
 */
function staleLineOf(entry) {
  if (entry.code !== "stale-artifact") {
    return undefined;
  }

  const match = /at line (\d+)/.exec(entry.message);

  return match === null ? undefined : Number(match[1]);
}

/**
 * Run the contract checks for one tree and return the error-level violations.
 *
 * Pure: reads the three contract files, never writes, never calls `process.exit`.
 * Throws when a truth source is missing, unreadable or not JSON - that is the
 * script's own failure (exit code 2), never a violation.
 *
 * @param {{ root?: string, verbose?: boolean }} [options]
 * @returns {import("./lib/gate-cli.mjs").Violation[]}
 */
export function collectContractViolations({ root = process.cwd(), verbose = false } = {}) {
  const scanRoot = toPosix(path.resolve(root));
  const result = checkMap({
    snapshotPath: resolveInRoot(scanRoot, SNAPSHOT_FILE),
    capabilitiesPath: resolveInRoot(scanRoot, CAPABILITIES_FILE),
    generatedPath: resolveInRoot(scanRoot, MAP_FILE),
  });

  const errors = result.violations.filter((entry) => entry.severity === "error");
  const warnings = result.violations.filter((entry) => entry.severity !== "error");

  if (verbose) {
    console.error(
      `contract: ${result.summary.capabilities} capability entries ` +
        `(${result.summary.detail} detail, ${result.summary.pending} pending), ` +
        `${result.summary.fieldLevel} field-level commands, ` +
        `${result.summary.errors} error(s), ${result.summary.warnings} warning(s)`,
    );

    for (const warning of warnings) {
      console.error(`warning: ${warning.rule} ${warning.message}`);
    }
  }

  return errors.map((entry) => {
    /** @type {import("./lib/gate-cli.mjs").Violation} */
    const violation = {
      file: normalizeFile(entry.file, scanRoot),
      rule: entry.rule,
      message: entry.message,
    };
    const line = Number.isInteger(entry.line) ? entry.line : staleLineOf(entry);

    if (line !== undefined) {
      violation.line = line;
    }

    return violation;
  });
}

/** True when this module is the spawned entry point, false when imported. */
const isEntryPoint =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntryPoint) {
  await runGate(
    /**
     * @param {{ root: string, flags: Record<string, boolean> }} args
     * @returns {import("./lib/gate-cli.mjs").Violation[]}
     */
    ({ root, flags }) => collectContractViolations({ root, verbose: flags.verbose === true }),
    { flags: ["verbose"] },
  );
}
