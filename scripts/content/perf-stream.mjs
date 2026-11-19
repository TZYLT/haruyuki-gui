/**
 * Streaming ingest performance baseline.
 *
 * Run with `node scripts/content/perf-stream.mjs`.
 *
 * One assistant message of 10,000 characters is replayed as 1-8 character
 * fragments through `createContentModel().ingest` (`message.delta`). Every call
 * is timed on its own; p50/p95/p99/max are reported and p95 is compared with the
 * 1 ms per-fragment budget.
 *
 * The fragment stream is generated from a fixed LCG seed, so the same input is
 * fed on every run. Arrival is modelled at 200 fragments per second: that only
 * fixes the per-fragment budget (5 ms wall time), it is not slept through,
 * because a sleep would add wall time without changing the parse cost being
 * measured.
 *
 * The message length defaults to 10,000 characters and can be raised without
 * editing the file: `--length 100000` (or `--length=100000`), or the
 * `CONTENT_PERF_LENGTH` environment variable. The command-line value wins.
 *
 * The real TypeScript module is loaded through Vite's SSR loader: Node cannot
 * follow this source tree's `.js` specifiers to `.ts` files, and measuring a
 * re-implementation would measure the copy. No dependency is added.
 *
 * Exit codes: 0 = pass, 1 = over budget, 2 = the script itself could not
 * measure (bad module shape, wrong block text, and so on).
 */

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { fail } from "../lib/gate-cli.mjs";

/** Repository root, so the script works whatever directory it is started from. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Default characters in the replayed assistant message. */
const DEFAULT_MESSAGE_LENGTH = 10_000;
/** Environment variable that overrides the default message length. */
const LENGTH_ENV = "CONTENT_PERF_LENGTH";
/** Smallest fragment, in characters. */
const MIN_CHUNK = 1;
/** Largest fragment, in characters. */
const MAX_CHUNK = 8;
/** Fragments per second the budget is written for. */
const ARRIVAL_PER_SECOND = 200;
/** Fixed seed of the fragment-width generator. */
const SEED = 0x5eed_1234;
/** Untimed passes that warm the JIT up. */
const WARMUP_PASSES = 1;
/** Timed passes, each on a fresh model. */
const MEASURED_PASSES = 3;
/** Per-fragment p95 budget, in milliseconds. */
const P95_BUDGET_MS = 1;

const MESSAGE_ID = "perf-stream-message";
const RUN_ID = "perf-stream-run";
const CONVERSATION_ID = "perf-stream-conversation";
const AGENT_ID = "perf-stream-agent";

/** Sentences joined into the replayed prose; no fences, so one text block. */
const SENTENCES = [
  "The content model folds each fragment into the block it is still writing.",
  "Only the blocks that changed are returned, never the whole message.",
  "A fenced code block is opened by its own line and closed by another.",
  "Tool calls and their results are paired by a stable call identifier.",
  "The parser keeps the source order and copies every value that leaves it.",
  "History pages are parsed whole, while live messages arrive piece by piece.",
];

/**
 * Resolve the message length from the command line, the environment or the
 * default. The command-line value wins over the environment.
 *
 * @param {string[]} argv arguments without the node/script prefix
 * @returns {number} a positive integer character count
 */
function resolveMessageLength(argv) {
  let raw = process.env[LENGTH_ENV];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--length") {
      raw = argv[index + 1];
      if (raw === undefined) {
        throw new Error("--length requires a value");
      }
      index += 1;
      continue;
    }

    if (arg.startsWith("--length=")) {
      raw = arg.slice("--length=".length);
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (raw === undefined) {
    return DEFAULT_MESSAGE_LENGTH;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`message length must be a positive integer, got "${raw}"`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_CHUNK) {
    throw new Error(`message length must be at least ${MIN_CHUNK}, got ${raw}`);
  }
  return value;
}

/** Deterministic 32-bit linear congruential generator. */
function createRandom(seed) {
  let state = seed >>> 0;

  return function next() {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

/**
 * Build the prose once so every pass sees the same characters.
 *
 * @param {number} length characters to build
 * @returns {string} exactly `length` characters
 */
function buildText(length) {
  let text = "";

  for (let index = 0; text.length < length; index += 1) {
    text += `${SENTENCES[index % SENTENCES.length]}\n\n`;
  }

  return text.slice(0, length);
}

/**
 * Split the message into deterministic 1-8 character fragments.
 *
 * @param {string} text the whole message
 * @param {number} length characters to split
 * @returns {string[]} the fragments, in stream order
 */
function buildChunks(text, length) {
  const next = createRandom(SEED);
  const chunks = [];
  let offset = 0;

  while (offset < length) {
    const width = MIN_CHUNK + (next() % (MAX_CHUNK - MIN_CHUNK + 1));
    const end = Math.min(offset + width, length);
    chunks.push(text.slice(offset, end));
    offset = end;
  }

  return chunks;
}

/** One upstream delta change for a fragment. */
function deltaChange(text, index) {
  return {
    kind: "message.delta",
    authorAgentId: AGENT_ID,
    runtimeAgentId: AGENT_ID,
    subagentId: null,
    conversationId: CONVERSATION_ID,
    at: index * (1000 / ARRIVAL_PER_SECOND),
    messageId: MESSAGE_ID,
    runId: RUN_ID,
    runSeq: index,
    text,
    parts: [],
    first: index === 0,
  };
}

/**
 * Replay one whole message through a fresh model.
 *
 * @param {() => object} createContentModel the facade factory
 * @param {string[]} chunks the fragment stream
 * @param {number} messageLength characters in the whole message
 * @returns {{durations: number[], blocks: object[]}} per-fragment times and final blocks
 */
function runPass(createContentModel, chunks, messageLength) {
  const model = createContentModel();
  const durations = [];
  let updates = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const change = deltaChange(chunks[index], index);
    const started = performance.now();
    updates = model.ingest(change);
    durations.push(performance.now() - started);
  }

  const closed = model.ingest({
    kind: "message.complete",
    authorAgentId: AGENT_ID,
    runtimeAgentId: AGENT_ID,
    subagentId: null,
    conversationId: CONVERSATION_ID,
    at: chunks.length * (1000 / ARRIVAL_PER_SECOND),
    messageId: MESSAGE_ID,
    runId: RUN_ID,
    textLength: messageLength,
    incomplete: false,
  });

  const blocks = [];
  for (const update of [...updates, ...closed]) {
    blocks.push(...update.upserts);
  }

  return { durations, blocks };
}

/**
 * Read one percentile with the nearest-rank rule.
 *
 * @param {number[]} sorted ascending samples
 * @param {number} fraction 0..1
 * @returns {number}
 */
function percentile(sorted, fraction) {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)));
  return sorted[rank - 1];
}

