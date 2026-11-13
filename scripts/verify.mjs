#!/usr/bin/env node
/**
 * verify.mjs - the one command behind the repository promise
 * ("a single local command runs every gate").
 *
 * Default mode (`pnpm verify`) runs six segments, in this order:
 *
 *   [1] typecheck       pnpm -r typecheck
 *   [2] lint            pnpm exec eslint . - the fast first pass, matching the
 *                       raw import string
 *   [3] boundaries      node scripts/check-boundaries.mjs - the authoritative
 *                       verdict: every specifier is resolved against the real
 *                       file system, so relative paths, require(), dynamic
 *                       import() and `export ... from` cannot slip past it
 *   [4] gate self-test  vitest over the gates' red/green fixture pairs. A
 *                       failure here means the GATE is broken, not the code
 *                       under test, so the segment says so out loud
 *   [5] test            vitest over every other test file
 *   [6] coverage        vitest --coverage - numbers only, no thresholds,
 *                       uncovered code never fails verify
 *
 * `--full` (`pnpm verify:full`) appends the three O(file count) repository
 * discipline gates: file size, cycles, module ownership. They stay out of the
 * default mode because they are not part of the package-boundary judgement.
 *
 * Behaviour, frozen:
 *   - no fail-fast: every segment runs, then the summary lists every failure,
 *     so one run shows all problems;
 *   - each segment has its own heading, its own conclusion line and its own
 *     duration;
 *   - a failing segment replays its full captured output (that is the
 *     debugging payload); a passing one leaves only the conclusion line, so a
 *     green run stays readable. `--verbose` replays everything;
 *   - English only, ASCII only, posix paths;
 *   - exit 0 = every segment passed, 1 = at least one segment failed,
 *     2 = this aggregator itself is broken (bad argument, missing script),
 *     matching the three-value contract in scripts/lib/gate-cli.mjs.
 *
 * Windows: pnpm ships as `pnpm.cmd`, which Node cannot spawn without a shell,
 * so each child command is built as one quoted command line and run with
 * `shell: true`. The quoting happens here rather than being left to Node.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { fail, toPosix } from "./lib/gate-cli.mjs";
import { hooksInstalled } from "./lib/verify-hooks.mjs";

/** Indentation of every replayed child line and hint line. */
const OUTPUT_INDENT = "    ";

/** A gate can print a lot (tsc, eslint); capture all of it, never truncate. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** CSI escape sequences: colors, cursor moves, line clears. */
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/** The test-file convention of this repository. */
const TEST_FILE_PATTERN = /\.test\.ts$/;

/** Any byte that would break the ASCII-only output contract. */
const NON_ASCII_PATTERN = /[^\u0000-\u007F]/g;

/**
 * Outer tools decorate their output (vitest prefixes passing files with a
 * check mark, ESLint an error count with a ballot X). Those glyphs are folded
 * to ASCII here so a replayed segment cannot break the ASCII-only contract;
 * anything unmapped becomes "?".
 */
const GLYPH_FOLDS = new Map([
  ["\u2713", "ok"],
  ["\u2714", "ok"],
  ["\u2717", "x"],
  ["\u2716", "x"],
  ["\u276F", ">"],
  ["\u2192", "->"],
  ["\u2026", "..."],
]);

/** Matches the coverage table vitest prints once it has numbers to report. */
const COVERAGE_REPORT_PATTERN = /% Coverage report/;

/**
 * Gate self-tests: each file drives a real gate script against red and green
 * fixtures, so a failure means the rule matrix (not the product code) is
 * broken. Every other test file below scripts/ is segment 5.
 */
const GATE_SELF_TEST_FILES = [
  "scripts/boundaries-matrix.test.ts",
  "scripts/cycles.test.ts",
  "scripts/file-size-ratchet.test.ts",
  "scripts/module-ownership.test.ts",
  "scripts/contract-gate.test.ts",
];

/** Long form of the gate self-test heading; see the segment definition. */
const GATE_SELF_TEST_HEADER =
  "gate self-test (fixture pairs - a failure here means the GATE is broken, not your code)";

/** Printed once under a failed gate self-test segment. */
const GATE_SELF_TEST_WARNING =
  "the gate itself is broken, not the code under test: fix the rule matrix or its fixtures first";

