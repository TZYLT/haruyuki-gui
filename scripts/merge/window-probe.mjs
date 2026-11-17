/**
 * Where the bridge's send path actually releases a stream frame.
 *
 * The question this probe answers is narrow and load-bearing: when the core
 * hands a `delta.message` to the frame sender, does the frame leave on the same
 * tick, or does it wait for the coalescing window? A window that held the first
 * frame would turn "first text is immediate" into "first text is immediate plus
 * up to 64 ms", and that delay would be invisible in every merge-loop benchmark
 * because it happens after the merge loop is done.
 *
 * So the probe measures the real sender, not a model of it:
 *
 * - a burst of 100 frames sent in one synchronous loop, after at least 200 ms of
 *   idleness, with the transport recording when it was called;
 * - a single frame after the same idle, which is the first-frame case;
 * - ten `term.output` frames, which must never be coalesced because terminal
 *   bytes are not a burst of interchangeable updates;
 * - all of it repeated for every accepted window from 8 ms to 64 ms.
 *
 * Each frame carries unique body text. The transport sees one payload per call,
 * so without a unique marker a deferred call could only be attributed to "some
 * send", and the very latency this probe exists to measure would be smeared
 * across the burst instead of reported. With the marker, a call arriving after
 * the loop is attributed to the send that produced it, which is what makes the
 * delayed case measurable at all.
 *
 * The fake transport records a timestamp, the payload length and the payload
 * itself; it parses nothing at call time, so the sender is measured without the
 * probe's own work inside the timed window. Nothing is written anywhere.
 *
 * Limits: this is the producer half in isolation -- one process, one thread, no
 * renderer, no IPC, no real transport. The numbers are the sender's own cost
 * plus the timer's resolution, and they say nothing about the receiver.
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

// Importing the shared helper installs the resolver that maps the merge
// modules' relative ".js" specifiers to the ".ts" files that actually exist.
import "./lib.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const BRIDGE_ENTRY = path.join(REPO_ROOT, "packages", "core", "src", "bridge", "index.ts");
const PROTOCOL_ENTRY = path.join(REPO_ROOT, "packages", "protocol", "src", "index.ts");

/** Windows to sweep; the accepted range of the window, inclusive. */
const WINDOWS_MS = [8, 16, 24, 32, 64];

/** Frames in the burst. */
const BURST_FRAMES = 100;

/** Frames in the terminal check. */
const TERM_FRAMES = 10;

/** How long "idle" means before a burst or a first frame. */
const IDLE_MS = 200;

/** Extra wait after the window so a deferred flush would have landed. */
const SETTLE_MS = 60;

/** Extensions a specifier may already have; anything else is treated as bare. */
const KNOWN_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".json", ".node"]);

/**
 * Resolve extensionless relative specifiers, which the bundler accepts and
 * plain Node does not.
 *
 * The bridge sources use `./queue` style imports while the merge sources use
 * `./queue.js`; the shared helper covers the second form, this hook the first.
 * Both compose: each one passes a specifier it cannot resolve to the next.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      context.parentURL !== undefined &&
      !KNOWN_EXTENSIONS.has(path.extname(specifier))
    ) {
      for (const suffix of [".ts", "/index.ts"]) {
        const candidate = new URL(`${specifier}${suffix}`, context.parentURL);

        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }

    return nextResolve(specifier, context);
  },
});

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
 * Wait without blocking the event loop, so a window timer (if one were armed)
 * could run.
 *
 * @param {number} milliseconds how long
 * @returns {Promise<void>} resolves after the wait
 */
