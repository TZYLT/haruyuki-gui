/**
 * Shared plumbing for the merge benchmarks: recordings in, engine frames out,
 * and one loader for the TypeScript merge loop.
 *
 * Two jobs, and both exist so the two scripts next to this file measure the real
 * thing rather than a copy of it.
 *
 * 1. **Frames from recordings.** Each recording stores the message exactly as it
 *    crossed the wire, with the four metadata fields (`runtime`, `event_seq`,
 *    `emitted_at`, `idempotency_key`) inside it. The channel hands the merger
 *    `raw` = the parsed message and `envelope` = those four fields, so that is
 *    what this module builds. The payload is the same object the channel would
 *    have passed on; nothing here interprets it.
 * 2. **Loading the merge loop.** The product code is TypeScript with `.js`
 *    specifiers on its internal imports, which is correct for the bundler and
 *    for `tsc`, but plain Node resolves `.js` literally and finds nothing. A
 *    resolve hook maps a relative `x.js` to `x.ts` when such a file exists, so
 *    `node scripts/merge/merge-cost.mjs` runs against the real modules with no
 *    build step and no new dependency. The hook is installed when this module is
 *    evaluated, which is why the merge loop is loaded with a dynamic `import()`
 *    from {@link loadMergeModule}: a static import of a `.ts` file would be
 *    linked before this module's body ran, and the hook would arrive too late.
 *
 * Only reads: no benchmark writes a file.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Directory the recorded sessions live in. */
export const RECORDINGS_DIR = path.join(REPO_ROOT, "fixtures", "engine", "recordings");

/** The merge loop's public entry point, as TypeScript source. */
const MERGE_ENTRY = path.join(REPO_ROOT, "packages", "core", "src", "merge", "index.ts");

/** The metadata fields the channel reads off a frame, in the channel's order. */
const ENVELOPE_KEYS = ["runtime", "event_seq", "emitted_at", "idempotency_key"];

/**
 * One engine event frame, shaped like the channel's frame.
 *
 * @typedef {object} EngineFrame
 * @property {string} type the engine's event type
 * @property {unknown} raw the parsed message, untouched
 * @property {number} at arrival time in milliseconds
 * @property {Record<string, unknown>} [envelope] the metadata fields that were present
 */

/**
 * Resolve a relative `.js` specifier to the `.ts` file next to it.
 *
 * Only relative specifiers are considered: a bare name is a package (or a
 * builtin), and rewriting those would break the very first import. A `.ts`
 * next to the specifier wins even when a built `.js` also exists, because the
 * benchmark always runs from source and this tree carries no build output.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL !== undefined) {
      const candidate = new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL);

      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }

    return nextResolve(specifier, context);
  },
});

/**
 * Import the merge loop.
 *
 * Called once per process; the module system caches it, and a second call would
 * return the same namespace anyway.
 *
 * @returns {Promise<object>} the merge module's exports
 */
export async function loadMergeModule() {
  return import(pathToFileURL(MERGE_ENTRY).href);
}

/**
 * Read the metadata fields one message carries.
 *
 * Mirrors the channel's passthrough: a field the message does not carry is
 * absent from the result, and a message carrying none of the four yields
 * `undefined` so the frame has no `envelope` key at all. The difference between
 * "no envelope" and "an empty envelope" is preserved because the merge loop
 * treats them differently.
 *
 * @param {Record<string, unknown>} msg the parsed message
 * @returns {Record<string, unknown> | undefined} the present fields
 */
function envelopeOf(msg) {
  /** @type {Record<string, unknown> | undefined} */
  let envelope;

  for (const key of ENVELOPE_KEYS) {
    const value = msg[key];

    if (value === undefined) {
      continue;
    }

    envelope ??= {};
    envelope[key] = value;
  }

  return envelope;
}

/**
 * Read one recording into frames.
 *
 * Boundary lines are skipped and the header is not a message, so the result is
 * exactly the messages the engine sent; the recorded direction that the client
 * sent is left out, because the merge loop only ever sees the engine's side.
 *
 * @param {string} name file name, with or without the `.jsonl` suffix
 * @returns {EngineFrame[]} the frames, in recorded order
 */
export function readRecording(name) {
  const file = path.join(RECORDINGS_DIR, name.endsWith(".jsonl") ? name : `${name}.jsonl`);
  const text = readFileSync(file, "utf8");
  /** @type {EngineFrame[]} */
  const frames = [];

  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();

    if (trimmed === "") {
      return;
    }

    let record;

    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`${file}:${index + 1} is not valid JSON: ${String(error)}`);
    }

    if (record === null || typeof record !== "object") {
      throw new Error(`${file}:${index + 1} is not a JSON object`);
    }

    // The first line describes the recording; it is not a message.
    if (record.kind === "wire") {
      return;
    }

    if (record.dir !== "s2c") {
      return;
    }

    const msg = record.msg;

    if (msg === null || typeof msg !== "object") {
      throw new Error(`${file}:${index + 1} has no message object`);
    }

    const envelope = envelopeOf(msg);

    frames.push({
      type: typeof msg.type === "string" ? msg.type : "",
      raw: msg,
      at: typeof record.at === "number" ? record.at : 0,
      ...(envelope === undefined ? {} : { envelope }),
    });
  });

  return frames;
}

/**
 * Read every recording.
 *
 * @returns {Map<string, EngineFrame[]>} file name to frames, in sorted file order
 */
export function readAllRecordings() {
  const names = readdirSync(RECORDINGS_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();

  return new Map(names.map((name) => [name, readRecording(name)]));
}