/** Format a millisecond value with a stable number of decimals. */
function ms(value) {
  return value.toFixed(4);
}

/** Load the real model module through Vite's SSR loader. */
async function loadCreateContentModel() {
  const vite = await import("vite");
  const server = await vite.createServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });

  try {
    const loaded = await server.ssrLoadModule("/packages/core/src/content/model.ts");
    if (typeof loaded.createContentModel !== "function") {
      throw new Error("the content model module did not export createContentModel");
    }
    return loaded.createContentModel;
  } finally {
    await server.close();
  }
}

try {
  const messageLength = resolveMessageLength(process.argv.slice(2));
  const text = buildText(messageLength);
  const createContentModel = await loadCreateContentModel();
  const chunks = buildChunks(text, messageLength);

  if (chunks.join("") !== text) {
    throw new Error("the deterministic fragment stream does not rebuild the message");
  }

  for (let pass = 0; pass < WARMUP_PASSES; pass += 1) {
    runPass(createContentModel, chunks, messageLength);
  }

  const durations = [];
  let finalBlocks = [];

  for (let pass = 0; pass < MEASURED_PASSES; pass += 1) {
    const result = runPass(createContentModel, chunks, messageLength);
    durations.push(...result.durations);
    finalBlocks = result.blocks;
  }

  // A block set that lost or duplicated text would make the timing meaningless.
  let textLength = 0;
  for (const block of finalBlocks) {
    if (block.type === "text") {
      textLength += block.text.length;
    }
  }
  if (textLength !== messageLength) {
    throw new Error(
      `measured run produced ${textLength} text characters, expected ${messageLength}`,
    );
  }
  if (finalBlocks.length !== 1) {
    throw new Error(`measured run produced ${finalBlocks.length} blocks, expected 1`);
  }

  durations.sort((left, right) => left - right);
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);
  const max = durations[durations.length - 1];
  const pass = p95 <= P95_BUDGET_MS;

  console.log("content streaming ingest");
  console.log(`node        ${process.version} ${process.platform} ${process.arch}`);
  console.log(
    `method      message.delta, ${messageLength} chars, ${MIN_CHUNK}-${MAX_CHUNK} char fragments, ${chunks.length} fragments, seed ${SEED}`,
  );
  console.log(
    `arrival     ${ARRIVAL_PER_SECOND} fragments/s budget (${(1000 / ARRIVAL_PER_SECOND).toFixed(1)} ms/fragment); parse timed, no pacing sleep`,
  );
  console.log(
    `iterations  ${MEASURED_PASSES} measured + ${WARMUP_PASSES} warm-up, ${durations.length} samples`,
  );
  console.log(`blocks      ${finalBlocks.length}`);
  console.log(`p50         ${ms(p50)} ms`);
  console.log(`p95         ${ms(p95)} ms`);
  console.log(`p99         ${ms(p99)} ms`);
  console.log(`max         ${ms(max)} ms`);
  console.log(`threshold   p95 <= ${P95_BUDGET_MS} ms`);
  console.log(pass ? "PASS" : "FAIL");

  console.log(
    `PERF_JSON ${JSON.stringify({
      kind: "content-stream",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      method: "createContentModel.ingest(message.delta)",
      chars: messageLength,
      blocks: finalBlocks.length,
      fragmentMin: MIN_CHUNK,
      fragmentMax: MAX_CHUNK,
      fragments: chunks.length,
      seed: SEED,
      iterations: MEASURED_PASSES,
      samples: durations.length,
      unit: "ms",
      p50: Number(ms(p50)),
      p95: Number(ms(p95)),
      p99: Number(ms(p99)),
      max: Number(ms(max)),
      threshold: P95_BUDGET_MS,
      pass,
    })}`,
  );

  if (!pass) {
    process.exitCode = 1;
  }
} catch (error) {
  fail(error);
}
