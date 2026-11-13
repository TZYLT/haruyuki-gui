#!/usr/bin/env node
/**
 * cli.mjs - thin dispatcher for the contract pipeline.
 *
 * This file owns argument parsing, the three-value exit code and the wiring
 * between the extractors. The extractors themselves stay in their own modules;
 * only the dispatcher lives here.
 *
 * Usage (frozen by route doc 08 section 3.4b):
 *   node scripts/contract/cli.mjs update   --engine <dir> [--out <file>]
 *   node scripts/contract/cli.mjs check    [--engine <dir>] [--dts <dir>]
 *   node scripts/contract/cli.mjs diff     <a.json> [b.json]
 *   node scripts/contract/cli.mjs generate
 *
 * Exit codes (the gate-cli three-value contract):
 *   0 = the operation passed (help is also 0)
 *   1 = the operation found a violation
 *   2 = broken input, bad argument or I/O error
 *
 * Usage details:
 *   - `--help` / `-h` prints usage on stdout and exits 0.
 *   - No subcommand, or an unknown one, prints usage on stderr and exits 2.
 *   - Flags accept `--name value` and `--name=value`.
 *   - A missing required flag, an unknown flag or a wrong positional count is a
 *     usage error (exit 2).
 *   - `diff` accepts one or two snapshots. One means "compare with the snapshot
 *     committed in this repo", which is why it is not a required positional.
 */

const USAGE = `Usage:
  node scripts/contract/cli.mjs update   --engine <dir> [--out <file>]
  node scripts/contract/cli.mjs check    [--engine <dir>] [--dts <dir>]
  node scripts/contract/cli.mjs diff     <a.json> [b.json]
  node scripts/contract/cli.mjs generate

Exit codes: 0 pass, 1 violation, 2 broken input.`;

import { readFileSync, writeFileSync } from "node:fs";

import { collectContractViolations } from "../check-contract.mjs";
import { crossCheck, formatCrossCheck } from "./cross-check.mjs";
import {
  diffSnapshots,
  loadCapabilities,
  loadSnapshot,
  runDiff as runDiffCommand,
} from "./diff.mjs";
import { generateMap } from "./map.mjs";
import { renderReport } from "./report.mjs";
import { buildSnapshot, writeSnapshot } from "./snapshot.mjs";

/** Default artifacts, relative to the process working directory (the repo root). */
const DEFAULT_CAPABILITIES = "packages/protocol/src/contract/capabilities.json";
const DEFAULT_SNAPSHOT = "packages/protocol/src/contract/snapshot.json";
const DEFAULT_GENERATED = "packages/protocol/src/contract/command-map.generated.ts";

/**
 * Print usage to one stream and set the exit code.
 *
 * @param {NodeJS.WriteStream} stream
 * @param {number} code
 */
function usage(stream, code) {
  stream.write(`${USAGE}\n`);
  process.exitCode = code;
}

/**
 * Split `--name=value` into its parts.
 *
 * @param {string} argument
 * @returns {{name: string, inline: string | undefined}}
 */
function splitFlag(argument) {
  const index = argument.indexOf("=");

  if (index === -1) {
    return { name: argument, inline: undefined };
  }

  return { name: argument.slice(0, index), inline: argument.slice(index + 1) };
}

/**
 * Parse flags and positionals for one subcommand.
 *
 * @param {string[]} args
 * @param {readonly string[]} allowed value-taking flags
 * @returns {{options: Map<string,string>, positionals: string[], errors: string[]}}
 */
function parseArguments(args, allowed) {
  const options = new Map();
  const positionals = [];
  const errors = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (typeof argument !== "string") {
      continue;
    }

    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const { name, inline } = splitFlag(argument);

    if (!allowed.includes(name)) {
      errors.push(`unknown option ${name}`);

      continue;
    }

    if (options.has(name)) {
      errors.push(`option ${name} was given more than once`);

      continue;
    }

    if (inline !== undefined) {
      if (inline.length === 0) {
        errors.push(`option ${name} requires a value`);
      } else {
        options.set(name, inline);
      }

      continue;
    }

    const value = args[index + 1];

    if (value === undefined || value.startsWith("--")) {
      errors.push(`option ${name} requires a value`);

      continue;
    }

    options.set(name, value);
    index += 1;
  }

  return { options, positionals, errors };
}

