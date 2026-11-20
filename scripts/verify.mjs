#!/usr/bin/env node
/**
 * verify.mjs - the one command behind the repository promise
 * ("a single local command runs every gate").
 *
 * Default mode (`pnpm verify`) runs the default segments, in this order:
 *
 *   typecheck, lint, boundaries, literals, gate self-test, contract, tokens,
 *   i18n, fixtures, frame, capabilities, docs, test, file size.
 *
 * Each segment owns its justification, next to its definition below. The two
 * shell segments (typecheck and build for an app shell) are appended when a
 * shell package is present, so the printed count is larger in this repository.
 * `--full` (`pnpm verify:full`) appends the two O(file count) repository
 * discipline gates, cycles and module ownership, which are not part of the
 * package-boundary judgement.
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
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { fail, toPosix } from "./lib/gate-cli.mjs";
import { runCommand } from "./lib/verify-command.mjs";
import { hooksInstalled } from "./lib/verify-hooks.mjs";
import { shellBuildSegments, shellTypecheckSegments } from "./lib/verify-shells.mjs";

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

/** One-run vitest config; fixed name so a crashed run leaves a findable file. */
const VITEST_CONFIG_NAME = "vitest.verify.generated.mts";
/** Set when the config has been written, so cleanup can be conditional. */
let VITEST_CONFIG_PATH = null;

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
 * Per-segment wall-clock limits, in milliseconds.
 *
 * `spawnSync` had no `timeout` at all, so the "new segment <= 20 s, whole run
 * <= 60 s" budget was documentation rather than a constraint: a segment that
 * hung (a watcher that never exits, a lock file, a browser that will not start)
 * made `pnpm verify` wait forever instead of failing. A limit turns that into a
 * reported failure, which is the only outcome a CI box can act on.
 *
 * The default is generous against the measured run (the whole thing is ~60 s) so
 * a slow machine does not produce a spurious red; the point is to bound a hang,
 * not to police a second.
 */
