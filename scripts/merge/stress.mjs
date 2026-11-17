/**
 * Synthetic load on the merge loop: many small messages, one message per id.
 *
 * Run with `node scripts/merge/stress.mjs`, or pass `--messages` and `--deltas`
 * to change the shape (`--messages 10000 --deltas 2` is the default).
 *
 * Why this shape and not a recording: the recordings are small and capped by
 * what the engine happened to emit, while the merge loop's tables are bounded by
 * counts it chose (512 assembling messages, 4096 remembered frames, 256 buffered
 * frames). Only a synthetic stream can push past those bounds, which is where a
 * growth bug would show up: if the tables leaked, RSS would climb with the frame
 * count instead of flattening once the bounds are reached.
 *
 * The generator makes the easy mistakes impossible to hit by accident: every
 * message id is unique, every `seq_id` starts at one and increments, and
 * `event_seq` is one global counter. So the expected result is exact: one
 * `message.delta` per generated delta and no duplicate -- any difference is the
 * loop's fault, not the fixture's.
 *
 * What this does not measure: the transport, parsing, the renderer, or real
 * model output. The frames are built in memory and handed over already parsed;
 * the timing therefore covers classification, ordering, assembly and the change
 * objects, and the RSS covers the loop's own tables plus the input generated so
 * far (frames are not retained).
 *
 * Failure is reported, not thrown: the run prints what went wrong, sets a
 * non-zero exit code, and prints `OK` only when every check passed.
 */

import process from "node:process";

import { loadMergeModule } from "./lib.mjs";

/** Defaults: enough messages to cross every bound once, with two deltas each. */
const DEFAULTS = { messages: 10_000, deltas: 2 };

/** How often to sample RSS while the run is in progress. */
const RSS_SAMPLE_EVERY = 1000;

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
 * @returns {{ messages: number, deltas: number }} the options
 */
function parseArguments(argv) {
  const options = { ...DEFAULTS };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--messages" || argument === "--deltas") {
      const key = argument.slice(2);

      options[key] = positiveInteger(argv[index + 1] ?? "", argument);
      index += 1;
    } else if (argument.startsWith("--messages=")) {
      options.messages = positiveInteger(argument.slice("--messages=".length), "--messages");
    } else if (argument.startsWith("--deltas=")) {
      options.deltas = positiveInteger(argument.slice("--deltas=".length), "--deltas");
    } else {
      throw new Error(
        `unknown argument ${JSON.stringify(argument)}; usage: --messages <count> --deltas <count>`,
      );
    }
  }

  return options;
}

/**
 * Build one synthetic assistant delta frame.
 *
 * @param {string} messageId the message this delta belongs to
 * @param {string} runId the run this delta belongs to
 * @param {number} runSeq the delta's position in the message, from one
 * @param {number} eventSeq the global event sequence number
 * @returns {object} a frame shaped like the channel's
 */
function syntheticFrame(messageId, runId, runSeq, eventSeq) {
  return {
    type: "stream_delta",
    raw: {
      type: "stream_delta",
      delta: {
        type: "message",
        message_type: "assistant_message",
        id: messageId,
        agent_id: "bench",
        conversation_id: "default",
        run_id: runId,
        seq_id: runSeq,
        content: [{ type: "text", text: `p${runSeq};` }],
      },
      runtime: { agent_id: "bench", conversation_id: "default" },
    },
    at: eventSeq,
    envelope: {
      event_seq: eventSeq,
      runtime: { agent_id: "bench", conversation_id: "default" },
    },
  };
}

/**
 * The nearest-rank percentile of a sorted list.
 *
 * @param {number[]} sorted ascending samples
 * @param {number} fraction percentile as a percentage
 * @returns {number} the sample at that rank
 */
