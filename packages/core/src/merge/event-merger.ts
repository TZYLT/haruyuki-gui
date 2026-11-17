/**
 * The merge loop: one engine event in, stable changes out.
 *
 * This module is the only place that knows the order in which the parts run. A
 * frame is read for its envelope facts, checked against the two idempotency
 * tables (the stream's sequence number and the frame's own key), handed to the
 * ordering gate, and only when the gate releases it is the payload mapped. That
 * order matters: mapping before ordering would emit a delta twice when the gate
 * later recognises a repeat, and ordering before the key check would let a
 * duplicate spend a buffer slot.
 *
 * Three rules hold across every branch:
 *
 * - **Nothing throws.** The caller is a socket callback; a malformed payload
 *   must cost one frame, not the session. Every branch degrades to "count it and
 *   move on".
 * - **Delivery is synchronous.** Subscribers see a change before `ingest`
 *   returns, so the batch window downstream is the only thing that can delay
 *   text. A subscriber that throws loses its own change and nothing else.
 * - **A terminal frame is not a change.** Terminal bytes go straight to the
 *   frame sink and never enter the change stream, because the renderer writes
 *   them outside the UI state tree: routing them through state would make every
 *   keystroke of output a React update.
 */

import type { Frame } from "@haruyuki/protocol";

import type { EngineEventFrame } from "../engine/client/index.js";
import { readEnvelope, asRecord, readString } from "./envelope.js";
import type { EnvelopeFacts } from "./envelope.js";
import { createDedupe } from "./dedupe.js";
import type { Dedupe } from "./dedupe.js";
import { createOrderGate } from "./order.js";
import { createAssembler } from "./assemble.js";
import type { Assembler } from "./assemble.js";
import { classifyDelta } from "./project.js";
import { stateChangeOf } from "./state.js";
import { terminalFramesOf } from "./terminal.js";
import { createStats } from "./stats.js";
import type { MergeStatsTracker } from "./stats.js";
import type {
  EventMerger,
  EventMergerOptions,
  MergerChange,
  MergeStats,
  ResetReason,
  UsageSnapshot,
} from "./types.js";
import { MERGE_LIMITS } from "./types.js";

/** Event types that are known to be informational and produce a passthrough. */
const PASSTHROUGH_TYPES: ReadonlySet<string> = new Set([
  "memory_updated",
  "terminal_spawned",
  "terminal_exited",
]);

/** How many run-to-usage entries to remember for a later `turn.finished`. */
const USAGE_LIMIT = 256;

/** One open message, remembered so a turn end can close it. */
type OpenMessage = {
  readonly authorAgentId: string | null;
  readonly subagentId: string | null;
  readonly messageId: string;
};

/**
 * Build an event merger.
 *
 * @param options the channel's agent, bounds and the terminal frame sink
 */