const SEGMENT_TIMEOUT_MS = 180_000;

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
  "scripts/check-frame.test.ts",
  "scripts/check-forbidden-literals.test.ts",
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
 * @property {boolean} [notProven] With `skipReason`: the gate exists but did not
 *   run, so the summary must not call the run a pass.
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
    const options = {
      root: toPosix(process.cwd()),
      full: flags.full,
      verbose: flags.verbose,
      noSize: flags.noSize,
    };

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

    printSummary(results, seconds, options.root);
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
  const flags = { full: false, verbose: false, noSize: false };

  for (const arg of argv) {
    if (arg === "--full") {
      flags.full = true;
    } else if (arg === "--verbose") {
      flags.verbose = true;
    } else if (arg === "--no-size") {
      // Skips the file-size segment. This is for the inner loop only: the run
      // is then not a pass, and the summary says so. See buildSegments.
      flags.noSize = true;
    } else {
      throw new Error(`unknown argument: ${arg} (supported: --full, --verbose, --no-size)`);
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
 * a vitest segment lists test files after the runner's own path. Anything else
 * (a pnpm workspace-wide command, a flag) contributes nothing.
 *
 * @param {Segment} segment
 * @returns {string[]}
 */
function segmentInputs(segment) {
  const { command, args } = segment.command();
  const inputs = [];

  // A gate segment runs `process.execPath <script>`; only the script counts.
  // The vitest segment now spawns the runner through `process.execPath` too, so
  // the check above would otherwise claim the runner path as an input. The
  // runner is a dependency, not a repository file, and the test paths follow it.
  if (command === process.execPath && args.length > 0 && !args[0].startsWith("-")) {
    if (!TEST_FILE_PATTERN.test(args[0]) && !args[0].includes("vitest")) {
      inputs.push(args[0]);
    }
  }

  for (const arg of args) {
    if (TEST_FILE_PATTERN.test(arg)) {
      inputs.push(arg);
    }
  }

  return inputs;
}

/**
 * Describe the nine base segments (plus three under --full).
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
    ...shellTypecheckSegments(options.root),
    ...shellBuildSegments(options.root),
    {
      label: "lint",
      command: () => ({ command: "pnpm", args: ["exec", "eslint", "."] }),
    },
    {
      label: "boundaries",
      command: () => gate("scripts/check-boundaries.mjs", options.verbose),
    },
    {
      label: "literals",
      command: () => gate("scripts/check-forbidden-literals.mjs", options.verbose),
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
      // Corpus shape for the recorded fixtures: one message per line, a header
      // that carries `schemaVersion`, and a message shape that matches the kind
      // the header claims. Same reasoning as `i18n` for the position: a broken
      // fixture should be named by the segment that owns it, not surface as a
      // confusing failure in the replay tests that read it.
      //
      // Redaction and the version-alignment warning live in the same script.
      label: "fixtures",
      command: () => gate("scripts/check-fixtures.mjs", options.verbose),
    },
    {
      // Frame type registration: source literals against the declared type table.
      label: "frame",
      command: () => gate("scripts/check-frame.mjs", options.verbose),
    },
    {
      // The shell must not name a capability; the allowlisted sample's literals
      // are checked against capabilities.json so the exception cannot hide a typo.
      label: "capabilities",
      command: () => gate("scripts/check-capabilities.mjs", options.verbose),
    },
    {
      // The public documents are reader-facing assets, so a stale command table, a
      // status section that does not say which commit it describes, or a private
      // identifier in a README is a defect rather than a note. Text only and cheap,
      // so it runs before `test`, where a documentation failure would otherwise be
      // reported as a confusing test result.
      label: "docs",
      command: () => gate("scripts/docs/check-public-docs.mjs", options.verbose),
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
      // The exit code decides this segment. Full stop.
      //
      // It used to be `run.status === 0 || COVERAGE_REPORT_PATTERN.test(...)`,
      // and that second half made the segment unable to fail for the one thing
      // it exists to catch. A run with every test passing but an unhandled
      // rejection exits 1 AND prints the coverage table -- measured in this repo:
      // `Test Files 1 passed`, `Unhandled Rejection`, exit 1, table present. The
      // gate therefore reported `[8/8] test PASS` for a process that had crashed
      // on a stray promise. `--coverage.reportOnFailure` would widen the same
      // hole further, because then even red tests print the table.
      //
      // The coverage contract is still honoured -- it is advisory, so a thin
      // table is deliberately not a failure -- but "advisory" means it cannot
      // *rescue* a failing run, only fail to add one.
      evaluate: (run) => run.status === 0,
      notes: [
        "coverage is advisory: no threshold, uncovered code never fails verify",
        "in-process coverage of scripts/ stays low because gates run as child processes",
      ],
    },
    // The file-size gate belongs in the default set, not behind `--full`.
    //
    // It ran only under `--full`, and `--full` is a deliberate hassle to run, so
    // it was never run before a landing: `main` reached 1085 lines in
    // `packages/core/src/engine/engine.ts` while every landing reported a green
    // run. A gate nobody runs on the path that matters is not a gate. The
    // segment costs about 0.2 s, so there is no reason to keep it out.
    {
      label: "file size",
      // `notProven` so the summary says this run is not a pass when skipped.
      notProven: options.noSize,
      skipReason: options.noSize
        ? "--no-size given: the size gate did not run, so this run is not a pass"
        : undefined,
      command: () => gate("scripts/check-file-size.mjs", false),
    },
  ];

  if (options.full) {
    segments.push(
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
 * Build the vitest invocation for a set of test files.
 *
 * The file list goes in a generated config, not on the command line: `cmd.exe`
 * caps one command at 8191 characters (7996 passes, 8196 is refused), 191 test
 * files spell 8752, and every segment is spawned through a shell -- so calling
 * the runner directly does not dodge it and the selection moves out of argv.
 *
 * @param {string[]} files repo-relative test paths
 * @param {string[]} [extraArgs] additional vitest flags
 * @returns {{ command: string, args: string[] }}
 */
function vitest(files, extraArgs = []) {
  // `options.root` is `process.cwd()` here: this helper runs while building
  // segments, before any segment runs, so the cwd is still the repository root.
  const root = process.cwd();
  const runner = path.join(root, "node_modules", "vitest", "vitest.mjs");
  const config = path.join(root, VITEST_CONFIG_NAME);
  // Spread it: a config that only lists `include` also drops `setupFiles`.
  const base = path.join(root, "vitest.config.mts").replaceAll("\\", "/");
  writeFileSync(
    config,
    `import base from ${JSON.stringify(base)};\n` +
      `export default { ...base, test: { ...base.test, include: ${JSON.stringify(files)} } };\n`,
  );
  VITEST_CONFIG_PATH = config;
  return { command: process.execPath, args: [runner, "run", "--config", config, ...extraArgs] };
}

/**
 * Every test file the gate will run, as repo-relative posix paths.
 *
 * Three roots, each with the rule its own tree follows:
 *
 * - `scripts/**`, written whole -- a gate self-test sits next to the gate it
 *   exercises and a gate may live in a subdirectory.
 * - `packages/<name>/src/**` and `apps/<name>/src/**`, co-located with the
 *   source they cover.
 * - `apps/<name>/scripts/**`, tests covering a script rather than app source:
 *   the config listed this root and this list did not, so those files never ran
 *   here while the segment reported green.
 *
 * The `<name>/src/` shape is spelled out rather than implied by the walk, because
 * it has to agree with `vitest.config.mts`'s `include` list exactly. When the two
 * disagreed, this function collected a test file that vitest's own include
 * pattern then refused, and the whole segment failed with "no test files found"
 * for a file sitting right there.
 *
 * The tree is walked rather than globbed because this script has no dependencies.
 * `SKIPPED_TEST_DIRS` is skipped everywhere: the `fixtures` trees are deliberately
 * broken and must never be collected as tests, and a nested worktree or a
 * published copy is not this repository's source.
 *
 * This segment is the only one that runs the unit tests; the verdict and the
 * numbers come from that one run.
 *
 * @param {string} root Absolute repository root.
 * @returns {string[]}
 */
function discoverTestFiles(root) {
  /** @type {Array<{ top: string, pattern: RegExp }>} */
  const roots = [
    { top: "scripts", pattern: /^scripts\/.*\.test\.ts$/ },
    { top: "packages", pattern: /^packages\/[^/]+\/src\/.*\.test\.tsx?$/ },
    { top: "apps", pattern: /^apps\/[^/]+\/src\/.*\.test\.tsx?$/ },
    { top: "apps", pattern: /^apps\/[^/]+\/scripts\/.*\.test\.ts$/ },
  ];

  /**
   * @param {string} relative Repo-relative posix directory.
   * @returns {string[]}
   */
  function walk(relative) {
    const absolute = path.join(root, relative);

    if (!existsSync(absolute)) return [];

    const found = [];

    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      // A dot-directory is never our source, and `.git` alone would make the walk
      // expensive. `node_modules` and `dist` are covered by the skip set.
      if (entry.name.startsWith(".")) continue;

      const child = relative + "/" + entry.name;

      if (entry.isDirectory()) {
        if (!SKIPPED_TEST_DIRS.has(entry.name)) found.push(...walk(child));
      } else if (TEST_FILE_PATTERN.test(entry.name)) {
        found.push(child);
      }
    }

    return found;
  }

  return roots.flatMap(({ top, pattern }) => walk(top).filter((file) => pattern.test(file))).sort();
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

    // Two kinds of skip, and they must not look alike.
    //
    // `notProven` marks a segment whose gate exists and would say something, but
    // was turned off for this run (`--no-size`). It prints SKIP and the summary
    // refuses to call the run a pass.
    //
    // A plain skip is a segment with nothing to do -- the test set is empty --
    // which is PASS in the only sense available: it could not have failed.
    const notProven = segment.notProven === true;

    printLine(`[${position}/${total}] ${segment.label}  ${notProven ? "SKIP" : "PASS"}  0.00s`);

    return notProven
      ? { label: segment.label, passed: true, skipped: true }
      : { label: segment.label, passed: true };
  }

  const started = performance.now();
  const run = runSegmentCommand(segment.command(), options);
  const seconds = (performance.now() - started) / 1000;
  const passed = segment.evaluate === undefined ? run.status === 0 : segment.evaluate(run);

  // A segment that never started is not a red test, and the two need different
  // repairs: one is a broken gate, the other is broken code.
  const couldNotRun =
    !passed && run.timedOut !== true && (run.spawnFailed === true || run.output.trim() === "");

  // The generated config is removed on success and kept on failure.
  if (segment.label === "test") settleVitestConfig(passed);

  if (options.verbose || !passed) {
    replay(run.output);
  }

  const verdict = passed ? "PASS" : couldNotRun ? "COULD-NOT-RUN" : "FAIL";

  printLine(`[${position}/${total}] ${segment.label}  ${verdict}  ${formatSeconds(seconds)}`);

  if (!passed) {
    if (couldNotRun) {
      printLine(
        `${OUTPUT_INDENT}this segment could not run: nothing was exercised, so nothing is proven about the code`,
      );
    }

    if (run.spawnFailed) {
      printLine(`${OUTPUT_INDENT}the command could not be started at all`);
    } else if (run.output.trim() === "") {
      printLine(
        `${OUTPUT_INDENT}the segment exited with status ${String(run.status)} and printed nothing`,
      );
    }

    if (segment.warning !== undefined) {
      printLine(`${OUTPUT_INDENT}${segment.warning}`);
    }
  }

  // Notes describe why a passing segment is trustworthy, so printing them under
  // a FAIL reads as if the explanation still applies. It does not: "coverage is
  // advisory" means nothing about a run that died.
  if (passed) {
    for (const note of segment.notes ?? []) {
      printLine(`${OUTPUT_INDENT}note: ${note}`);
    }
  }

  return couldNotRun
    ? { label: segment.label, passed, couldNotRun: true }
    : { label: segment.label, passed };
}

