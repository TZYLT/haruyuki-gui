/**
 * Integration tests: the merge loop against the recorded engine sessions.
 *
 * The per-module suites prove each part in isolation. What they cannot see is
 * the composition on real traffic, where the envelope is partial, two messages
 * share an id across the main line and a subagent, and one recording carries no
 * sequence numbers at all. Those are the shapes the corpus exists for.
 *
 * Every frame here is built the way B2 builds one: the wire message's envelope
 * fields (`event_seq`, `idempotency_key`, `runtime`, `emitted_at`) are lifted
 * into `envelope`, and the whole message stays as `raw`. A file without
 * `event_seq` gets no envelope at all rather than an empty one, because the
 * facts a frame contributes would otherwise change.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Frame } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type {
  EngineEventEnvelope,
  EngineEventFrame,
  RuntimeScope,
} from "../engine/client/index.js";
import { loadFixture } from "../testing/index.js";

import { asRecord, readString } from "./envelope.js";
import { createEventMerger } from "./event-merger.js";
import type { EventMerger, MergerChange } from "./types.js";

/** The recorded sessions, by scenario name. */
const RECORDINGS = [
  "approval",
  "compaction",
  "memory",
  "subagent",
  "terminal",
  "tool-call",
  "user-message",
] as const;

type RecordingName = (typeof RECORDINGS)[number];

/** `packages/core/src/merge` up to the repository root: four levels. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/**
 * One recording's replayable messages, in recorded order.
 *
 * Only `s2c` lines are engine events; the `c2s` lines are what the caller sent
 * and never reach the merger.
 *
 * @param name the scenario
 */
async function messagesOf(name: RecordingName): Promise<readonly Record<string, unknown>[]> {
  const fixture = await loadFixture(
    path.join(REPO_ROOT, "fixtures", "engine", "recordings", `${name}.jsonl`),
  );

  return fixture.lines.filter((line) => line.dir === "s2c").map((line) => line.msg);
}

/**
 * `msg.runtime` as the client's scope shape.
 *
 * A recording's runtime always has a conversation id; the frame builder keeps
 * only the two fields the envelope reader looks at, and drops the block when the
 * id is missing so the merger's default conversation applies instead of an
 * invented one.
 *
 * @param value the raw runtime block
 */
function runtimeScopeOf(value: unknown): RuntimeScope | undefined {
  const record = asRecord(value);
  const conversationId = readString(record?.["conversation_id"]);

  if (conversationId === null) {
    return undefined;
  }

  return { agent_id: readString(record?.["agent_id"]), conversation_id: conversationId };
}

/**
 * The envelope B2 would have attached to this message.
 *
 * `event_seq` decides whether an envelope exists at all: the terminal corpus has
 * no numbering, and a frame that never had one must not gain an empty envelope.
 *
 * @param msg one wire message
 */
function envelopeOf(msg: Record<string, unknown>): EngineEventEnvelope | undefined {
  const seq = msg["event_seq"];

  if (typeof seq !== "number") {
    return undefined;
  }

  const runtime = runtimeScopeOf(msg["runtime"]);
  const key = readString(msg["idempotency_key"]);
  const emittedAt = readString(msg["emitted_at"]);

  return {
    event_seq: seq,
    ...(runtime === undefined ? {} : { runtime }),
    ...(key === null ? {} : { idempotency_key: key }),
    ...(emittedAt === null ? {} : { emitted_at: emittedAt }),
  };
}

/**
 * The frames the client would hand the merger for a recording.
 *
 * @param messages the recording's `s2c` messages
 */
function framesOf(messages: readonly Record<string, unknown>[]): readonly EngineEventFrame[] {
  return messages.map((msg, index) => {
    const envelope = envelopeOf(msg);

    return {
      type: readString(msg["type"]) ?? "",
      raw: msg,
      at: index,
      ...(envelope === undefined ? {} : { envelope }),
    };
  });
}

/**
 * Ingest every frame and return the changes, in delivery order.
 *
 * @param merger the merger under test
 * @param frames the frames to feed
 */
function feed(merger: EventMerger, frames: readonly EngineEventFrame[]): readonly MergerChange[] {
  const changes: MergerChange[] = [];

  for (const frame of frames) {
    changes.push(...merger.ingest(frame));
  }

  return changes;
}

/** Replay one recording through a fresh merger. */
function replay(messages: readonly Record<string, unknown>[]): readonly MergerChange[] {
  return feed(createEventMerger({ agentId: "agent-a" }), framesOf(messages));
}

/**
 * The text of every `message.delta`, in delivery order.
 *
 * @param changes the changes to read
 */
