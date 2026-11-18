/**
 * Fixture corpus and per-block snapshots for the content model's two paths.
 *
 * Every fixture under `fixtures/content/` is hand-written, synthetic and small:
 * one JSON file per message class, and each case names the path that must
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
      return { ...(JSON.parse(text) as FixtureFile), file: name.replace(/\.json$/, "") };
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
  it("covers at least ten fixture classes", () => {
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

  it("keeps agent-only XML out of every prose block", () => {
    // Non-vacuity: the input really carries the marker a stripping regression
    // would leave in the output.
    const reminderInput = caseOf("reminders", "prose around a reminder stays one span").input;
    expect(JSON.stringify(reminderInput)).toContain("<system-reminder");

    const textBlocks = RUNS.flatMap((run) => textBlocksOf(blocksOf(run.result)));
    expect(textBlocks.length).toBeGreaterThan(0);
    for (const block of textBlocks) {
      expect(block.text).not.toContain("<system-reminder");
      expect(block.text).not.toContain("<task-notification");
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
      expect(JSON.parse(JSON.stringify(run.result.output)), label).toEqual(run.result.output);
      if (run.result.emitted !== null) {
        expect(JSON.parse(JSON.stringify(run.result.emitted)), label).toEqual(run.result.emitted);
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
    expect(malformed.cases.length).toBeGreaterThanOrEqual(6);
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