export function createEventMerger(options: EventMergerOptions): EventMerger {
  const conversationId = options.defaultConversationId ?? "default";
  const limits = options.limits ?? {};

  const gate = createOrderGate<EngineEventFrame>();
  const keys: Dedupe = createDedupe(limits.dedupe ?? MERGE_LIMITS.dedupe);
  const assembler: Assembler = createAssembler({
    limit: limits.assembling ?? MERGE_LIMITS.assembling,
  });
  const counters: MergeStatsTracker = createStats(limits.stats ?? MERGE_LIMITS.stats);

  const subscribers = new Set<(change: MergerChange) => void>();

  /** Open messages by assembly key, so a turn end can complete them. */
  const openMessages = new Map<string, OpenMessage>();

  /** Usage per `(author, subagent, run)`, kept until the turn that reported it ends. */
  const usageByRun = new Map<string, UsageSnapshot>();

  /** Whether a gap was seen since the current turn began. */
  let turnIncomplete = false;

  /** Remembering a failure to hand one terminal frame to the sink. */
  const emitTerminal = (frames: readonly Frame<"term.output">[]): void => {
    if (options.onFrame === undefined) {
      if (frames.length > 0) {
        counters.count("terminalDropped", frames.length);
      }

      return;
    }

    for (const frame of frames) {
      try {
        options.onFrame(frame);
      } catch {
        // The shell's transport failed for this frame. Counting it is the only
        // honest signal; retrying would duplicate bytes if the failure was in
        // the acknowledgement rather than in the write.
        counters.count("terminalDropped");
      }
    }
  };

  /** Tell every subscriber, in subscription order, and isolate failures. */
  const dispatch = (changes: readonly MergerChange[]): void => {
    for (const change of changes) {
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(change);
        } catch {
          // A consumer that throws loses its own change, never the next
          // consumer's and never the next frame's.
        }
      }
    }
  };

  const usageKey = (
    authorAgentId: string | null,
    subagentId: string | null,
    runId: string | null,
  ): string => [authorAgentId, subagentId, runId].join("\u0000");

  const rememberUsage = (
    facts: EnvelopeFacts,
    snapshot: UsageSnapshot,
    runId: string | null,
  ): void => {
    usageByRun.delete(usageKey(facts.authorAgentId, facts.subagentId, runId));
    usageByRun.set(usageKey(facts.authorAgentId, facts.subagentId, runId), snapshot);

    while (usageByRun.size > USAGE_LIMIT) {
      const oldest = usageByRun.keys().next();

      if (oldest.done) {
        return;
      }

      usageByRun.delete(oldest.value);
    }
  };

  const takeUsage = (facts: EnvelopeFacts, runId: string | null): UsageSnapshot | null => {
    const key = usageKey(facts.authorAgentId, facts.subagentId, runId);
    const found = usageByRun.get(key);

    if (found === undefined) {
      return null;
    }

    usageByRun.delete(key);

    return found;
  };

  /** Complete every open message of one author, because its turn ended. */
  const closeMessages = (facts: EnvelopeFacts, at: number, out: MergerChange[]): void => {
    for (const [key, open] of openMessages) {
      if (open.authorAgentId !== facts.authorAgentId) {
        continue;
      }

      openMessages.delete(key);

      const done = assembler.complete(open.authorAgentId, open.subagentId, open.messageId);

      if (done === null) {
        continue;
      }

      if (done.incomplete) {
        counters.count("incompleteMessages");
      }

      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at,
        kind: "message.complete",
        messageId: done.messageId,
        runId: done.runId,
        textLength: done.textLength,
        incomplete: done.incomplete,
      });
    }
  };

  /** Map one delivered frame (already ordered) to zero or more changes. */
  const mapFrame = (frame: EngineEventFrame, facts: EnvelopeFacts): MergerChange[] => {
    const type = frame.type;
    const raw = frame.raw;
    const out: MergerChange[] = [];

    if (type === "stream_delta") {
      const classified = classifyDelta(raw);

      if (classified === null) {
        counters.noteUnknown(type);

        return out;
      }

      if (classified.kind === "assistant") {
        const delta = assembler.push({
          authorAgentId: facts.authorAgentId,
          subagentId: facts.subagentId,
          messageId: classified.messageId,
          runId: classified.runId,
          runSeq: classified.runSeq,
          parts: classified.parts,
          at: facts.at,
        });

        if (delta === null) {
          counters.count("duplicates");

          return out;
        }

        openMessages.set(
          [facts.authorAgentId, facts.subagentId, classified.messageId].join("\u0000"),
          {
            authorAgentId: facts.authorAgentId,
            subagentId: facts.subagentId,
            messageId: classified.messageId,
          },
        );

        // A restart is announced before the first new piece, so a consumer
        // that clears on reset has already cleared when the text arrives.
        if (delta.reset) {
          out.push({
            authorAgentId: facts.authorAgentId,
            runtimeAgentId: facts.runtimeAgentId ?? "",
            subagentId: facts.subagentId,
            conversationId: facts.conversationId,
            at: facts.at,
            kind: "message.reset",
            messageId: delta.messageId,
            runId: delta.runId,
            reason: "resend-from-start",
          });
        }

        out.push({
          authorAgentId: facts.authorAgentId,
          runtimeAgentId: facts.runtimeAgentId ?? "",
          subagentId: facts.subagentId,
          conversationId: facts.conversationId,
          at: facts.at,
          kind: "message.delta",
          messageId: delta.messageId,
          runId: delta.runId,
          runSeq: delta.runSeq,
          text: delta.text,
          parts: delta.parts,
          first: delta.first,
        });

        return out;
      }

      if (classified.kind === "usage") {
        rememberUsage(facts, classified.usage, classified.runId);

        out.push({
          authorAgentId: facts.authorAgentId,
          runtimeAgentId: facts.runtimeAgentId ?? "",
          subagentId: facts.subagentId,
          conversationId: facts.conversationId,
          at: facts.at,
          kind: "usage.reported",
          runId: classified.runId,
          usage: classified.usage,
        });

        return out;
      }

      if (classified.kind === "stop") {
        // `requires_approval` pauses the turn: the tool call is waiting for a
        // person, and the assistant message may still grow after the approval.
        // Closing it here would make the continuation look like a new message.
        if (classified.stopReason !== "requires_approval") {
          closeMessages(facts, facts.at, out);
        }

        out.push({
          authorAgentId: facts.authorAgentId,
          runtimeAgentId: facts.runtimeAgentId ?? "",
          subagentId: facts.subagentId,
          conversationId: facts.conversationId,
          at: facts.at,
          kind: "turn.stopped",
          runId: classified.runId,
          turnId: null,
          stopReason: classified.stopReason,
        });

        return out;
      }

      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at: facts.at,
        kind: "message.final",
        messageId: classified.messageId,
        runId: classified.runId,
        messageType: classified.messageType,
        body: classified.body,
      });

      return out;
    }

    const state = stateChangeOf(type, raw, facts);

    if (state !== null) {
      out.push(state);

      return out;
    }

    if (type === "turn_finished") {
      closeMessages(facts, facts.at, out);

      const record = asRecord(raw);
      const runId = readString(record?.["run_id"]);
      const usage = takeUsage(facts, runId);
      const incomplete = turnIncomplete;

      if (turnIncomplete) {
        counters.count("incompleteTurns");
      }

      turnIncomplete = false;

      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at: facts.at,
        kind: "turn.finished",
        turnId: readString(record?.["turn_id"]) ?? "",
        runId,
        stopReason: readString(record?.["stop_reason"]) ?? "",
        usage,
        incomplete,
      });

      return out;
    }

    if (type === "control_request") {
      const record = asRecord(raw);

      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at: facts.at,
        kind: "approval.requested",
        requestId: readString(record?.["request_id"]) ?? "",
        body: raw,
      });

      return out;
    }

    if (type === "terminal_output") {
      emitTerminal(terminalFramesOf(type, raw, facts));

      return out;
    }

    // A response that reaches the merge loop did not match a pending request:
    // its requester is gone, or the answer came late. It carries nothing the
    // merger can apply, but it is not an unknown type either, and handing it on
    // as a passthrough keeps "the engine sent something nobody understood"
    // separate from "an answer arrived after its caller gave up".
    if (type.endsWith("_response") || type === "input_accepted") {
      counters.count("passthroughFrames");
      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at: facts.at,
        kind: "passthrough",
        type,
        raw,
      });

      return out;
    }

    if (PASSTHROUGH_TYPES.has(type)) {
      counters.count("passthroughFrames");
      out.push({
        authorAgentId: facts.authorAgentId,
        runtimeAgentId: facts.runtimeAgentId ?? "",
        subagentId: facts.subagentId,
        conversationId: facts.conversationId,
        at: facts.at,
        kind: "passthrough",
        type,
        raw,
      });

      return out;
    }

    counters.noteUnknown(type);

    return out;
  };

  /** Deliver the frames the gate released, then act on the outcome's facts. */
  const deliverOutcome = (
    deliver: readonly { readonly seq: number; readonly value: EngineEventFrame }[],
  ): MergerChange[] => {
    const out: MergerChange[] = [];

    for (const item of deliver) {
      counters.count("orderedFrames");
      const facts = readEnvelope(item.value, conversationId);
      out.push(...mapFrame(item.value, facts));
    }

    return out;
  };

  return {
    ingest(frame) {
      const out: MergerChange[] = [];

      try {
        const facts = readEnvelope(frame, conversationId);

        if (facts.idempotencyKey !== null) {
          if (keys.seen(facts.idempotencyKey)) {
            counters.count("duplicates");

            return [];
          }

          keys.add(facts.idempotencyKey);
        }

        if (facts.seq === null) {
          counters.count("unorderedFrames");
          out.push(...mapFrame(frame, facts));

          return out;
        }

        const outcome = gate.accept(facts.seq, frame);

        if (outcome.duplicate) {
          counters.count("duplicates");
        }

        if (outcome.late) {
          counters.count("late");
          turnIncomplete = true;
        }

        if (outcome.rebaselined) {
          counters.noteRebaseline(facts.at);
        }

        for (const gap of outcome.gaps) {
          counters.noteGap(gap.from, gap.to, facts.at);
          turnIncomplete = true;
        }

        out.push(...deliverOutcome(outcome.deliver));

        dispatch(out);

        return out;
      } catch {
        // A merge loop that throws is a dead session. Whatever went wrong is
        // counted by the branch that saw it; this net exists for the branch
        // that did not anticipate it.
        return out;
      }
    },

    subscribe(callback) {
      subscribers.add(callback);

      return () => {
        subscribers.delete(callback);
      };
    },

    stats(): MergeStats {
      return counters.snapshot();
    },

    reset(reason: ResetReason) {
      gate.reset();
      keys.clear();
      usageByRun.clear();
      turnIncomplete = false;
      // The assembly table is deliberately kept: a message that was streaming
      // when the connection dropped continues under the same id after it comes
      // back, and dropping the half here would make the user watch it disappear.
      counters.markReset(reason, Date.now());
    },

    watermark() {
      return gate.watermark();
    },
  };
}