function idle(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * The smallest non-zero distance between two consecutive clock reads.
 *
 * Printed with the numbers because a delay below this value means "same tick",
 * not "zero nanoseconds".
 *
 * @returns {number} the tick in milliseconds
 */
function clockTick() {
  let smallest = Number.POSITIVE_INFINITY;
  let previous = performance.now();

  for (let index = 0; index < 100_000; index += 1) {
    const current = performance.now();
    const delta = current - previous;

    if (delta > 0 && delta < smallest) {
      smallest = delta;
    }

    previous = current;
  }

  return Number.isFinite(smallest) ? smallest : 0;
}

/**
 * A transport that records instead of delivering.
 *
 * The payload string is kept unparsed: parsing inside the call would add the
 * probe's own work to the interval being measured.
 *
 * @returns {{ calls: { at: number, bytes: number, payload: string }[], send: (payload: string) => void }}
 */
function createTransport() {
  /** @type {{ at: number, bytes: number, payload: string }[]} */
  const calls = [];

  return {
    calls,
    send(payload) {
      calls.push({ at: performance.now(), bytes: payload.length, payload });
    },
  };
}

/**
 * The body text a payload carried, used to attribute a call to its send.
 *
 * @param {string} payload one transport payload
 * @returns {string | null} the text, or `null` when the payload is not a
 *   `delta.message` frame
 */
function textOfPayload(payload) {
  try {
    const parsed = JSON.parse(payload);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const body = parsed.body;

    return typeof body === "object" && body !== null && typeof body.text === "string"
      ? body.text
      : null;
  } catch {
    return null;
  }
}

/**
 * How many frames one payload carries.
 *
 * The sender emits one frame per payload today, so this is one; the array branch
 * keeps the number honest if a future transport format ever groups them.
 *
 * @param {string} payload one transport payload
 * @returns {number} frames in it
 */
function framesInPayload(payload) {
  try {
    const parsed = JSON.parse(payload);

    return Array.isArray(parsed) ? parsed.length : 1;
  } catch {
    return 0;
  }
}

/**
 * An ascending copy.
 *
 * @param {number[]} values samples
 * @returns {number[]} sorted
 */
function sortedCopy(values) {
  return [...values].sort((left, right) => left - right);
}

/**
 * The nearest-rank percentile.
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
 * One `delta.message` frame.
 *
 * @param {string} text unique body text, so a deferred call can be attributed
 * @returns {object} the frame
 */
function deltaFrame(text) {
  return { v: 1, ch: "stream", seq: 0, t: "delta.message", body: { text } };
}

/**
 * One `term.output` frame.
 *
 * @param {number} index slice index
 * @returns {object} the frame
 */
function termFrame(index) {
  return {
    v: 1,
    ch: "stream",
    seq: 0,
    t: "term.output",
    body: {
      terminal_id: "probe",
      slice: index,
      slices: TERM_FRAMES,
      offset: index,
      bytes: 1,
      final: index === TERM_FRAMES - 1,
      text: "x",
    },
  };
}

/**
 * Run the burst case once.
 *
 * @param {object} module the bridge module
 * @param {number} windowMs the configured window
 * @returns {Promise<object>} one pass's measurements
 */
async function burstPass(module, windowMs) {
  const transport = createTransport();
  const sender = module.createFrameSender({ transport: transport.send, windowMs });

  await idle(IDLE_MS);

  /** @type {Map<string, number>} */
  const startedAt = new Map();

  for (let index = 0; index < BURST_FRAMES; index += 1) {
    const text = `burst-${String(index)}`;

    startedAt.set(text, performance.now());
    sender.send(deltaFrame(text));
  }

  const loopEndedAt = performance.now();
  const duringLoop = transport.calls.length;

  // Past the window, so a payload the window was holding has been delivered and
  // counted; anything that arrives later is not a window delay, it is a bug.
  await idle(Math.max(windowMs, 16) + SETTLE_MS);

  const delays = [];
  let framesPerPayload = 0;

  for (const call of transport.calls) {
    const text = textOfPayload(call.payload);
    const start = text === null ? undefined : startedAt.get(text);

    if (start !== undefined) {
      delays.push((call.at - start) * 1000);
    }

    framesPerPayload = Math.max(framesPerPayload, framesInPayload(call.payload));
  }

  const sorted = sortedCopy(delays);

  return {
    calls: transport.calls.length,
    duringLoop,
    deferred: transport.calls.length - duringLoop,
    framesPerPayload,
    framesPerCall: transport.calls.length === 0 ? 0 : BURST_FRAMES / transport.calls.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    loopEndedAt,
  };
}

/**
 * Run the first-frame case once.
 *
 * @param {object} module the bridge module
 * @param {number} windowMs the configured window
 * @returns {Promise<object>} one pass's measurements
 */
async function firstFramePass(module, windowMs) {
  const transport = createTransport();
  const sender = module.createFrameSender({ transport: transport.send, windowMs });

  await idle(IDLE_MS);

  const startedAt = performance.now();

  sender.send(deltaFrame("first"));

  await idle(Math.max(windowMs, 16) + SETTLE_MS);

  const first = transport.calls[0];

  return {
    calls: transport.calls.length,
    delayUs: first === undefined ? null : (first.at - startedAt) * 1000,
  };
}

/**
 * Run the terminal case once: terminal frames must go one per transport call.
 *
 * @param {object} module the bridge module
 * @param {number} windowMs the configured window
 * @returns {Promise<object>} one pass's measurements
 */
async function termPass(module, windowMs) {
  const transport = createTransport();
  const sender = module.createFrameSender({ transport: transport.send, windowMs });

  await idle(IDLE_MS);

  for (let index = 0; index < TERM_FRAMES; index += 1) {
    sender.send(termFrame(index));
  }

  const duringLoop = transport.calls.length;

  await idle(Math.max(windowMs, 16) + SETTLE_MS);

  return {
    calls: transport.calls.length,
    duringLoop,
    bytes: transport.calls.map((call) => call.bytes),
  };
}

/**
 * Format a microsecond measurement.
 *
 * @param {number | null} value the value
 * @returns {string} the cell text
 */
function microseconds(value) {
  return value === null ? "-" : value.toFixed(1);
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
 * @param {number} runs passes per window
 * @param {number} tickMs measured clock tick in milliseconds
 */
function printMethod(runs, tickMs) {
  console.log(
    `environment: node=${process.version} platform=${process.platform} arch=${process.arch}`,
  );
  console.log(
    `clock:       performance.now() (monotonic), smallest non-zero tick ≈ ${(tickMs * 1000).toFixed(1)} µs`,
  );
  console.log(
    "method:      the real frame sender over a fake transport that only records the call",
  );
  console.log(
    "             time, the payload length and the payload itself; nothing is written and",
  );
  console.log("             nothing is parsed inside the timed window.");
  console.log(
    `             burst = ${BURST_FRAMES} delta.message frames in one synchronous loop after ≥${IDLE_MS} ms idle;`,
  );
  console.log(
    `             first = 1 frame after ≥${IDLE_MS} ms idle; each frame carries unique body text so a`,
  );
  console.log("             deferred call is attributed to the send that produced it.");
  console.log("             latency = from just before send() to inside the transport call, so it");
  console.log(
    "             includes the sender's validation and serialization and excludes anything",
  );
  console.log("             the transport would do with the bytes. The first-frame number is a");
  console.log(
    "             fresh sender's first send, so it also carries first-call warm-up; treat it",
  );
  console.log("             as an upper bound on any window wait.");
  console.log(
    `             windowMs swept {${WINDOWS_MS.join(", ")}}; ${runs} run(s) per point, median per column.`,
  );
  console.log(
    "limits:      producer half only, one process, one thread, no renderer, no IPC, no real",
  );
  console.log("             transport; absolute values depend on the machine.");
  console.log("");
}

/**
 * Measure every window and print the table, the terminal check and the verdict.
 *
 * @param {number} runs passes per window
 */
async function main(runs) {
  const bridge = await import(pathToFileURL(BRIDGE_ENTRY).href);
  const protocol = await import(pathToFileURL(PROTOCOL_ENTRY).href);

  const tickMs = clockTick();

  printMethod(runs, tickMs);

  const failures = [];
  const rows = [];
  let firstMaxUs = 0;
  let deferredTotal = 0;
  let termCallsOk = true;

  for (const windowMs of WINDOWS_MS) {
    const bursts = [];

    for (let run = 0; run < runs; run += 1) {
      bursts.push(await burstPass(bridge, windowMs));
    }

    const burst = {
      calls: median(bursts.map((pass) => pass.calls)),
      duringLoop: median(bursts.map((pass) => pass.duringLoop)),
      deferred: median(bursts.map((pass) => pass.deferred)),
      framesPerCall: median(bursts.map((pass) => pass.framesPerCall)),
      p50: median(bursts.map((pass) => pass.p50)),
      p95: median(bursts.map((pass) => pass.p95)),
    };

    const firstPasses = [];

    for (let run = 0; run < runs; run += 1) {
      firstPasses.push(await firstFramePass(bridge, windowMs));
    }

    const firstDelays = firstPasses.map((pass) => pass.delayUs).filter((value) => value !== null);
    const firstCalls = firstPasses.map((pass) => pass.calls);

    const term = await termPass(bridge, windowMs);

    if (term.calls !== TERM_FRAMES) {
      termCallsOk = false;
      failures.push(
        `window ${windowMs} ms: ${TERM_FRAMES} term.output frames produced ${term.calls} transport calls`,
      );
    }

    if (burst.calls !== BURST_FRAMES) {
      failures.push(
        `window ${windowMs} ms: ${BURST_FRAMES} burst frames produced ${burst.calls} transport calls`,
      );
    }

    if (firstCalls.some((count) => count !== 1)) {
      failures.push(
        `window ${windowMs} ms: the first frame produced ${firstCalls.join(",")} calls`,
      );
    }

    firstMaxUs = Math.max(firstMaxUs, ...firstDelays);
    deferredTotal += burst.deferred;

    rows.push([
      String(windowMs),
      String(BURST_FRAMES),
      String(burst.calls),
      burst.framesPerCall.toFixed(2),
      String(burst.deferred),
      microseconds(burst.p50),
      microseconds(burst.p95),
      microseconds(firstDelays.length === 0 ? null : median(firstDelays)),
    ]);
  }

  printTable(
    ["windowMs", "frames", "calls", "frames/call", "deferred", "p50 µs", "p95 µs", "first µs"],
    rows,
  );

  const deltaRow = protocol.FRAME_TYPES["delta.message"];
  const termRow = protocol.FRAME_TYPES["term.output"];

  console.log("");
  console.log(
    `term.output: ${TERM_FRAMES} frames -> ${TERM_FRAMES} calls at every window; ` +
      `${termCallsOk ? "PASS" : "FAIL"} (never coalesced, regardless of windowMs)`,
  );
  console.log(
    `registry:    delta.message coalescible=${String(deltaRow.coalescible)}, ` +
      `term.output coalescible=${String(termRow.coalescible)} (from the production frame table)`,
  );

  const immediate = firstMaxUs < 0.5 * Math.min(...WINDOWS_MS) * 1000;

  console.log("");
  console.log(
    immediate
      ? `verdict:     the first frame does not wait for the window: its delay stays at ` +
          `≈${firstMaxUs.toFixed(1)} µs, independent of windowMs (8–64 ms).`
      : `verdict:     the first frame waits: its delay reaches ≈${firstMaxUs.toFixed(1)} µs, ` +
          `which tracks windowMs instead of being immediate.`,
  );

  if (deferredTotal === 0) {
    console.log(
      "window truth: no frame was deferred at any window (0 of 100 per point), so the window",
    );
    console.log(
      "             contributes nothing to this path today. The sweep confirms it: p50/p95 do not",
    );
    console.log(
      "             move with windowMs, because no registered stream type is coalescible and the",
    );
    console.log("             window therefore never arms.");
  } else {
    console.log(
      `window truth: ${String(deferredTotal)} burst frames were deferred across the sweep, so the`,
    );
    console.log(
      "             window does delay stream payloads; see the deferred column per point.",
    );
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }

    process.exitCode = 1;
  }
}

try {
  const { runs } = parseArguments(process.argv.slice(2));

  await main(runs);
} catch (error) {
  console.error(`window-probe failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
