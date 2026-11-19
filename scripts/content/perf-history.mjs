/**
 * History page performance baseline.
 *
 * Run with `node scripts/content/perf-history.mjs`.
 *
 * One page of 10,000 `SourceMessage` entries is parsed with `parseHistoryPage`.
 * The page mixes user and assistant prose with a small share of fenced code,
 * tool call/return pairs and task notifications, so the measured work is the
 * real dispatcher rather than a single hot branch. p50/p95/p99/max over the
 * measured runs are reported and the slowest parse is compared with the 500 ms
 * page budget.
 *
 * The page is generated from a fixed LCG seed, so every run parses the same
 * input. The real TypeScript module is loaded through Vite's SSR loader: Node
 * cannot follow this source tree's `.js` specifiers to `.ts` files, and timing a
 * re-implementation would time the copy. No dependency is added.
 *
 * Exit codes: 0 = pass, 1 = over budget, 2 = the script itself could not
 * measure (bad module shape, an empty page, and so on).
 */

import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { fail } from "../lib/gate-cli.mjs";

/** Repository root, so the script works whatever directory it is started from. */
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Messages in the page. */
const MESSAGE_COUNT = 10_000;
/** Fixed seed of the content generator. */
const SEED = 0x00c0_ffee;
/** Untimed parses that warm the JIT up. */
const WARMUP_RUNS = 1;
/** Timed parses; each one parses the whole page once. */
const MEASURED_RUNS = 20;
/** Whole-page budget, in milliseconds. */
const PAGE_BUDGET_MS = 500;

const BASE_AT = Date.UTC(2024, 0, 1);

/** Sentences used to build deterministic prose; no fences inside. */
const SENTENCES = [
  "The history parser walks a finished page and returns blocks in source order.",
  "A tool call keeps the position of the message that first mentioned it.",
  "A result that arrives without its call becomes an orphan block.",
  "User text is cleaned of reminders before it becomes a block.",
  "Assistant prose goes through the same fence scanner as a live message.",
  "A page is parsed once and keeps no state for the next page.",
];

/** Assistant message with a fenced block, so the code path is exercised. */
const FENCED_CONTENT = [
  "Here is the excerpt.",
  "",
  "```ts",
  "export function read(value: string) {",
  "  return value.trim();",
  "}",
  "```",
  "",
  "That is all.",
].join("\n");

