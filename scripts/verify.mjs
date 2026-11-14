#!/usr/bin/env node
/**
 * verify.mjs - the one command behind the repository promise
 * ("a single local command runs every gate").
 *
 * Default mode (`pnpm verify`) runs seven segments, in this order:
 *
 *   [1] typecheck       pnpm typecheck (the five workspace packages, then
 *                       `tsc -p scripts` for the gate self-tests)
 *   [2] lint            pnpm exec eslint . - the fast first pass, matching the
 *                       raw import string
 *   [3] boundaries      node scripts/check-boundaries.mjs - the authoritative
 *                       verdict: every specifier is resolved against the real
 *                       file system, so relative paths, require(), dynamic
 *                       import() and `export ... from` cannot slip past it
 *   [4] gate self-test  vitest over the gates' red/green fixture pairs. A
 *                       failure here means the GATE is broken, not the code
 *                       under test, so the segment says so out loud
 *   [5] contract        node scripts/check-contract.mjs - the committed
 *                       contract artifacts must still match their truth sources
 *   [6] test            vitest over every other test file
 *   [7] coverage        vitest --coverage - numbers only, no thresholds,
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
 *   - English only, ASCII only, posix paths; the aggregator's own lines are
 *     folded through the same mapping as child output, so a non-ASCII working
 *     directory can never leak raw bytes into the log;
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

/**
 * Placeholder for one segment number inside a note, for example
 * `{segment:test}`. Segment numbers are derived from the assembled list, never
 * hand-copied: inserting a segment can no longer leave a stale number behind.
 */
const SEGMENT_REFERENCE_PATTERN = /\{segment:([a-z][a-z -]*)\}/g;

/** A gate can print a lot (tsc, eslint); capture all of it, never truncate. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** CSI escape sequences: colors, cursor moves, line clears. */
const ANSI_PATTERN = /\u001B\[[0-9;?]*[A-Za-z]/g;

/**
 * The test-file convention of this repository.
 *
 * `.test.tsx` is included because component tests are TSX. This pattern is used
 * for two jobs that must agree: discovering files to run, and recognising which
 * vitest arguments are test files when checking that every segment input exists.
 * A `.test.tsx` the runner never discovers is a test that silently never fails.
 */
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

/**
 * Directories the test discovery never descends into. Same set every other gate
 * skips: `fixtures` holds deliberately broken trees, `_research` and `docs` are
 * not part of the workspace, and the rest are build or install output.
 */
const SKIPPED_TEST_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "fixtures",
  "_research",
  "docs",
]);

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
 * broken. Every other test file below scripts/ belongs to the test segment.
 */
