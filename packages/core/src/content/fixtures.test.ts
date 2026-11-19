/**
 * Fixture corpus and per-block snapshots for the content model's two paths.
 *
 * Every fixture under `fixtures/content/` is hand-written, synthetic and small:
 * one JSON file per message or behavior class, and each case names the path that must
 * consume it plus the exact output expected from it:
 *
 *   history    `parseHistoryPage`, the stateless one-page path
 *   live-text  adapter + fence + block assembly, fed one delta frame at a time
 *   tools      the tool table's incremental updates, folded to final blocks
 *   reasoning  the reasoning aggregator's incremental updates
 *   notice     `parseUserContent`, the span-level cleaning of user content
 *
 * The snapshots are the point: they are what makes a change in block shape,
 * id, order or status fail loudly instead of drifting. On top of them sit the
 * cross-corpus invariants a snapshot alone cannot state: no prose carries the
 * agent-only XML, an unknown message type always surfaces as an `unknown` block,
 * a call with no final return never claims success, ids stay unique, every
 * output survives a JSON round trip, and a malformed fixture degrades instead of
 * throwing.
 *
 * Loading is synchronous so the collected test names are the fixture case
 * names; nothing here touches the network, a clock or a recording.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Block, TextBlock, ToolCallBlock, UnknownBlock } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { AssistantPart } from "../merge/types.js";
import { createDeltaState, createMessageStateFor, ingestDelta } from "./adapter.js";
import { appendText, completeMessage } from "./blocks.js";
import { parseHistoryPage } from "./history.js";
import { parseUserContent } from "./notice.js";
import { appendParts, createPartsCursor } from "./parts.js";
import { createReasoningAggregator, ingestReasoning } from "./reasoning.js";
import { createToolTable, incompleteForRun, ingestToolMessage } from "./tools.js";
import type { SourceMessage } from "./types.js";

/** `packages/core/src/content` -> repository root -> the content corpus. */
const CORPUS_DIR = fileURLToPath(new URL("../../../../fixtures/content/", import.meta.url));

/** How one case is consumed. */
type CasePath = "history" | "live-text" | "tools" | "reasoning" | "notice";

/** The closed set of paths a fixture case may name. */
const CASE_PATHS: ReadonlySet<string> = new Set<CasePath>([
  "history",
  "live-text",
  "tools",
  "reasoning",
  "notice",
]);

/**
 * The required message classes, each named by the fixture file that must prove it.
 *
 * The file is the unit: deleting the fixture for a class removes it from
 * `FIXTURES`, so the coverage assertion goes red instead of the corpus quietly
 * shrinking while a `length >= 10` check still passes for the wrong reasons.
 */
const REQUIRED_CLASS_FIXTURES: Readonly<Record<string, string>> = {
  "assistant text": "plain-text",
  "assistant fenced code": "fenced-code",
  "user text": "plain-text",
  "user image": "images",
  "tool success": "tool-calls",
  "tool error": "tool-calls",
  "tool progress snapshot": "tool-calls",
  reasoning: "reasoning",
  "task notification": "notices",
  error: "errors",
  "unknown message": "unknown-messages",
  "unknown part": "unknown-messages",
};

type FixtureCase = {
  readonly name: string;
  readonly path: CasePath;
  readonly input: unknown;
  readonly expect: unknown;
  /** Final text of every reasoning update, in emission order. */
  readonly emitted?: readonly string[];
};

type FixtureFile = {
  readonly note: string;
  readonly cases: readonly FixtureCase[];
};

type LoadedFixture = FixtureFile & { readonly file: string };

/** One live delta frame; `parts` is the message's cumulative part list. */
type LiveFrame = {
  readonly text?: string;
  readonly parts?: readonly AssistantPart[];
};

type LiveSpec = {
  readonly messageId: string;
  readonly runId: string | null;
  readonly frames: readonly LiveFrame[];
};

type MessageSpec = {
  readonly messages: readonly SourceMessage[];
  readonly turnFinished?: string | null;
};

type RunResult = {
  readonly output: unknown;
  readonly emitted: readonly string[] | null;
};

function loadCorpus(): readonly LoadedFixture[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const text = readFileSync(`${CORPUS_DIR}/${name}`, "utf8");
      const fixture = JSON.parse(text) as FixtureFile;

      // A typo in `path` must not silently fall through to the notice branch.
      for (const testCase of fixture.cases) {
        if (!CASE_PATHS.has(testCase.path)) {
          throw new Error(
            `fixture ${name}/${testCase.name} names unknown path ${JSON.stringify(testCase.path)}`,
          );
        }
      }

      return { ...fixture, file: name.replace(/\.json$/, "") };
    });
}

const FIXTURES = loadCorpus();

