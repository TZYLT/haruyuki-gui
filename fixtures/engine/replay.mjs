/**
 * replay.mjs - deterministic s2c replay engine for the fake engine server.
 *
 * The replay plan and handle shapes and the `wire` fixture line format are
 * `wire` fixture line format. This module parses the fixture, turns fixture plus
 * plan into an ordered step list, and drives it against a clock and two socket
 * callbacks; `fake-server.mjs` is the socket side ("replay" mode).
 *
 * Determinism: the step list is a pure function of fixture and
 * plan, no wall clock is read and no timestamp is added, so two runs emit
 * byte-identical arrays. An emission is `JSON.stringify(line.msg)` computed
 * once: the frozen `WireFixture` carries the parsed message only, and compact
 * JSON round-trips byte-for-byte. Injection line
 * numbers are 1-based indexes into `fixture.lines` (the header is not one).
 */

/** `kind` value the wire fixture header must carry. */
export const WIRE_KIND = "wire";

/** The only fixture format version this module accepts (frozen). */
export const WIRE_SCHEMA_VERSION = 1;

const DIRECTIONS = Object.freeze(["c2s", "s2c"]);
const INSTANT = "instant";

/**
 * @typedef {object} WireFixture
 * @property {object} header Validated first JSONL line (kind "wire", schemaVersion 1).
 * @property {Array<{ dir: "c2s" | "s2c", at: number, msg: object }>} lines Message lines.
 */

/**
 * @typedef {object} ReplayStep
 * @property {"frame" | "disconnect"} kind What the driver does when it gets here.
 * @property {number} delayMs Wait before the step, from `at` deltas and speed.
 * @property {number} line 1-based fixture line the step belongs to.
 * @property {string} [text] Frame text, present when `kind` is "frame".
 * @property {boolean} [resume] Present when `kind` is "disconnect".
 */

/**
 * @typedef {object} Clock
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 */

/** The default clock: replay never really waits. */
export function createInstantClock() {
  return { now: () => 0, sleep: () => Promise.resolve() };
}

function lineError(lineNumber, message) {
  return new Error(`replay: fixture line ${lineNumber}: ${message}`);
}

function planError(message) {
  return new Error(`replay: ${message}`);
}

function detailOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMessage(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse and validate the JSONL text of a `wire` fixture.
 *
 * The header must be the first non-blank line and carry `kind: "wire"` and
 * `schemaVersion: 1`; every following non-blank line must be a message line
 * (`dir`, `at`, `msg`). Blank lines are skipped so a trailing newline is fine,
 * but they still count for line numbers. Every failure names the 1-based line.
 *
 * @param {string} text Raw JSONL contents.
 * @returns {WireFixture} Parsed fixture.
 */
export function parseWireFixture(text) {
  if (typeof text !== "string") {
    throw new TypeError("replay: parseWireFixture expects the JSONL text as a string");
  }

  const entries = text
    .split(/\r?\n/)
    .map((physical, index) => ({ lineNumber: index + 1, raw: physical.trim() }))
    .filter((entry) => entry.raw.length > 0);

  const headerEntry = entries[0];

  if (headerEntry === undefined) {
    throw lineError(1, `expected a ${WIRE_KIND} JSON header, found an empty fixture`);
  }

  let header;

  try {
    header = JSON.parse(headerEntry.raw);
  } catch (error) {
    throw lineError(headerEntry.lineNumber, `header is not valid JSON (${detailOf(error)})`);
  }

  if (!isMessage(header)) {
    throw lineError(headerEntry.lineNumber, `header must be a JSON object, found ${typeof header}`);
  }

  if (header.kind !== WIRE_KIND) {
    throw lineError(
      headerEntry.lineNumber,
      `header "kind" must be "${WIRE_KIND}", found ${JSON.stringify(header.kind)}`,
    );
  }

  if (header.schemaVersion !== WIRE_SCHEMA_VERSION) {
    const found = JSON.stringify(header.schemaVersion);

    throw lineError(headerEntry.lineNumber, `header "schemaVersion" must be ${WIRE_SCHEMA_VERSION}, found ${found}`);
  }

  const lines = [];

  for (const entry of entries.slice(1)) {
    let value;

    try {
      value = JSON.parse(entry.raw);
    } catch (error) {
      throw lineError(entry.lineNumber, `message line is not valid JSON (${detailOf(error)})`);
    }

    if (!isMessage(value)) throw lineError(entry.lineNumber, "message line must be a JSON object");

    if (!DIRECTIONS.includes(value.dir)) {
      throw lineError(entry.lineNumber, `"dir" must be "s2c" or "c2s", found ${JSON.stringify(value.dir)}`);
    }

    if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0) {
      throw lineError(
        entry.lineNumber,
        `"at" must be a non-negative finite number, found ${JSON.stringify(value.at)}`,
      );
    }

    if (!isMessage(value.msg)) {
      throw lineError(entry.lineNumber, `"msg" must be a JSON object, found ${JSON.stringify(value.msg)}`);
    }

    lines.push({ dir: value.dir, at: value.at, msg: value.msg });
  }

  return { header, lines };
}