const GATE_SELF_TEST_FILES = [
  "scripts/boundaries-matrix.test.ts",
  "scripts/eslint-boundaries.test.ts",
  "scripts/cycles.test.ts",
  "scripts/file-size-ratchet.test.ts",
  "scripts/module-ownership.test.ts",
  "scripts/contract-gate.test.ts",
  "scripts/tokens/check.test.ts",
  "scripts/i18n/check.test.ts",
  "scripts/lint/i18n-messages.test.ts",
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

    assertEnvironment(options);

    // Assemble first, then fail closed on exactly the files the assembled
    // segments will run: the requirement list is derived, never a second copy
    // of the script list that can drift (P3-01).
    const segments = buildSegments(options);

    assertSegmentFiles(options, segments);

    printLine(
      `verify: ${segments.length} segments, mode ${options.full ? "full" : "default"}, ` +
        `root ${options.root}`,
    );

    const started = performance.now();
    const results = segments.map((segment, index) => {
      if (index > 0) {
        printLine();
      }

      return runSegment(segment, index, segments.length, options);
    });
    const seconds = (performance.now() - started) / 1000;

    printSummary(results, seconds);
    printHooksHint(options.root);

    process.exitCode = results.every((result) => result.passed) ? 0 : 1;
  } catch (error) {
    // Exit code 2: the aggregator could not even judge the tree. A gate that
    // reports violations exits 1 instead, and never reaches this path. The
    // message can embed the (possibly non-ASCII) working directory, so fold it
    // before printing: the aggregator must honour its own ASCII contract.
    fail(asciiSafe(error instanceof Error ? error.message : String(error)));
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
 * Fail closed before the first segment: a missing dependency or a checkout that
 * is not a repository must be a loud exit 2, never a segment that quietly
 * inspects nothing.
 *
 * @param {VerifyOptions} options
 * @returns {void}
 */
function assertEnvironment(options) {
  if (!existsSync(path.join(options.root, "package.json"))) {
    throw new Error(`not a haruyuki-gui checkout (no package.json in ${options.root})`);
  }

  if (!existsSync(path.join(options.root, "node_modules"))) {
    throw new Error("node_modules is missing; run pnpm install first (verify never installs)");
  }

  if (findExecutable("pnpm") === null) {
    throw new Error("pnpm is not on PATH; install pnpm or run this through pnpm");
  }
}

/**
 * Fail closed on every file the assembled segments will actually run.
 *
 * The list is derived from the segment commands themselves (the Node script a
 * gate segment spawns, the test files a vitest segment gets), so adding a
 * segment extends the prerequisite check for free. Hand-maintaining a second
 * list is exactly how the contract gate slipped past this check (P3-01).
 *
 * @param {VerifyOptions} options
 * @param {Segment[]} segments
 * @returns {void}
 */
function assertSegmentFiles(options, segments) {
  /** @type {Map<string, string>} repo-relative file to the segment needing it */
  const required = new Map();

  for (const segment of segments) {
    for (const relative of segmentInputs(segment)) {
      if (!required.has(relative)) {
        required.set(relative, segment.label);
      }
    }
  }

  for (const [relative, label] of required) {
    if (!existsSync(path.join(options.root, relative))) {
      throw new Error(`required file not found: ${relative} (needed by segment "${label}")`);
    }
  }
}

/**
 * Every repository file one segment will read, as repo-relative posix paths.
 *
 * Two shapes exist today: a gate segment runs `process.execPath <script>`, and
 * a vitest segment passes test files after `exec vitest`. Anything else (a pnpm
 * workspace-wide command, a flag) contributes nothing.
 *
 * @param {Segment} segment
 * @returns {string[]}
 */
function segmentInputs(segment) {
  const { command, args } = segment.command();
  const inputs = [];

  if (command === process.execPath && args.length > 0 && !args[0].startsWith("-")) {
    inputs.push(args[0]);
  }

  if (args[0] === "exec" && args[1] === "vitest") {
    for (const arg of args) {
      if (TEST_FILE_PATTERN.test(arg)) {
        inputs.push(arg);
      }
    }
  }

  return inputs;
}

/**
 * Describe the eight base segments (plus three under --full).
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
      command: () => ({ command: "pnpm", args: ["typecheck"] }),
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
      // Runs after `contract` and before `test` so a token violation is reported
      // by the segment that names it rather than as a failing unit test.
      label: "tokens",
      command: () => gate("scripts/tokens/check.mjs", options.verbose),
      notes: [
        // A real reference, not a fixture for the placeholder test: the token
        // gate grades the palette the test segment renders against, so a reader
        // who sees one fail wants to know where the other runs.
        "the palette this grades is rendered under test in segment {segment:test}",
      ],
    },
    {
      // Catalogue completeness and consistency. Cheap and text-only, so it runs
      // before the test segment where a failure would be harder to attribute.
      label: "i18n",
      command: () => gate("scripts/i18n/check.mjs", options.verbose),
    },
    {
      // One run, two outputs: the test verdicts and the coverage numbers.
      //
      // These were two segments, and the second re-ran every test under
      // instrumentation. That was not redundancy a reader could see -- `test`
      // listed the unit files and `coverage` ran the whole suite again -- but it
      // cost a full second pass, about 24 s of a 62 s run, and the run has a 60 s
      // budget. Merging keeps both contracts and removes the second pass.
      //
      // Both contracts survive because they were always separate questions asked
      // about the same run: a red test fails here, an uninformative coverage table
      // does not.
      label: "test",
      skipReason:
        unitTestFiles.length === 0
          ? "no test files outside the gate self-test set; nothing to run"
          : undefined,
      command: () => vitest(unitTestFiles, ["--coverage", "--coverage.reporter=text"]),
      // A number report is the whole coverage contract: uncovered code never fails
      // here, so a non-zero exit that still produced the table is not a coverage
      // failure. A non-zero exit *with* a failing test verdict still fails, which is
      // what the segment is for.
      evaluate: (run) => run.status === 0 || COVERAGE_REPORT_PATTERN.test(run.output),
      notes: [
        "coverage is advisory: no threshold, uncovered code never fails verify",
        "in-process coverage of scripts/ stays low because gates run as child processes",
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

  resolveSegmentReferences(segments);

  return segments;
}

/**
 * Replace every `{segment:<label>}` note placeholder with that segment's real
 * one-based position in the assembled list (P3-03). Deriving the number here is
 * what keeps the coverage note correct when a segment is inserted; an unknown
 * label is a programming error in the aggregator itself, so it throws (exit 2).
 *
 * @param {Segment[]} segments
 * @returns {void}
 */
function resolveSegmentReferences(segments) {
  const numbers = new Map(segments.map((segment, index) => [segment.label, index + 1]));

  for (const segment of segments) {
    if (segment.notes === undefined) {
      continue;
    }

    segment.notes = segment.notes.map((note) =>
      note.replace(SEGMENT_REFERENCE_PATTERN, (match, label) => {
        const number = numbers.get(label);

        if (number === undefined) {
          throw new Error(`note of segment "${segment.label}" refers to unknown ${match}`);
        }

        return String(number);
      }),
    );
  }
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
/**
 * Build the vitest invocation for a set of test files.
 *
 * @param {string[]} files repo-relative test paths
 * @param {string[]} [extraArgs] additional vitest flags
 * @returns {{ command: string, args: string[] }}
 */
function vitest(files, extraArgs = []) {
  return { command: "pnpm", args: ["exec", "vitest", "run", ...files, ...extraArgs] };
}

/**
 * Every test file inside `root` below the given top-level directories, sorted,
 * as repo-relative posix paths.
 *
 * Recursive on purpose: tests live next to what they test, so both `scripts/**`
 * and `packages/**` are walked to full depth. Skipped directories mirror every
 * other gate (`node_modules`, `dist`, `coverage`, `fixtures`, `_research`,
 * `docs`): the fixture trees are deliberately broken and must never be collected
 * as tests, and a nested worktree or published copy is not this repository's
 * source.
 *
 * @param {string} root Absolute posix repository root.
 * @returns {string[]}
 */
function discoverTestFiles(root) {
  const roots = ["scripts", "packages"];

  /**
   * @param {string} relative Repo-relative posix directory.
   * @returns {string[]}
   */
  function walk(relative) {
    const absolute = path.join(root, relative);

    if (!existsSync(absolute)) return [];

    const found = [];

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;

      if (entry.isDirectory()) {
        if (!SKIPPED_TEST_DIRS.has(entry.name)) found.push(...walk(child));
      } else if (TEST_FILE_PATTERN.test(entry.name)) {
        found.push(child);
      }
    }

    return found;
  }

  return roots.flatMap(walk).sort();
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

  printLine(`[${position}/${total}] ${segment.header ?? segment.label}`);

  if (segment.skipReason !== undefined) {
    printLine(`${OUTPUT_INDENT}${segment.skipReason}`);
    printLine(`[${position}/${total}] ${segment.label}  PASS  0.00s`);

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

  printLine(`[${position}/${total}] ${segment.label}  ${verdict}  ${formatSeconds(seconds)}`);

  if (!passed) {
    if (run.spawnFailed) {
      printLine(`${OUTPUT_INDENT}the command could not be started at all`);
    }

    if (segment.warning !== undefined) {
      printLine(`${OUTPUT_INDENT}${segment.warning}`);
    }
  }

  for (const note of segment.notes ?? []) {
    printLine(`${OUTPUT_INDENT}note: ${note}`);
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
 * Fold any text this aggregator itself prints to the ASCII-only contract
 * (P3-07). Child output already goes through `normalizeOutput`; this helper
 * covers the aggregator's own lines, which can embed a non-ASCII working
 * directory (the `root <dir>` header and every error message).
 *
 * The glyph mapping is the same one `normalizeOutput` uses, so an unmapped
 * character becomes "?" instead of leaking a raw byte.
 *
 * @param {string} text
 * @returns {string}
 */
function asciiSafe(text) {
  return text
    .replaceAll("\r\n", "\n")
    .replace(ANSI_PATTERN, "")
    .replace(NON_ASCII_PATTERN, (character) => GLYPH_FOLDS.get(character) ?? "?");
}

/**
 * Print one aggregator-owned line, ASCII-folded. An empty call prints the blank
 * separator line between segments.
 *
 * @param {string} [text]
 * @returns {void}
 */
function printLine(text = "") {
  console.log(text === "" ? "" : asciiSafe(text));
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
    asciiSafe(output)
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
    printLine(line === "" ? "" : `${OUTPUT_INDENT}${line}`);
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

  printLine();

  if (failed.length === 0) {
    printLine(`verify: ${results.length}/${results.length} segments passed in ${duration}`);

    return;
  }

  printLine(`verify: ${failed.length} of ${results.length} segments FAILED in ${duration}`);
  printLine(`  FAILED: ${failed.map((result) => result.label).join(", ")}`);
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

  printLine("hint: git hooks are not installed; run: pnpm hooks:install");
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