/** Drive the live text path with one state, one frame at a time. */
function runLiveText(spec: LiveSpec): readonly Block[] {
  const state = createDeltaState({
    messageId: spec.messageId,
    runId: spec.runId,
    text: "",
    parts: [],
    first: true,
  });

  for (const frame of spec.frames) {
    ingestDelta(state, {
      messageId: spec.messageId,
      runId: spec.runId,
      text: frame.text ?? "",
      parts: frame.parts ?? [],
      first: false,
    });
  }

  completeMessage(state);
  return [...state.blocks];
}

/** Fold incremental tool updates down to each block's final shape, in id order. */
function runTools(spec: MessageSpec): readonly Block[] {
  const table = createToolTable();
  const updates: { readonly block: Block }[] = [];

  for (const message of spec.messages) {
    updates.push(...ingestToolMessage(table, message));
  }
  if (spec.turnFinished !== undefined) {
    updates.push(...incompleteForRun(table, spec.turnFinished));
  }

  return foldBlocks(updates);
}

/** Fold incremental reasoning updates the same way, keeping the emitted texts. */
function runReasoning(spec: MessageSpec): {
  readonly blocks: readonly Block[];
  readonly emitted: readonly string[];
} {
  const aggregator = createReasoningAggregator();
  const updates: { readonly block: Block }[] = [];
  const emitted: string[] = [];

  for (const message of spec.messages) {
    const update = ingestReasoning(aggregator, message);
    if (update === null) {
      continue;
    }
    updates.push(update);
    emitted.push(update.block.text);
  }

  return { blocks: foldBlocks(updates), emitted };
}

/** Keep the latest shape per id while preserving the order ids first appeared in. */
function foldBlocks(updates: readonly { readonly block: Block }[]): readonly Block[] {
  const order: string[] = [];
  const latest = new Map<string, Block>();

  for (const update of updates) {
    if (!latest.has(update.block.id)) {
      order.push(update.block.id);
    }
    latest.set(update.block.id, update.block);
  }

  return order.flatMap((id) => {
    const block = latest.get(id);
    return block === undefined ? [] : [block];
  });
}

function runCase(testCase: FixtureCase): RunResult {
  if (testCase.path === "history") {
    return { output: parseHistoryPage(testCase.input as readonly SourceMessage[]), emitted: null };
  }
  if (testCase.path === "live-text") {
    return { output: runLiveText(testCase.input as LiveSpec), emitted: null };
  }
  if (testCase.path === "tools") {
    return { output: runTools(testCase.input as MessageSpec), emitted: null };
  }
  if (testCase.path === "reasoning") {
    const result = runReasoning(testCase.input as MessageSpec);
    return { output: result.blocks, emitted: result.emitted };
  }
  return { output: parseUserContent(testCase.input), emitted: null };
}

/** Every case with its output, computed once so the invariants share it. */
const RUNS = FIXTURES.flatMap((entry) =>
  entry.cases.map((testCase) => ({ file: entry.file, case: testCase, result: runCase(testCase) })),
);

function fixtureFile(name: string): LoadedFixture {
  const found = FIXTURES.find((entry) => entry.file === name);
  if (found === undefined) {
    throw new Error(`missing fixture file ${name}`);
  }
  return found;
}

function caseOf(file: string, name: string): FixtureCase {
  const found = fixtureFile(file).cases.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`missing fixture case ${file}/${name}`);
  }
  return found;
}

function blocksOf(result: RunResult): readonly Block[] {
  return Array.isArray(result.output) ? (result.output as readonly Block[]) : [];
}

function textBlocksOf(blocks: readonly Block[]): readonly TextBlock[] {
  return blocks.filter((block): block is TextBlock => block.type === "text");
}

function toolStatuses(blocks: readonly Block[]): readonly string[] {
  return blocks
    .filter((block): block is ToolCallBlock => block.type === "tool_call")
    .map((block) => block.status);
}

/** The `text` of every notice span, whatever its kind. */
function spanTextsOf(output: unknown): readonly string[] {
  if (!Array.isArray(output)) {
    return [];
  }

  const texts: string[] = [];
  for (const span of output) {
    if (typeof span === "object" && span !== null) {
      const text = (span as { readonly text?: unknown }).text;
      if (typeof text === "string") {
        texts.push(text);
      }
    }
  }

  return texts;
}

/**
 * Every value a block carries that JSON cannot hold unchanged (§6.11).
 *
 * `toStrictEqual` on a round trip catches an `undefined` key only when both the
 * original and the copy are compared; this walk states the rule directly:
 * strings, booleans, finite numbers, `null`, arrays and plain objects, nothing
 * else, at any depth.
 */