function deltaTexts(changes: readonly MergerChange[]): string[] {
  const texts: string[] = [];

  for (const change of changes) {
    if (change.kind === "message.delta") {
      texts.push(change.text);
    }
  }

  return texts;
}

/**
 * Identity of one streamed message.
 *
 * All three parts are needed, and the key keeps them separate: a subagent's
 * message and the main line's message legitimately share the engine's id.
 *
 * @param author who said it
 * @param subagent the subagent context, or `null`
 * @param messageId the engine's message id
 */
function keyOf(author: string | null, subagent: string | null, messageId: string): string {
  return JSON.stringify([author, subagent, messageId]);
}

/**
 * The text every assistant message should end up with, read off the wire.
 *
 * A delta the classifier cannot place (no message id, no integer `seq_id`) is
 * skipped, mirroring the merger: the expectation must not contain text the
 * merger is right to drop.
 *
 * @param messages the recording's `s2c` messages
 */
function expectedTexts(messages: readonly Record<string, unknown>[]): Record<string, string> {
  const texts = new Map<string, string>();

  for (const msg of messages) {
    if (msg["type"] !== "stream_delta") {
      continue;
    }

    const delta = asRecord(msg["delta"]);

    if (delta === null || delta["message_type"] !== "assistant_message") {
      continue;
    }

    const messageId = readString(delta["id"]);
    const runSeq = delta["seq_id"];

    if (messageId === null || typeof runSeq !== "number" || !Number.isInteger(runSeq)) {
      continue;
    }

    const author =
      readString(delta["agent_id"]) ??
      readString(delta["session_id"]) ??
      readString(asRecord(msg["runtime"])?.["agent_id"]);
    const key = keyOf(author, readString(msg["subagent_id"]), messageId);

    let piece = "";
    const content = delta["content"];

    if (Array.isArray(content)) {
      for (const part of content) {
        const record = asRecord(part);

        if (record !== null && record["type"] === "text" && typeof record["text"] === "string") {
          piece += record["text"];
        }
      }
    }

    texts.set(key, (texts.get(key) ?? "") + piece);
  }

  return Object.fromEntries(texts);
}

/**
 * The text the merger actually assembled, per message identity.
 *
 * @param changes the changes to read
 */
function actualTexts(changes: readonly MergerChange[]): Record<string, string> {
  const texts = new Map<string, string>();

  for (const change of changes) {
    if (change.kind !== "message.delta") {
      continue;
    }

    const key = keyOf(change.authorAgentId, change.subagentId, change.messageId);
    texts.set(key, (texts.get(key) ?? "") + change.text);
  }

  return Object.fromEntries(texts);
}

/**
 * The text of one forwarded terminal slice.
 *
 * The protocol leaves a frame body `unknown`, so the body is narrowed here
 * rather than cast: a frame without text is a bug this test should report, not
 * silently count as an empty slice.
 *
 * @param frame one frame the merger handed to the sink
 */
function terminalText(frame: Frame<"term.output">): string {
  const body = asRecord(frame.body);
  const text = body?.["text"];

  if (typeof text !== "string") {
    throw new TypeError("terminal slice carries no text");
  }

  return text;
}

/** Whether an event type is a command reply that can arrive after its caller left. */
function isCommandReply(msg: Record<string, unknown>): boolean {
  const type = msg["type"];

  return typeof type === "string" && (type.endsWith("_response") || type === "input_accepted");
}

/** The corpus totals this file asserts on, measured one recording at a time. */
type CorpusClassification = {
  readonly frames: number;
  readonly unknownTypes: number;
  readonly passthroughFrames: number;
  readonly replies: number;
};

/** Feed every recording through its own merger and add up the counters. */
async function classifyCorpus(): Promise<CorpusClassification> {
  let frames = 0;
  let unknownTypes = 0;
  let passthroughFrames = 0;
  let replies = 0;

  for (const name of RECORDINGS) {
    const messages = await messagesOf(name);
    const merger = createEventMerger({ agentId: "agent-a" });

    feed(merger, framesOf(messages));

    frames += messages.length;
    unknownTypes += merger.stats().unknownTypes;
    passthroughFrames += merger.stats().passthroughFrames;
    replies += messages.filter(isCommandReply).length;
  }

  return { frames, unknownTypes, passthroughFrames, replies };
}

/** Whether a recording streams any assistant text at all. */
function streamsAssistant(messages: readonly Record<string, unknown>[]): boolean {
  return messages.some(
    (msg) =>
      msg["type"] === "stream_delta" &&
      asRecord(msg["delta"])?.["message_type"] === "assistant_message",
  );
}