/**
 * Report a usage error for one subcommand and stop.
 *
 * @param {string} subcommand
 * @param {string[]} messages
 */
function usageError(subcommand, messages) {
  for (const message of messages) {
    process.stderr.write(`contract ${subcommand}: ${message}\n`);
  }

  usage(process.stderr, 2);
}

/**
 * `update --engine <dir> [--out <file>]`
 *
 * @param {string[]} args
 */
function runUpdate(args) {
  const parsed = parseArguments(args, ["--engine", "--out"]);
  const errors = [...parsed.errors];

  if (parsed.positionals.length > 0) {
    errors.push(`unexpected positional argument: ${parsed.positionals[0]}`);
  }

  if (!parsed.options.has("--engine")) {
    errors.push("--engine <dir> is required");
  }

  if (errors.length > 0) {
    usageError("update", errors);

    return;
  }

  const engineRoot = parsed.options.get("--engine");
  const outPath = parsed.options.get("--out") ?? DEFAULT_SNAPSHOT;

  const snapshot = buildSnapshot({
    engineRoot,
    capabilitiesPath: DEFAULT_CAPABILITIES,
  });

  const counts = snapshot.counts;
  const lines = [
    `snapshot  ${outPath}`,
    `engine    ${snapshot.engine.version} @ ${snapshot.engine.commit}`,
    `counts    union=${counts.unionMembers} wire=${counts.wireCommands} messages=${counts.messages}` +
      ` inbound=${counts.inboundAccepted} inboundOnly=${counts.inboundOnly}` +
      ` advertised=${counts.advertisedCommands} dispatch=${counts.dispatchCases}`,
    `health    degraded=${snapshot.health.degraded} coarse=${snapshot.health.coarse.length}` +
      ` unparsed=${snapshot.health.unparsed.length}`,
  ];

  process.stdout.write(lines.join("\n") + "\n");

  if (snapshot.health.degraded) {
    process.stderr.write(
      "contract update: snapshot is degraded (symbols missing); nothing written\n",
    );
    process.exitCode = 2;

    return;
  }

  writeSnapshot(outPath, snapshot);
}

/**
 * `check [--engine <dir>] [--dts <dir>]`
 *
 * @param {string[]} args
 */
function runCheck(args) {
  const parsed = parseArguments(args, ["--engine", "--dts"]);
  const errors = [...parsed.errors];

  if (parsed.positionals.length > 0) {
    errors.push(`unexpected positional argument: ${parsed.positionals[0]}`);
  }

  const engineRoot = parsed.options.get("--engine");
  const dtsDir = parsed.options.get("--dts");

  if (engineRoot !== undefined && dtsDir !== undefined) {
    errors.push("--engine and --dts cannot be combined");
  }

  if (errors.length > 0) {
    usageError("check", errors);

    return;
  }

  if (engineRoot !== undefined) {
    checkAgainstEngine(engineRoot);

    return;
  }

  checkInRepo();

  if (dtsDir !== undefined) {
    checkAgainstDts(dtsDir);
  }
}

/**
 * Rebuild the snapshot from a live engine tree and report drift against the
 * committed baseline on stdout. Only used by release-time / G3 checks.
 *
 * @param {string} engineRoot
 */
function checkAgainstEngine(engineRoot) {
  const rebuilt = buildSnapshot({ engineRoot, capabilitiesPath: DEFAULT_CAPABILITIES });

  if (rebuilt.health.degraded) {
    process.stderr.write(
      "contract check: the rebuilt snapshot is degraded (symbols missing); drift is not trustworthy\n",
    );
    process.exitCode = 2;

    return;
  }

  const committed = loadSnapshot(DEFAULT_SNAPSHOT, { cwd: process.cwd(), label: "committed" });
  const capabilities = loadCapabilities(DEFAULT_CAPABILITIES);
  const result = diffSnapshots(committed, rebuilt, { capabilities });
  const lines = renderReport(result);

  process.stdout.write(lines.join("\n") + "\n");

  if (result.summary.total > 0) {
    process.exitCode = 1;
  }
}