function jsonViolations(
  value: unknown,
  path: string = "$",
  ancestors: ReadonlySet<object> = new Set<object>(),
): readonly string[] {
  if (value === undefined) {
    return [`${path} is undefined`];
  }
  if (value === null) {
    return [];
  }

  const kind = typeof value;
  if (kind === "string" || kind === "boolean") {
    return [];
  }
  if (kind === "number") {
    return Number.isFinite(value as number) ? [] : [`${path} is a non-finite number`];
  }
  if (kind !== "object") {
    return [`${path} is a ${kind}`];
  }

  const object = value as object;
  if (ancestors.has(object)) {
    return [`${path} is a cycle`];
  }

  const seen = new Set(ancestors);
  seen.add(object);

  if (Array.isArray(object)) {
    return object.flatMap((item, index) => jsonViolations(item, `${path}[${index}]`, seen));
  }

  const prototype = Object.getPrototypeOf(object) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    return [`${path} is not a plain object`];
  }

  return Object.entries(object).flatMap(([key, child]) =>
    jsonViolations(child, `${path}.${key}`, seen),
  );
}

for (const entry of FIXTURES) {
  describe(entry.file, () => {
    it("declares a note and at least one case", () => {
      expect(entry.note.length).toBeGreaterThan(0);
      expect(entry.cases.length).toBeGreaterThan(0);
    });

    for (const testCase of entry.cases) {
      it(testCase.name, () => {
        const result = runCase(testCase);
        expect(result.output).toEqual(testCase.expect);
        if (testCase.emitted !== undefined) {
          expect(result.emitted).toEqual(testCase.emitted);
        }
      });
    }
  });
}