/**
 * @typedef {object} VerifyOptions
 * @property {string} root Absolute posix repository root.
 * @property {boolean} full Also run the repository-discipline gates.
 * @property {boolean} verbose Replay every segment and forward --verbose.
 */

/**
 * @typedef {object} Command
 * @property {string} command Executable name or absolute path.
 * @property {string[]} args
 */

/**
 * @typedef {object} RunResult
 * @property {number | null} status
 * @property {string} output Combined stdout and stderr, ANSI-free, LF only.
 * @property {boolean} spawnFailed True when the process could not start.
 */

/**
 * @typedef {object} Segment
 * @property {string} label Short name, used in the summary.
 * @property {string} [header] Longer heading, used in the bracket line.
 * @property {() => Command} command Built per run, so --verbose can leak in.
 * @property {string} [skipReason] Printed instead of running `command`.
 * @property {(run: RunResult) => boolean} [evaluate] Defaults to status === 0.
 * @property {string} [warning] Extra line printed when the segment fails.
 * @property {string[]} [notes] Informational lines after the conclusion.
 */

/**
 * @typedef {object} SegmentResult
 * @property {string} label
 * @property {boolean} passed
 */

/**
 * Entry point. Kept separate from the module body so importing this file (for
 * a manual check of one helper) has no side effects.
 *
 * @returns {void}
 */
function start() {
  try {
    const flags = parseArguments(process.argv.slice(2));
    const options = { root: toPosix(process.cwd()), full: flags.full, verbose: flags.verbose };

    assertPrerequisites(options);

    const segments = buildSegments(options);

    console.log(
      `verify: ${segments.length} segments, mode ${options.full ? "full" : "default"}, ` +
        `root ${options.root}`,
    );

    const started = performance.now();
    const results = segments.map((segment, index) => {
      if (index > 0) {
        console.log("");
      }

      return runSegment(segment, index, segments.length, options);
    });
    const seconds = (performance.now() - started) / 1000;

    printSummary(results, seconds);
    printHooksHint(options.root);

    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
  } catch (error) {
    // Exit code 2: the aggregator could not even judge the tree. A gate that
    // reports violations exits 1 instead, and never reaches this path.
    fail(error);
  }
}

/**
 * @param {string[]} argv Arguments after the node/script prefix.
 * @returns {{ full: boolean, verbose: boolean }}
 */