/** In-repo check: artifact consistency, six map rules and coverage closure. */
function checkInRepo() {
  const violations = collectContractViolations({ root: process.cwd() });

  for (const violation of violations) {
    const line = typeof violation.line === "number" ? violation.line : 0;

    process.stdout.write(`${violation.file}:${line} ${violation.rule} ${violation.message}\n`);
  }

  if (violations.length === 0) {
    process.stdout.write("PASS\n");

    return;
  }

  process.stdout.write(`FAIL: ${violations.length} violation(s)\n`);
  process.exitCode = 1;
}

/**
 * Type-level cross-check against an unpacked declaration directory. Differences
 * are reported but never change the exit code (only broken input does).
 *
 * @param {string} dtsDir
 */
function checkAgainstDts(dtsDir) {
  let snapshot;

  try {
    snapshot = loadSnapshot(DEFAULT_SNAPSHOT, { cwd: process.cwd(), label: "committed" });
  } catch (error) {
    process.stderr.write(
      `contract check: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;

    return;
  }

  const result = crossCheck({ dtsDir, snapshot });

  process.stdout.write(formatCrossCheck(result));

  if (!result.ok) {
    process.exitCode = 2;
  }
}

/**
 * `diff <a.json> [b.json]`
 *
 * @param {string[]} args
 */
function runDiff(args) {
  const parsed = parseArguments(args, ["--out"]);
  const errors = [...parsed.errors];

  if (parsed.positionals.length < 1) {
    errors.push("a snapshot path is required");
  }

  if (parsed.positionals.length > 2) {
    errors.push(`expected one or two snapshot paths, received ${parsed.positionals.length}`);
  }

  if (errors.length > 0) {
    usageError("diff", errors);

    return;
  }

  const out = parsed.options.get("--out") ?? null;
  const { lines } = runDiffCommand({
    a: parsed.positionals[0],
    b: parsed.positionals[1],
    out,
  });

  if (out === null) {
    process.stdout.write(lines.join("\n") + "\n");
  }
}

/**
 * `generate`
 *
 * @param {string[]} args
 */
function runGenerate(args) {
  const parsed = parseArguments(args, ["--out"]);

  if (parsed.errors.length > 0 || parsed.positionals.length > 0) {
    const errors = [...parsed.errors];

    if (parsed.positionals.length > 0) {
      errors.push(`unexpected positional argument: ${parsed.positionals[0]}`);
    }

    usageError("generate", errors);

    return;
  }

  const snapshot = JSON.parse(readFileSync(DEFAULT_SNAPSHOT, "utf8"));
  const capabilities = JSON.parse(readFileSync(DEFAULT_CAPABILITIES, "utf8"));
  const result = generateMap({ snapshot, capabilities });

  if (result.code !== 0) {
    for (const violation of result.violations) {
      if (violation.severity !== "error") continue;

      process.stderr.write(
        `${violation.file ?? DEFAULT_GENERATED}:${violation.line ?? 0} ` +
          `${violation.rule} ${violation.message}\n`,
      );
    }

    process.stderr.write("contract generate: capability table is invalid; nothing written\n");
    process.exitCode = 2;

    return;
  }

  const outPath = parsed.options.get("--out") ?? DEFAULT_GENERATED;

  writeFileSync(outPath, result.text, "utf8");
  process.stdout.write(`generated ${outPath}\n`);
}

/**
 * Entry point.
 *
 * @param {string[]} args process arguments after the script name
 */
function main(args) {
  const [subcommand, ...rest] = args;

  if (subcommand === undefined) {
    usage(process.stderr, 2);

    return;
  }

  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    usage(process.stdout, 0);

    return;
  }

  switch (subcommand) {
    case "update":
      runUpdate(rest);
      return;
    case "check":
      runCheck(rest);
      return;
    case "diff":
      runDiff(rest);
      return;
    case "generate":
      runGenerate(rest);
      return;
    default:
      process.stderr.write(`contract: unknown subcommand "${subcommand}"\n`);
      usage(process.stderr, 2);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);

  process.stderr.write(`contract: internal error: ${message}\n`);
  process.exitCode = 2;
}