function requireLineNumber(value, label, lineCount) {
  if (!Number.isInteger(value) || value < 1 || value > lineCount) {
    throw planError(`${label} must be a 1-based line in 1..${lineCount}, found ${JSON.stringify(value)}`);
  }

  return value;
}

function requireSpeed(value) {
  if (value === undefined || value === INSTANT) return INSTANT;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;

  throw planError(`plan.speed must be "instant" or a non-negative number, found ${JSON.stringify(value)}`);
}

/**
 * Turn a fixture plus a plan into the ordered list of replay steps.
 *
 * Rules (frozen):
 * - only `s2c` lines are emitted, in line order after injections; a `c2s` line
 *   never produces a step;
 * - `reorder` swaps the two listed lines, `duplicate` repeats a line `times`
 *   more times right after it, `coalesce` removes the wait before the listed
 *   lines (emission order is never changed by coalesce) and `disconnect` closes
 *   the socket after the listed line: it resumes at the next line when `resume`
 *   is true, and ends the plan there when false;
 * - `speed: "instant"` waits for nothing; a number waits
 *   `(at[i] - at[i - 1]) * speed` milliseconds between two emissions.
 *
 * @param {WireFixture} fixture Parsed wire fixture.
 * @param {{ speed?: "instant" | number, inject?: unknown[] }} [plan] Replay plan.
 * @returns {ReplayStep[]} Ordered steps.
 */
