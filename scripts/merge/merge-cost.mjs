/**
 * What one merge loop costs per recorded session.
 *
 * Run with `node scripts/merge/merge-cost.mjs`, optionally `--runs 3` to take the
 * median of several passes (a single pass on a shared machine is a sample, not a
 * measurement).
 *
 * What is timed: the `ingest` call of the real merge loop, fed the frames a
 * recorded session produced, in recorded order. What is not timed: anything
 * around it. The recording's JSON is parsed before the loop by the fixture
 * loader, so parsing cost is not in these numbers; there is no shell, no
 * renderer, no IPC and no serialisation, because the merge loop does none of
 * those. Terminal frames are handed to the sink and counted, never written,
 * which is what the shell does with them but without the disk.
 *
 * "First text" here means: from the first assistant frame entering the loop to
 * the first `message.delta` change coming back out of `ingest`, in nanoseconds.
 * It is measured across calls rather than inside one, because a frame the
 * ordering gate holds does not produce text on the call that delivered it; a
 * measurement that stopped at the first assistant frame would report the gate's
 * buffering as if it were text latency.
 *
 * The honest limit: this is the merge segment only. End-to-end first text also
 * includes the transport, the reactor, IPC and a render commit, none of which
 * exist here. Absolute numbers depend on the machine, its load and its
 * temperature; they are useful as an order of magnitude and for comparing two
 * revisions on the same machine, not as a budget.
 */

import process from "node:process";

import { loadMergeModule, readAllRecordings } from "./lib.mjs";

/** Column headings for the results table; units are part of the heading. */
const HEADERS = [
  "recording",
  "frames",
  "p50 ns",
  "p95 ns",
  "p99 ns",
  "mean ns",
  "first ns",
  "changes",
  "total ms",
];

/**
 * Read a positive integer flag.
 *
 * @param {string} value the raw argument
 * @param {string} flag the flag it belongs to, for the error message
 * @returns {number} the value
 */