function parseArguments(argv) {
  const flags = { full: false, verbose: false };

  for (const arg of argv) {
    if (arg === "--full") {
      flags.full = true;
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else {
      throw new Error(`unknown argument: ${arg} (supported: --full, --verbose)`);
    }
  }

  return flags;
}

/**
 * Fail closed before the first segment: a missing script or dependency must be
 * a loud exit 2, never a segment that quietly inspects nothing.
 *
 * @param {VerifyOptions} options
 * @returns {void}
 */
function assertPrerequisites(options) {
  if (!existsSync(path.join(options.root, "package.json"))) {
    throw new Error(`not a haruyuki-gui checkout (no package.json in ${options.root})`);
  }

  if (!existsSync(path.join(options.root, "node_modules"))) {
    throw new Error("node_modules is missing; run pnpm install first (verify never installs)");
  }

  if (findExecutable("pnpm") === null) {
    throw new Error("pnpm is not on PATH; install pnpm or run this through pnpm");
  }

  const gateScripts = ["scripts/check-boundaries.mjs"];

  if (options.full) {
    gateScripts.push(
      "scripts/check-file-size.mjs",
      "scripts/check-cycles.mjs",
      "scripts/check-module-ownership.mjs",
    );
  }

  for (const relative of [...gateScripts, ...GATE_SELF_TEST_FILES]) {
    if (!existsSync(path.join(options.root, relative))) {
      throw new Error(`required file not found: ${relative}`);
    }
  }
}

/**
 * Describe the six base segments (plus three under --full).
 *
 * @param {VerifyOptions} options
 * @returns {Segment[]}
 */
function buildSegments(options) {
  const everyTestFile = discoverTestFiles(options.root);
  const unitTestFiles = everyTestFile.filter((file) => !GATE_SELF_TEST_FILES.includes(file));

  /** @type {Segment[]} */
  const segments = [
    {
      label: "typecheck",
      command: () => ({ command: "pnpm", args: ["-r", "typecheck"] }),
    },
    {
      label: "lint",
      command: () => ({ command: "pnpm", args: ["exec", "eslint", "."] }),
    },
    {
      label: "boundaries",
      command: () => gate("scripts/check-boundaries.mjs", options.verbose),
    },
    {
      label: "gate self-test",
      header: GATE_SELF_TEST_HEADER,
      warning: GATE_SELF_TEST_WARNING,
      command: () => vitest(GATE_SELF_TEST_FILES),
    },
    {
      label: "contract",
      command: () => gate("scripts/check-contract.mjs", options.verbose),
    },
    {
      label: "test",
      skipReason:
        unitTestFiles.length === 0
          ? "no test files outside the gate self-test set; nothing to run"
          : undefined,
      command: () => vitest(unitTestFiles),
    },
    {
      label: "coverage",
      command: () => ({
        command: "pnpm",
        args: ["exec", "vitest", "run", "--coverage", "--coverage.reporter=text"],
      }),
      // A number report is the whole contract of this segment: uncovered code
      // never fails here, and a red test verdict belongs to segment 5, so a
      // non-zero exit that still produced the table is not a coverage failure.
      evaluate: (run) => run.status === 0 || COVERAGE_REPORT_PATTERN.test(run.output),
      notes: [
        "advisory only: no threshold, uncovered code never fails verify",
        "in-process coverage of scripts/ stays low because gates run as child processes",
        "test verdicts belong to segment 5, not here",
      ],
    },
  ];

  if (options.full) {
    segments.push(
      { label: "file size", command: () => gate("scripts/check-file-size.mjs", false) },
      { label: "cycles", command: () => gate("scripts/check-cycles.mjs", false) },
      {
        label: "module ownership",
        command: () => gate("scripts/check-module-ownership.mjs", options.verbose),
      },
    );
  }

  return segments;
}

/**
 * Run one gate script under the current node binary.
 *
 * `--verbose` is only forwarded to the two gates that declare the flag; the
 * others treat an unknown argument as a usage error (exit 2).
 *
 * @param {string} relative Repo-relative posix script path.
 * @param {boolean} verbose
 * @returns {Command}
 */
function gate(relative, verbose) {
  const supportsVerbose =
    relative === "scripts/check-boundaries.mjs" ||
    relative === "scripts/check-module-ownership.mjs" ||
    relative === "scripts/check-contract.mjs";
  const args = [relative];

  if (verbose && supportsVerbose) {
    args.push("--verbose");
  }

  return { command: process.execPath, args };
}

/**
 * @param {string[]} files Repo-relative posix test file paths.
 * @returns {Command}
 */
function vitest(files) {
  return { command: "pnpm", args: ["exec", "vitest", "run", ...files] };
}

/**
 * Every test file below scripts/, sorted, as repo-relative posix paths.
 *
 * @param {string} root Absolute posix repository root.
 * @returns {string[]}
 */
function discoverTestFiles(root) {
  return readdirSync(path.join(root, "scripts"))
    .filter((name) => TEST_FILE_PATTERN.test(name))
    .sort()
    .map((name) => `scripts/${name}`);
}

/**
 * Run one segment, replaying its output when it fails or when verbose.
 *
 * @param {Segment} segment
 * @param {number} index Zero-based position.
 * @param {number} total Segment count for the current mode.
 * @param {VerifyOptions} options
 * @returns {SegmentResult}
 */
function runSegment(segment, index, total, options) {
  const position = index + 1;

  console.log(`[${position}/${total}] ${segment.header ?? segment.label}`);

  if (segment.skipReason !== undefined) {
    console.log(`${OUTPUT_INDENT}${segment.skipReason}`);
    console.log(`[${position}/${total}] ${segment.label}  PASS  0.00s`);

    return { label: segment.label, passed: true };
  }

  const started = performance.now();
  const run = runCommand(segment.command(), options);
  const seconds = (performance.now() - started) / 1000;
  const passed = segment.evaluate === undefined ? run.status === 0 : segment.evaluate(run);

  if (options.verbose || !passed) {
    replay(run.output);
  }

  const verdict = passed ? "PASS" : "FAIL";

  console.log(`[${position}/${total}] ${segment.label}  ${verdict}  ${formatSeconds(seconds)}`);

  if (!passed) {
    if (run.spawnFailed) {
      console.log(`${OUTPUT_INDENT}the command could not be started at all`);
    }

    if (segment.warning !== undefined) {
      console.log(`${OUTPUT_INDENT}${segment.warning}`);
    }
  }

  for (const note of segment.notes ?? []) {
    console.log(`${OUTPUT_INDENT}note: ${note}`);
  }

  return { label: segment.label, passed };
}

/**
 * @param {Command} command
 * @param {VerifyOptions} options
 * @returns {RunResult}
 */
function runCommand(command, options) {
  const result = spawnSync(toShellLine(command), {
    shell: true,
    cwd: options.root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });

  return {
    status: result.status,
    output: normalizeOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`),
    spawnFailed: result.error !== undefined,
  };
}

/**
 * @param {Command} command
 * @returns {string} One quoted command line, ready for `shell: true`.
 */
function toShellLine(command) {
  return [command.command, ...command.args].map(quoteArgument).join(" ");
}

/**
 * Quote one argument for the shell. Plain tokens (the common case here) are
 * left alone so the replayed command line stays readable.
 *
 * @param {string} argument
 * @returns {string}
 */
function quoteArgument(argument) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(argument)) {
    return argument;
  }

  if (process.platform === "win32") {
    return `"${argument.replaceAll('"', '\\"')}"`;
  }

  return `'${argument.replaceAll("'", "'\\''")}'`;
}

/**
 * Strip ANSI colors so a piped log stays ASCII-clean, normalize line endings,
 * and drop trailing blank space.
 *
 * @param {string} output
 * @returns {string}
 */
function normalizeOutput(output) {
  return (
    output
      .replaceAll("\r\n", "\n")
      .replace(ANSI_PATTERN, "")
      .replace(NON_ASCII_PATTERN, (character) => GLYPH_FOLDS.get(character) ?? "?")
      // Some tools open their report with a blank line; the replay already
      // leaves a gap under the segment heading.
      .replace(/^(?:[ \t]*\n)+/, "")
      .replace(/\s+$/, "")
  );
}

/**
 * Print captured child output, indented, so it is clearly one segment's own
 * output rather than the aggregator's voice.
 *
 * @param {string} output
 * @returns {void}
 */
function replay(output) {
  if (output === "") {
    return;
  }

  for (const line of output.split("\n")) {
    console.log(line === "" ? "" : `${OUTPUT_INDENT}${line}`);
  }
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatSeconds(seconds) {
  return `${seconds.toFixed(2)}s`;
}

/**
 * @param {SegmentResult[]} results
 * @param {number} seconds Total wall time.
 * @returns {void}
 */
function printSummary(results, seconds) {
  const failed = results.filter((result) => !result.passed);
  const duration = `${seconds.toFixed(1)}s`;

  console.log("");

  if (failed.length === 0) {
    console.log(`verify: ${results.length}/${results.length} segments passed in ${duration}`);

    return;
  }

  console.log(`verify: ${failed.length} of ${results.length} segments FAILED in ${duration}`);
  console.log(`  FAILED: ${failed.map((result) => result.label).join(", ")}`);
}

/**
 * One hint, never a failure: the hooks are a convenience, and a checkout
 * without them still verifies.
 *
 * @param {string} root Absolute posix repository root.
 * @returns {void}
 */
function printHooksHint(root) {
  if (hooksInstalled(root)) {
    return;
  }

  console.log("hint: git hooks are not installed; run: pnpm hooks:install");
}

/**
 * First hit of an executable on PATH, platform-aware.
 *
 * @param {string} name Bare command name, for example "pnpm".
 * @returns {string | null} Absolute posix path, or null when not found.
 */
function findExecutable(name) {
  const pathValue = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  const candidates = process.platform === "win32" ? [`${name}.cmd`, `${name}.exe`, name] : [name];

  for (const entry of pathValue.split(separator)) {
    const directory = entry.replace(/^"|"$/g, "");

    if (directory === "") {
      continue;
    }

    for (const candidate of candidates) {
      const absolute = path.join(directory, candidate);

      if (existsSync(absolute)) {
        return toPosix(absolute);
      }
    }
  }

  return null;
}

/**
 * Only run when this file is the entry point, so it can be imported safely by
 * a one-off check (for example to exercise `hooksInstalled`).
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const invoked = process.argv[1];

  if (invoked === undefined) {
    return false;
  }

  const invokedPosix = toPosix(path.resolve(invoked)).toLowerCase();
  const selfPosix = toPosix(fileURLToPath(import.meta.url)).toLowerCase();

  return invokedPosix === selfPosix;
}

if (isEntryPoint()) {
  start();
}