export function buildReplaySteps(fixture, plan = {}) {
  const lines = fixture === null || typeof fixture !== "object" ? null : fixture.lines;

  if (!Array.isArray(lines)) {
    throw new TypeError("replay: buildReplaySteps expects a WireFixture ({ header, lines })");
  }

  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
    throw new TypeError("replay: buildReplaySteps expects the plan to be an object");
  }

  for (const [index, line] of lines.entries()) {
    if (line === null || typeof line !== "object" || !isMessage(line.msg)) {
      throw new Error(`replay: fixture line ${index + 1}: expected a message line`);
    }
  }

  const lineCount = lines.length;
  const speed = requireSpeed(plan.speed);
  const inject = plan.inject === undefined ? [] : plan.inject;

  if (!Array.isArray(inject)) throw planError("plan.inject must be an array of injections");

  // 1-based fixture line numbers, in emission order (duplicates allowed).
  const order = lines.map((_line, index) => index + 1);
  const coalesced = new Set();
  const disconnects = [];

  for (const [injectIndex, injection] of inject.entries()) {
    const label = `plan.inject[${injectIndex}]`;

    if (!isMessage(injection)) throw planError(`${label} must be an object with a "kind"`);

    switch (injection.kind) {
      case "reorder": {
        const pair = injection.lines;

        if (!Array.isArray(pair) || pair.length !== 2) {
          throw planError(`${label}.lines must be a pair of 1-based line numbers`);
        }

        const first = requireLineNumber(pair[0], `${label}.lines[0]`, lineCount);
        const second = requireLineNumber(pair[1], `${label}.lines[1]`, lineCount);
        const firstIndex = order.indexOf(first);
        const secondIndex = order.indexOf(second);

        order[firstIndex] = second;
        order[secondIndex] = first;
        break;
      }

      case "duplicate": {
        const line = requireLineNumber(injection.line, `${label}.line`, lineCount);
        const times = injection.times;

        if (!Number.isInteger(times) || times < 0) {
          throw planError(`${label}.times must be a non-negative integer, found ${JSON.stringify(times)}`);
        }

        order.splice(order.indexOf(line) + 1, 0, ...new Array(times).fill(line));
        break;
      }

      case "coalesce": {
        const listed = injection.lines;

        if (!Array.isArray(listed) || listed.length === 0) {
          throw planError(`${label}.lines must be a non-empty array of 1-based line numbers`);
        }

        // The first listed line keeps its own wait; the rest emit back to back.
        for (const [position, value] of listed.entries()) {
          const line = requireLineNumber(value, `${label}.lines[${position}]`, lineCount);

          if (position > 0) coalesced.add(line);
        }

        break;
      }

      case "disconnect": {
        const atLine = requireLineNumber(injection.atLine, `${label}.atLine`, lineCount);

        if (typeof injection.resume !== "boolean") {
          throw planError(`${label}.resume must be a boolean, found ${JSON.stringify(injection.resume)}`);
        }

        disconnects.push({ atLine, resume: injection.resume, injectIndex });
        break;
      }

      default:
        throw planError(`${label}.kind is unknown: ${JSON.stringify(injection.kind)}`);
    }
  }

  // Emit only s2c lines, one step per emission, with the wait before each one.
  const emissions = [];
  let previousAt = null;

  for (const source of order) {
    const line = lines[source - 1];

    if (line === undefined || line.dir !== "s2c") continue;

    let delayMs = 0;

    if (speed !== INSTANT && previousAt !== null && !coalesced.has(source)) {
      delayMs = Math.max(0, Math.round((line.at - previousAt) * speed));
    }

    emissions.push({ source, text: JSON.stringify(line.msg), delayMs });
    previousAt = line.at;
  }

  // A disconnect sits right after the emission of `atLine`, or right after the
  // last emission that precedes it in the fixture when `atLine` is a c2s line.
  const afterEmission = new Map();

  for (const disconnect of disconnects) {
    let after = 0;

    for (const [index, emission] of emissions.entries()) {
      if (emission.source === disconnect.atLine) {
        after = index + 1;
        break;
      }

      if (emission.source < disconnect.atLine) after = index + 1;
    }

    afterEmission.set(after, [...(afterEmission.get(after) ?? []), disconnect]);
  }

  const disconnectStep = (d) => ({
    kind: "disconnect",
    delayMs: 0,
    line: d.atLine,
    resume: d.resume,
  });
  const steps = [...(afterEmission.get(0) ?? [])].map(disconnectStep);

  for (const [index, emission] of emissions.entries()) {
    steps.push({
      kind: "frame",
      delayMs: emission.delayMs,
      line: emission.source,
      text: emission.text,
    });

    for (const disconnect of afterEmission.get(index + 1) ?? []) steps.push(disconnectStep(disconnect));
  }

  // `resume: false` stops the replay, so nothing after that disconnect is planned.
  const stopAt = steps.findIndex((step) => step.kind === "disconnect" && step.resume !== true);

  return stopAt === -1 ? steps : steps.slice(0, stopAt + 1);
}

/**
 * Drive a step list against a clock and the socket callbacks.
 *
 * `send` is awaited before the next step, so a caller can make it wait for a new
 * connection after a disconnect; `disconnect` is awaited and must close the live
 * socket. `shouldStop` is polled before every wait and every step, so a server
 * shutdown ends the loop instead of leaving it pending.
 *
 * @param {ReplayStep[]} steps Steps from `buildReplaySteps`.
 * @param {{
 *   send: (text: string) => Promise<void> | void,
 *   disconnect: (resume: boolean) => Promise<void> | void,
 *   clock?: Clock,
 *   shouldStop?: () => boolean,
 * }} options Callbacks plus the optional clock.
 * @returns {Promise<void>} Resolves when the sequence ends.
 */
export async function runReplay(steps, options = {}) {
  if (!Array.isArray(steps)) {
    throw new TypeError("replay: runReplay expects the step list from buildReplaySteps");
  }

  if (typeof options.send !== "function") {
    throw new TypeError("replay: runReplay expects a send(text) callback");
  }

  if (typeof options.disconnect !== "function") {
    throw new TypeError("replay: runReplay expects a disconnect(resume) callback");
  }

  const clock = options.clock ?? createInstantClock();
  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : () => false;

  if (typeof clock.sleep !== "function") throw new TypeError("replay: clock.sleep must be a function");

  for (const step of steps) {
    if (shouldStop()) return;

    if (step.delayMs > 0) {
      await clock.sleep(step.delayMs);

      if (shouldStop()) return;
    }

    if (step.kind === "disconnect") {
      await options.disconnect(step.resume === true);

      if (step.resume !== true) return;

      continue;
    }

    await options.send(step.text);
  }
}