/**
 * Run one segment's command with this run's settings. The launch itself lives in
 * `lib/verify-command.mjs`: it needs both start forms and the platform rules that
 * pick one, and this file is already the aggregator's largest.
 *
 * @param {Command} command
 * @param {VerifyOptions} options
 * @returns {RunResult}
 */
function runSegmentCommand(command, options) {
  return runCommand(command, {
    cwd: options.root,
    timeoutMs: SEGMENT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
    normalize: normalizeOutput,
  });
}

/**
 * Remove the one-run config, or keep it and say where it is: a pass wants the
 * file gone, a failure wants the selection it died with.
 *
 * @param {boolean} passed whether the vitest segment proved its contract
 */
function settleVitestConfig(passed) {
  if (VITEST_CONFIG_PATH === null) return;

  // The self-test reads the file after a pass, which is otherwise when it goes.
  if (passed && process.env.HARUYUKI_KEEP_VITEST_CONFIG !== "1") {
    rmSync(VITEST_CONFIG_PATH, { force: true });
    VITEST_CONFIG_PATH = null;
    return;
  }
  printLine(`${OUTPUT_INDENT}kept this run's vitest config: ${VITEST_CONFIG_PATH}`);
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
function printSummary(results, seconds, root) {
  const failed = results.filter((result) => !result.passed);
  const skipped = results.filter((result) => result.skipped === true);
  const duration = `${seconds.toFixed(1)}s`;

  printLine();

  // The tree this ran in, on the line people paste. Two checkouts of the same
  // commit can disagree, so "green" without a location is a fact about an unknown
  // directory.
  printLine(`verify: root ${root}`);

  if (failed.length === 0) {
    printLine(`verify: ${results.length}/${results.length} segments passed in ${duration}`);

    // A run with a skipped segment is reported as incomplete, not as a pass.
    // `--no-size` exists to shorten the inner loop; it must never read as
    // "everything is green" in a log someone later trusts.
    if (skipped.length > 0) {
      printLine(
        `  NOT A PASS: ${String(skipped.length)} segment(s) did not run ` +
          `(${skipped.map((result) => result.label).join(", ")}); re-run without the skip flag`,
      );
    }

    return;
  }

  const couldNotRun = failed.filter((result) => result.couldNotRun === true);
  const red = failed.filter((result) => result.couldNotRun !== true);

  // All-red keeps the old wording: a caller reading logs greps for FAILED, and
  // "did not pass" is reserved for a run that includes a segment that never
  // started, where calling it a failure would blame the wrong thing.
  printLine(
    couldNotRun.length === 0
      ? `verify: ${failed.length} of ${results.length} segments FAILED in ${duration}`
      : `verify: ${failed.length} of ${results.length} segments did not pass in ${duration}`,
  );

  if (red.length > 0) {
    printLine(`  FAILED: ${red.map((result) => result.label).join(", ")}`);
  }

  if (couldNotRun.length > 0) {
    printLine(
      `  COULD NOT RUN: ${couldNotRun.map((result) => result.label).join(", ")} ` +
        `(the gate did not start, so the code under it was never exercised)`,
    );
  }
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
