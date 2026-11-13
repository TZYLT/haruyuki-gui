#!/usr/bin/env node
/**
 * cli.mjs - thin dispatcher for the contract pipeline.
 *
 * This file owns argument parsing and the three-value exit code only. Every
 * subcommand body is a TODO owned by a later work package, so today each one
 * throws `NotImplementedError` and exits 2. Nothing here reads `snapshot.json`,
 * the engine source or `capabilities.json`; the extractors stay in their own
 * modules (the capability table...the wiring) and are wired in at the wave boundary by the Lead.
 *
 * Usage (frozen by route doc 08 section 3.4b):
 *   node scripts/contract/cli.mjs update   --engine <dir> [--out <file>]
 *   node scripts/contract/cli.mjs check    [--engine <dir>] [--dts <dir>]
 *   node scripts/contract/cli.mjs diff     <a.json> [b.json]
 *   node scripts/contract/cli.mjs generate
 *
 * Exit codes (the gate-cli three-value contract):
 *   0 = the operation passed (help is also 0)
 *   1 = the operation found a violation (never produced by the type skeleton)
 *   2 = broken input, bad argument, I/O error or "not implemented yet"
 *
 * Usage details:
 *   - `--help` / `-h` prints usage on stdout and exits 0.
 *   - No subcommand, or an unknown one, prints usage on stderr and exits 2.
 *   - Flags accept `--name value` and `--name=value`.
 *   - A missing required flag, an unknown flag or a wrong positional count is a
 *     usage error (exit 2), reported before the "not implemented" notice, so a
 *     caller can already pin the argument surface.
 *   - `diff` accepts one or two snapshots. One means "compare with the snapshot
 *     committed in this repo", which is why it is not a required positional.
 */

const USAGE = `Usage:
  node scripts/contract/cli.mjs update   --engine <dir> [--out <file>]
  node scripts/contract/cli.mjs check    [--engine <dir>] [--dts <dir>]
  node scripts/contract/cli.mjs diff     <a.json> [b.json]
  node scripts/contract/cli.mjs generate

Exit codes: 0 pass, 1 violation, 2 broken input / not implemented.
This skeleton only parses arguments; every subcommand is not implemented yet.`;

/** Subcommand owner map, used by the TODO notice. */
const OWNERS = Object.freeze({
  update: "snapshot assembly",
  check: "contract (gate segment)",
  diff: "the log (diff and report)",
  generate: "the wiring (generator)",
});

/**
 * Raised when parsing succeeded but the subcommand is still a stub.
 */
class NotImplementedError extends Error {
  /**
   * @param {string} subcommand
   */
  constructor(subcommand) {
    super(`subcommand "${subcommand}" is not implemented yet`);
    this.name = "NotImplementedError";
    this.subcommand = subcommand;
  }
}

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
 * Throw the stub error that maps to exit 2.
 *
 * @param {string} subcommand
 * @returns {never}
 */
function notImplemented(subcommand) {
  throw new NotImplementedError(subcommand);
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

  notImplemented("update");
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

  if (errors.length > 0) {
    usageError("check", errors);

    return;
  }

  notImplemented("check");
}

/**
 * `diff <a.json> [b.json]`
 *
 * @param {string[]} args
 */
function runDiff(args) {
  const parsed = parseArguments(args, []);
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

  notImplemented("diff");
}

/**
 * `generate`
 *
 * @param {string[]} args
 */
function runGenerate(args) {
  const parsed = parseArguments(args, []);

  if (parsed.errors.length > 0 || parsed.positionals.length > 0) {
    const errors = [...parsed.errors];

    if (parsed.positionals.length > 0) {
      errors.push(`unexpected positional argument: ${parsed.positionals[0]}`);
    }

    usageError("generate", errors);

    return;
  }

  notImplemented("generate");
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
  if (error instanceof NotImplementedError) {
    process.stderr.write(
      `contract ${error.subcommand}: not implemented yet (planned owner: ${OWNERS[error.subcommand]})\n`,
    );
  } else {
    const message = error instanceof Error ? error.message : String(error);

    process.stderr.write(`contract: internal error: ${message}\n`);
  }

  process.exitCode = 2;
}