describe("replay determinism", () => {
  it.each(RECORDINGS)("%s produces the same changes on two independent replays", async (name) => {
    const messages = await messagesOf(name);
    const first = replay(messages);
    const second = replay(messages);

    // Non-vacuity: every recording carries at least one frame the merger turns
    // into a change, so an empty sequence would be a merge that saw nothing.
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((change) => change.kind)).toEqual(second.map((change) => change.kind));
    expect(deltaTexts(first)).toEqual(deltaTexts(second));
  });
});

describe("assistant message reassembly", () => {
  it.each(RECORDINGS)("%s reassembles every assistant message from its deltas", async (name) => {
    const messages = await messagesOf(name);
    const expected = expectedTexts(messages);
    const actual = actualTexts(replay(messages));

    expect(actual).toEqual(expected);

    // Two empty maps compare equal, so the interesting recordings have to prove
    // they produced text; the ones without assistant deltas have to prove they
    // produced none.
    if (streamsAssistant(messages)) {
      expect(Object.keys(expected).length).toBeGreaterThan(0);
      expect(Object.values(expected).join("")).not.toBe("");
    } else {
      expect(expected).toEqual({});
      expect(actual).toEqual({});
    }
  });

  it("keeps a subagent's answer apart from the main line's when both reuse the id", async () => {
    const messages = await messagesOf("subagent");
    const changes = replay(messages);
    const expected = expectedTexts(messages);
    const actual = actualTexts(changes);
    const keys = Object.keys(expected);

    expect(keys).toHaveLength(2);
    expect(actualTexts(changes)).toEqual(expected);

    const subagentKey = keys.find((key) => key.includes("subagent-")) ?? "";
    const mainKey = keys.find((key) => !key.includes("subagent-")) ?? "";

    // Both messages really do carry the engine's id; only the author and the
    // subagent context separate them.
    expect(subagentKey).toContain("ui-msg-2");
    expect(mainKey).toContain("ui-msg-2");
    expect(actual[subagentKey]).toBe(expected[subagentKey]);
    expect(actual[mainKey]).toBe(expected[mainKey]);
    expect(actual[subagentKey]).not.toBe(actual[mainKey]);

    // The subagent's own stop delta ends that turn.
    expect(changes.some((change) => change.kind === "turn.stopped")).toBe(true);
  });
});

describe("terminal output", () => {
  it("forwards every byte of the terminal corpus through the frame sink", async () => {
    const messages = await messagesOf("terminal");
    const forwarded: string[] = [];
    const merger = createEventMerger({
      agentId: "agent-a",
      onFrame: (frame) => {
        forwarded.push(terminalText(frame));
      },
    });

    feed(merger, framesOf(messages));

    const sent = messages
      .filter((msg) => msg["type"] === "terminal_output")
      .map((msg) => (typeof msg["data"] === "string" ? msg["data"] : ""))
      .join("");

    expect(sent).not.toBe("");
    expect(forwarded.join("")).toBe(sent);
    expect(merger.stats().terminalDropped).toBe(0);
  });
});

describe("turn ends", () => {
  it.each(RECORDINGS)("%s closes a turn once, before any later delta", async (name) => {
    const messages = await messagesOf(name);
    const changes = replay(messages);
    const expectedTurns = messages.filter((msg) => msg["type"] === "turn_finished").length;
    const finishedIndexes = changes
      .map((change, index) => (change.kind === "turn.finished" ? index : -1))
      .filter((index) => index >= 0);

    expect(finishedIndexes).toHaveLength(expectedTurns);

    if (expectedTurns === 0) {
      return;
    }

    const lastDeltaIndex = changes.findLastIndex((change) => change.kind === "message.delta");
    const finishedIndex = finishedIndexes[0] ?? -1;

    // The recording sends only state frames after its turn end; text arriving
    // afterwards would mean a held delta was released into a closed turn.
    expect(finishedIndex).toBeGreaterThan(lastDeltaIndex);
  });
});

describe("event type coverage", () => {
  it("counts no event type in the corpus as unknown", async () => {
    const { frames, unknownTypes } = await classifyCorpus();

    // Non-vacuity: a corpus that failed to load would report zero unknowns for
    // the same reason a correct run does.
    expect(frames).toBeGreaterThan(0);
    expect(unknownTypes).toBe(0);
  });

  it("hands late command replies on as passthroughs instead of dropping them", async () => {
    const { passthroughFrames, replies } = await classifyCorpus();

    // A reply whose requester is gone has no state to apply, so it is not a
    // change; but it is also not an unknown type. The corpus count is measured
    // instead of hard-coded, so a reply type the merger stops classifying fails
    // here.
    expect(replies).toBeGreaterThan(0);
    expect(passthroughFrames).toBeGreaterThanOrEqual(replies);
  });
});