describe("content corpus invariants", () => {
  it("covers the message classes with their required fixture files", () => {
    const files = new Set(FIXTURES.map((entry) => entry.file));
    const missing = [
      ...new Set(
        Object.entries(REQUIRED_CLASS_FIXTURES)
          .filter(([, file]) => !files.has(file))
          .map(([messageClass, file]) => `${messageClass} -> ${file}`),
      ),
    ];

    expect(missing).toEqual([]);
    // The corpus may grow, but never shrink below the ten classes plus the two
    // unknown-degradation groups (unknown message and unknown part).
    expect(FIXTURES.length).toBeGreaterThanOrEqual(10);
  });

  it("exercises eight block types", () => {
    const seen = new Set<string>();
    for (const run of RUNS) {
      if (run.case.path === "notice") {
        continue;
      }
      for (const block of blocksOf(run.result)) {
        seen.add(block.type);
      }
    }
    for (const type of [
      "text",
      "code",
      "image",
      "tool_call",
      "reasoning",
      "notice",
      "error",
      "unknown",
    ]) {
      expect(seen.has(type), type).toBe(true);
    }
  });

  it("keeps agent-only XML out of every prose block and notice span", () => {
    // Non-vacuity: the input really carries the marker a stripping regression
    // would leave in the output.
    const reminderInput = caseOf("reminders", "prose around a reminder stays one span").input;
    expect(JSON.stringify(reminderInput)).toContain("<system-reminder");

    const prose: string[] = [];
    for (const run of RUNS) {
      if (run.case.path === "notice") {
        // The notice path never builds blocks; its displayable spans are the
        // equivalent surface, so a reminder leaking into one must fail here.
        prose.push(...spanTextsOf(run.result.output));
      } else {
        prose.push(...textBlocksOf(blocksOf(run.result)).map((block) => block.text));
      }
    }

    // Non-vacuity: the reminder fixture itself contributes prose on both paths,
    // including a history user turn whose reminder is stripped.
    const reminderRuns = RUNS.filter((run) => run.file === "reminders");
    const reminderProse = reminderRuns.flatMap((run) =>
      run.case.path === "notice"
        ? spanTextsOf(run.result.output)
        : textBlocksOf(blocksOf(run.result)).map((block) => block.text),
    );
    expect(reminderProse).toContain("Visible question.\n");

    expect(prose.length).toBeGreaterThan(0);
    for (const text of prose) {
      expect(text).not.toContain("<system-reminder");
      expect(text).not.toContain("<task-notification");
    }
  });

  it("surfaces an unknown message type as a block and keeps the page going", () => {
    const result = runCase(
      caseOf("unknown-messages", "an unknown message type keeps the rest of the page"),
    );
    const blocks = blocksOf(result);
    const unknown = blocks.find((block): block is UnknownBlock => block.type === "unknown");

    expect(unknown?.rawType).toBe("new_message_type");
    expect(unknown?.raw).toEqual({
      id: "unknown-1",
      message_type: "new_message_type",
      content: { value: 1 },
    });
    // The page after the unmapped message still parses: swallowing it would
    // leave only the first block.
    expect(blocks.map((block) => block.type)).toEqual(["unknown", "text"]);
  });

  it("never reports a call as success without a final return", () => {
    // Non-vacuity: the end marker itself reported success, so a state machine
    // that closed on it would emit "success" here.
    const endCase = caseOf("tool-calls", "the client end marker does not close the call");
    expect(JSON.stringify(endCase.input)).toContain('"status":"success"');

    const endOnly = blocksOf(runCase(endCase));
    expect(toolStatuses(endOnly)).toEqual(["running"]);

    const unfinished = blocksOf(
      runCase(caseOf("tool-calls", "an unfinished call is incomplete when its turn finishes")),
    );
    expect(toolStatuses(unfinished)).toEqual(["incomplete"]);

    const otherRun = blocksOf(
      runCase(caseOf("tool-calls", "a turn from another run does not close the call")),
    );
    expect(toolStatuses(otherRun)).toEqual(["running"]);
  });

  it("lets a second return for one call overwrite the first", () => {
    const testCase = caseOf("tool-calls", "a second return overwrites the first");
    // Non-vacuity: the input really carries two returns with different payloads
    // and statuses, so a state machine that keeps the first one is caught.
    expect(JSON.stringify(testCase.input)).toContain('"tool_return":"interim failure"');
    expect(JSON.stringify(testCase.input)).toContain('"tool_return":"final output"');

    const blocks = blocksOf(runCase(testCase));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      id: "tool:call-2",
      result: "final output",
      status: "success",
    });
  });

  it("never emits the same block id twice within one output", () => {
    for (const run of RUNS) {
      if (run.case.path === "notice") {
        continue;
      }
      const ids = blocksOf(run.result).map((block) => block.id);
      expect(new Set(ids).size, `${run.file}/${run.case.name}`).toBe(ids.length);
    }
  });

  it("produces the same output when a case is consumed twice", () => {
    for (const run of RUNS) {
      expect(runCase(run.case).output, `${run.file}/${run.case.name}`).toEqual(run.result.output);
    }
  });

  it("round-trips every output through JSON unchanged", () => {
    for (const run of RUNS) {
      const label = `${run.file}/${run.case.name}`;
      // `toStrictEqual`, not `toEqual`: an `undefined` key is dropped by
      // `JSON.stringify` and must fail here, not slip through as equal.
      expect(JSON.parse(JSON.stringify(run.result.output)), label).toStrictEqual(run.result.output);
      if (run.result.emitted !== null) {
        expect(JSON.parse(JSON.stringify(run.result.emitted)), label).toStrictEqual(
          run.result.emitted,
        );
      }
    }
  });

  it("keeps every block a JSON-safe value", () => {
    for (const run of RUNS) {
      if (run.case.path === "notice") {
        continue;
      }
      const label = `${run.file}/${run.case.name}`;
      for (const block of blocksOf(run.result)) {
        expect(jsonViolations(block), `${label} ${block.id}`).toEqual([]);
      }
    }
  });

  it("builds the same blocks when the block and part builders are driven directly", () => {
    const testCase = caseOf("images", "base64 and url images keep their payload and position");
    const spec = testCase.input as LiveSpec;
    const state = createMessageStateFor({
      id: spec.messageId,
      messageType: "assistant_message",
      role: "assistant",
      body: null,
      runId: spec.runId,
      at: null,
    });
    const cursor = createPartsCursor();

    for (const frame of spec.frames) {
      appendText(state, frame.text ?? "");
      appendParts(state, frame.parts ?? [], cursor);
    }
    completeMessage(state);

    expect(state.blocks).toEqual(testCase.expect);
  });

  it("degrades malformed fixtures instead of throwing", () => {
    const malformed = fixtureFile("malformed");
    // The corpus defines eight malformed groups; eight must be present, and a deletion
    // or a ninth group that changes the contract both need a deliberate edit.
    expect(malformed.cases).toHaveLength(8);
    for (const testCase of malformed.cases) {
      expect(() => runCase(testCase), testCase.name).not.toThrow();
      expect(runCase(testCase).output).toEqual(testCase.expect);
    }
  });
});

describe("live text assembly", () => {
  it("agrees with the history path on the same fenced prose", () => {
    const live = blocksOf(
      runCase(caseOf("fenced-code", "a ts fence keeps its info string and the code verbatim")),
    );
    const history = parseHistoryPage([
      {
        id: "live-code",
        messageType: "assistant_message",
        role: "assistant",
        body: {
          content:
            "Here is the helper:\n```ts\nconst add = (a: number, b: number) => a + b;\n```\nIt returns the sum.\n",
        },
        runId: "run-code",
        at: null,
      },
    ]);

    expect(history.map((block) => block.type)).toEqual(live.map((block) => block.type));
    expect(history.map((block) => ("text" in block ? block.text : block.id))).toEqual(
      live.map((block) => ("text" in block ? block.text : block.id)),
    );
  });
});