function positiveInteger(value, flag) {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} expects a positive integer, got ${JSON.stringify(value)}`);
  }

  return parsed;
}

/**
 * Parse the command line.
 *
 * @param {string[]} argv arguments after the script name
 * @returns {{ runs: number }} the options
 */
function parseArguments(argv) {
  let runs = 1;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--runs") {
      runs = positiveInteger(argv[index + 1] ?? "", "--runs");
      index += 1;
    } else if (argument.startsWith("--runs=")) {
      runs = positiveInteger(argument.slice("--runs=".length), "--runs");
    } else {
      throw new Error(`unknown argument ${JSON.stringify(argument)}; usage: --runs <count>`);
    }
  }

  return { runs };
}

/**
 * A sorted copy, so percentiles do not depend on the input order.
 *
 * @param {number[]} values samples
 * @returns {number[]} sorted ascending
 */
function sortedCopy(values) {
  return [...values].sort((left, right) => left - right);
}

/**
 * The nearest-rank percentile.
 *
 * Nearest-rank rather than interpolation because the question is "what did the
 * slow tail look like": a p95 that is an average of two samples describes a
 * latency that never happened.
 *
 * @param {number[]} sorted ascending samples
 * @param {number} fraction percentile as a percentage
 * @returns {number} the sample at that rank, or 0 for no samples
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }

  const rank = Math.ceil((fraction / 100) * sorted.length);

  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * The median of a list.
 *
 * @param {number[]} values samples
 * @returns {number} the median, or 0 for no samples
 */
function median(values) {
  const sorted = sortedCopy(values);

  if (sorted.length === 0) {
    return 0;
  }

  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Whether a frame is an assistant content delta.
 *
 * Used only to start the first-text clock. The merge loop still classifies the
 * payload itself; this check never decides what the payload means.
 *
 * @param {object} frame the frame
 * @returns {boolean} true when the frame carries assistant content
 */
function isAssistantDelta(frame) {
  if (frame.type !== "stream_delta" || frame.raw === null || typeof frame.raw !== "object") {
    return false;
  }

  const delta = frame.raw.delta;

  return delta !== null && typeof delta === "object" && delta.message_type === "assistant_message";
}

/**
 * Time one pass of one recording.
 *
 * @param {(options: object) => object} createEventMerger the merge loop factory
 * @param {object[]} frames the frames, in order
 * @returns {object} one pass's measurements
 */
function measureRecording(createEventMerger, frames) {
  let terminalFrames = 0;
  const merger = createEventMerger({
    agentId: "bench",
    onFrame: () => {
      terminalFrames += 1;
    },
  });

  /** @type {number[]} */
  const samples = new Array(frames.length);
  let changes = 0;
  /** @type {number | null} */
  let firstTextNs = null;
  /** @type {bigint | null} */
  let firstAssistantAt = null;

  const startedAt = process.hrtime.bigint();

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];

    if (firstAssistantAt === null && isAssistantDelta(frame)) {
      firstAssistantAt = process.hrtime.bigint();
    }

    const before = process.hrtime.bigint();
    const produced = merger.ingest(frame);
    const after = process.hrtime.bigint();

    samples[index] = Number(after - before);
    changes += produced.length;

    if (
      firstTextNs === null &&
      firstAssistantAt !== null &&
      produced.some((change) => change.kind === "message.delta")
    ) {
      firstTextNs = Number(after - firstAssistantAt);
    }
  }

  const totalNs = Number(process.hrtime.bigint() - startedAt);
  const sorted = sortedCopy(samples);

  return {
    frames: frames.length,
    changes,
    terminalFrames,
    firstTextNs,
    totalNs,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    mean:
      samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length,
  };
}

/**
 * Run one recording `runs` times and keep the median of every column.
 *
 * A fresh loop per pass: a merger carries state, and reusing one would measure
 * the second pass against a table the first already filled.
 *
 * @param {(options: object) => object} createEventMerger the merge loop factory
 * @param {object[]} frames the frames
 * @param {number} runs how many passes
 * @returns {object} the combined measurements
 */
function measureWithRuns(createEventMerger, frames, runs) {
  const passes = Array.from({ length: runs }, () => measureRecording(createEventMerger, frames));
  const firstTexts = passes.map((pass) => pass.firstTextNs).filter((value) => value !== null);

  return {
    frames: passes[0].frames,
    changes: median(passes.map((pass) => pass.changes)),
    terminalFrames: median(passes.map((pass) => pass.terminalFrames)),
    p50: median(passes.map((pass) => pass.p50)),
    p95: median(passes.map((pass) => pass.p95)),
    p99: median(passes.map((pass) => pass.p99)),
    mean: median(passes.map((pass) => pass.mean)),
    totalNs: median(passes.map((pass) => pass.totalNs)),
    firstTextNs: firstTexts.length === 0 ? null : median(firstTexts),
  };
}

/**
 * Format a nanosecond count as a whole number.
 *
 * @param {number | null} value the count
 * @returns {string} the cell text
 */
function nanoseconds(value) {
  return value === null ? "-" : String(Math.round(value));
}

/**
 * Print an aligned table.
 *
 * @param {string[]} headers column headings
 * @param {string[][]} rows cell text, one array per row
 */
function printTable(headers, rows) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length)),
  );

  const render = (cells) =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]),
      )
      .join("  ");

  console.log(render(headers));
  console.log(render(headers.map((header) => "-".repeat(header.length))));

  for (const row of rows) {
    console.log(render(row));
  }
}

/**
 * Print the method and the environment above the numbers they produced.
 *
 * @param {number} runs passes per recording
 * @param {number} recordings how many sessions were measured
 */
function printMethod(runs, recordings) {
  console.log(
    `environment: platform=${process.platform} arch=${process.arch} node=${process.version}`,
  );
  console.log("method:      single-threaded, in-process, synchronous; the merge loop only --");
  console.log("             no shell, no renderer, no IPC, no build step, no serialisation.");
  console.log("             frames are already-parsed objects, so JSON parsing is upstream and");
  console.log("             is not part of any number below; the clock itself adds tens of ns");
  console.log("             per sample. Terminal frames are counted into the sink, never written.");
  console.log("limits:      this is the merge segment, not end-to-end first text (transport,");
  console.log("             reactor, IPC and a render commit are all outside these numbers).");
  console.log("             Absolute values depend on this machine; treat them as an order of");
  console.log("             magnitude and compare runs on the same machine, not as a budget.");
  console.log("             A short session has few samples, so its p95 is close to its slowest");
  console.log("             frame -- usually the first one, which pays for the warm-up.");
  console.log(`scope:       ${recordings} recordings, ${runs} pass(es) each, median per column`);
  console.log("");
}

/**
 * Measure every recording and print the table.
 *
 * @param {number} runs passes per recording
 */
async function main(runs) {
  const { createEventMerger } = await loadMergeModule();
  const recordings = readAllRecordings();

  printMethod(runs, recordings.size);

  const rows = [];
  let totalFrames = 0;
  let totalChanges = 0;

  for (const [name, frames] of recordings) {
    const measured = measureWithRuns(createEventMerger, frames, runs);

    totalFrames += measured.frames;
    totalChanges += measured.changes;

    rows.push([
      name.replace(/\.jsonl$/, ""),
      String(measured.frames),
      nanoseconds(measured.p50),
      nanoseconds(measured.p95),
      nanoseconds(measured.p99),
      nanoseconds(measured.mean),
      nanoseconds(measured.firstTextNs),
      String(measured.changes),
      (measured.totalNs / 1e6).toFixed(2),
    ]);
  }

  printTable(HEADERS, rows);
  console.log("");
  console.log(`totals: ${totalFrames} frames, ${totalChanges} changes`);
}

try {
  const { runs } = parseArguments(process.argv.slice(2));

  await main(runs);
} catch (error) {
  console.error(`merge-cost failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