function percentile(sorted, fraction) {
  if (sorted.length === 0) {
    return 0;
  }

  const rank = Math.ceil((fraction / 100) * sorted.length);

  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Run the synthetic load and check the loop's own accounting.
 *
 * @param {object} module the merge module's exports
 * @param {{ messages: number, deltas: number }} options the load shape
 * @returns {{ failures: string[], summary: object }} what failed and what was measured
 */
function run(module, options) {
  const merger = module.createEventMerger({ agentId: "bench" });
  const frameCount = options.messages * options.deltas;

  /** @type {number[]} */
  const samples = new Array(frameCount);
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  let deltas = 0;
  let changes = 0;
  let eventSeq = 0;
  let sampleIndex = 0;

  const startedAt = process.hrtime.bigint();

  for (let messageIndex = 0; messageIndex < options.messages; messageIndex += 1) {
    const messageId = `bench-msg-${messageIndex}`;
    const runId = `bench-run-${messageIndex}`;

    for (let runSeq = 1; runSeq <= options.deltas; runSeq += 1) {
      eventSeq += 1;

      const frame = syntheticFrame(messageId, runId, runSeq, eventSeq);
      const before = process.hrtime.bigint();
      const produced = merger.ingest(frame);
      const after = process.hrtime.bigint();

      samples[sampleIndex] = Number(after - before);
      sampleIndex += 1;

      for (const change of produced) {
        changes += 1;

        if (change.kind === "message.delta") {
          deltas += 1;
        }
      }

      if (sampleIndex % RSS_SAMPLE_EVERY === 0) {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
    }
  }

  const totalNs = Number(process.hrtime.bigint() - startedAt);
  const sorted = [...samples].sort((left, right) => left - right);
  const stats = merger.stats();

  /** @type {string[]} */
  const failures = [];

  if (deltas !== frameCount) {
    failures.push(`expected ${frameCount} message.delta changes, saw ${deltas}`);
  }

  if (stats.duplicates !== 0) {
    failures.push(`expected no duplicates, saw ${stats.duplicates}`);
  }

  // Not required for the load, but a gap or a late frame under a strictly
  // increasing stream would mean the ordering gate is losing frames it shouldn't.
  if (stats.late !== 0) {
    failures.push(`expected no late frames, saw ${stats.late}`);
  }

  if (stats.gaps !== 0) {
    failures.push(`expected no gaps, saw ${stats.gaps}`);
  }

  return {
    failures,
    summary: {
      frames: frameCount,
      changes,
      deltas,
      totalNs,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      initialRss,
      peakRss,
      duplicates: stats.duplicates,
    },
  };
}

/**
 * Print the method and the environment above the numbers they produced.
 *
 * @param {{ messages: number, deltas: number }} options the load shape
 */
function printMethod(options) {
  console.log(
    `environment: platform=${process.platform} arch=${process.arch} node=${process.version}`,
  );
  console.log("method:      single-threaded, in-process, synchronous; the merge loop only --");
  console.log("             frames are generated already parsed and are not retained, so RSS is");
  console.log("             the loop's tables plus the frame being processed, not the input.");
  console.log("             RSS is sampled periodically, so the peak is a sampled peak.");
  console.log("limits:      no transport, no renderer, no IPC, no real model output; shape is");
  console.log(
    `             ${options.messages} messages x ${options.deltas} deltas with generated ids and`,
  );
  console.log("             sequences, so the expected result is exact. Absolute numbers");
  console.log("             depend on this machine and are an order of magnitude only.");
  console.log("");
}

/**
 * Measure, print, and report pass or failure.
 */
async function main() {
  const options = parseArguments(process.argv.slice(2));

  // Imported inside the handler so a load failure is reported by the same path
  // as a failed check instead of crashing with a stack trace.
  const module = await loadMergeModule();

  printMethod(options);

  const { failures, summary } = run(module, options);
  const peakMb = summary.peakRss / (1024 * 1024);
  const initialMb = summary.initialRss / (1024 * 1024);

  console.log(
    `load:         ${options.messages} messages x ${options.deltas} deltas = ${summary.frames} frames`,
  );
  console.log(
    `result:       total=${(summary.totalNs / 1e6).toFixed(2)} ms  ` +
      `p50=${Math.round(summary.p50)} ns  p95=${Math.round(summary.p95)} ns  ` +
      `p99=${Math.round(summary.p99)} ns`,
  );
  console.log(
    `memory:       rss start=${initialMb.toFixed(1)} MB  peak=${peakMb.toFixed(1)} MB  ` +
      `(+${(peakMb - initialMb).toFixed(1)} MB)`,
  );
  console.log(
    `accounting:   changes=${summary.changes}  message.delta=${summary.deltas}  ` +
      `duplicates=${summary.duplicates}`,
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }

    process.exitCode = 1;

    return;
  }

  console.log("OK");
}

try {
  await main();
} catch (error) {
  console.error(`stress failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