/** Deterministic 32-bit linear congruential generator. */
function createRandom(seed) {
  let state = seed >>> 0;

  return function next() {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

/** Deterministic prose of one to three sentences. */
function prose(next) {
  const count = 1 + (next() % 3);
  const parts = [];

  for (let index = 0; index < count; index += 1) {
    parts.push(SENTENCES[next() % SENTENCES.length]);
  }

  return parts.join(" ");
}

/** A user message carrying a task notification. */
function noticeContent(index) {
  return [
    "Working on it.",
    "",
    "<task-notification>",
    `<summary>Task ${index} completed</summary>`,
    "<result>ok</result>",
    "</task-notification>",
  ].join("\n");
}

/** A user message carrying a reminder that must not surface as text. */
function reminderContent(index) {
  return `Before <system-reminder>internal note ${index}</system-reminder> after.`;
}

/**
 * Build the page once.
 *
 * Every 100 messages contains one tool call/return pair, one fenced assistant
 * message, one notification and one reminder. The other entries alternate
 * between plain user and assistant prose.
 *
 * @returns {object[]} source messages, in page order
 */
function buildMessages() {
  const next = createRandom(SEED);
  const messages = [];

  for (let index = 0; index < MESSAGE_COUNT; index += 1) {
    const cycle = index % 100;
    const base = {
      id: `history-${index}`,
      runId: `run-${Math.floor(index / 100)}`,
      at: BASE_AT + index * 1000,
    };

    if (cycle === 0) {
      messages.push({
        ...base,
        messageType: "tool_call_message",
        role: "tool",
        body: {
          tool_call: {
            tool_call_id: `call-${index}`,
            name: "shell",
            arguments: JSON.stringify({ command: `echo ${index}` }),
          },
        },
      });
      continue;
    }

    if (cycle === 1) {
      messages.push({
        ...base,
        messageType: "tool_return_message",
        role: "tool",
        body: {
          tool_call_id: `call-${index - 1}`,
          status: "success",
          tool_return: `line ${index}`,
        },
      });
      continue;
    }

    if (cycle === 10) {
      messages.push({
        ...base,
        messageType: "assistant_message",
        role: "assistant",
        body: { content: FENCED_CONTENT },
      });
      continue;
    }

    if (cycle === 20) {
      messages.push({
        ...base,
        messageType: "user_message",
        role: "user",
        body: { content: noticeContent(index) },
      });
      continue;
    }

    if (cycle === 30) {
      messages.push({
        ...base,
        messageType: "user_message",
        role: "user",
        body: { content: reminderContent(index) },
      });
      continue;
    }

    const assistant = index % 2 === 1;
    messages.push({
      ...base,
      messageType: assistant ? "assistant_message" : "user_message",
      role: assistant ? "assistant" : "user",
      body: { content: prose(next) },
    });
  }

  return messages;
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

/**
 * Check that the page really exercised the branches it claims to.
 *
 * A page that produced no code, notice or tool block would still time, but it
 * would not be the baseline the budget describes.
 *
 * @param {object[]} blocks parsed output
 * @returns {Map<string, number>} block count by type
 */
function inspectBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < MESSAGE_COUNT) {
    const size = Array.isArray(blocks) ? blocks.length : "non-array";
    throw new Error(`the page produced ${size} blocks, expected at least ${MESSAGE_COUNT}`);
  }

  const counts = new Map();
  for (const block of blocks) {
    counts.set(block.type, (counts.get(block.type) ?? 0) + 1);
  }

  for (const type of ["text", "code", "notice", "tool_call"]) {
    if (!(counts.get(type) > 0)) {
      throw new Error(`the page produced no ${type} block`);
    }
  }

  return counts;
}

/** Load the real history module through Vite's SSR loader. */
async function loadParseHistoryPage() {
  const vite = await import("vite");
  const server = await vite.createServer({
    root: ROOT,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "silent",
  });

  try {
    const loaded = await server.ssrLoadModule("/packages/core/src/content/history.ts");
    if (typeof loaded.parseHistoryPage !== "function") {
      throw new Error("the history module did not export parseHistoryPage");
    }
    return loaded.parseHistoryPage;
  } finally {
    await server.close();
  }
}

try {
  const parseHistoryPage = await loadParseHistoryPage();
  const messages = buildMessages();

  if (messages.length !== MESSAGE_COUNT) {
    throw new Error(`generated ${messages.length} messages, expected ${MESSAGE_COUNT}`);
  }

  let expectedBlocks = 0;
  for (let run = 0; run < WARMUP_RUNS; run += 1) {
    const blocks = parseHistoryPage(messages);
    expectedBlocks = blocks.length;
    inspectBlocks(blocks);
  }

  const durations = [];
  for (let run = 0; run < MEASURED_RUNS; run += 1) {
    const started = performance.now();
    const blocks = parseHistoryPage(messages);
    durations.push(performance.now() - started);

    if (blocks.length !== expectedBlocks) {
      throw new Error(
        `parse returned ${blocks.length} blocks, the warm-up returned ${expectedBlocks}`,
      );
    }
  }

  durations.sort((left, right) => left - right);
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);
  const max = durations[durations.length - 1];
  const pass = max <= PAGE_BUDGET_MS;

  console.log("content history page");
  console.log(`node        ${process.version} ${process.platform} ${process.arch}`);
  console.log(
    `method      parseHistoryPage, ${MESSAGE_COUNT} SourceMessages (user/assistant + fences/tools/notices), 1 page, seed ${SEED}`,
  );
  console.log(
    `iterations  ${MEASURED_RUNS} measured + ${WARMUP_RUNS} warm-up, ${durations.length} samples, ${expectedBlocks} blocks/page`,
  );
  console.log(`p50         ${ms(p50)} ms`);
  console.log(`p95         ${ms(p95)} ms`);
  console.log(`p99         ${ms(p99)} ms`);
  console.log(`max         ${ms(max)} ms`);
  console.log(`threshold   max <= ${PAGE_BUDGET_MS} ms`);
  console.log(pass ? "PASS" : "FAIL");

  console.log(
    `PERF_JSON ${JSON.stringify({
      kind: "content-history",
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      method: "parseHistoryPage",
      messages: MESSAGE_COUNT,
      blocks: expectedBlocks,
      seed: SEED,
      iterations: MEASURED_RUNS,
      samples: durations.length,
      unit: "ms",
      p50: Number(ms(p50)),
      p95: Number(ms(p95)),
      p99: Number(ms(p99)),
      max: Number(ms(max)),
      threshold: PAGE_BUDGET_MS,
      pass,
    })}`,
  );

  if (!pass) {
    process.exitCode = 1;
  }
} catch (error) {
  fail(error);
}
