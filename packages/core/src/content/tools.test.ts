/**
 * Tests for the tool table and its status machine.
 *
 * These pin the contract the model facade leans on: every message about one call
 * folds into a single block whose id never changes and whose position belongs to
 * the call, fragments append while complete records replace, the end marker of a
 * client-side call never closes it, the latest result wins, an unseen result still
 * becomes a block, `turn.finished` marks the leftovers `incomplete`, and the
 * per-message cap counts overflow instead of clearing what already exists.
 */

import { describe, expect, it } from "vitest";

import {
  clearTools,
  createToolTable,
  incompleteAll,
  incompleteForRun,
  ingestToolMessage,
  releaseToolMessage,
  toolStats,
  type ToolBlockUpdate,
} from "./tools.js";
import type { SourceMessage } from "./types.js";

const RUN = "run-1";

function message(
  id: string,
  messageType: string,
  body: unknown,
  runId: string | null = RUN,
): SourceMessage {
  return { id, messageType, role: "tool", body, runId, at: 0 };
}

/** A singular streamed call body. */
function toolCallBody(toolCallId: string, args: string, name = "Bash"): unknown {
  return { tool_call: { tool_call_id: toolCallId, name, arguments: args } };
}

/** A singular client-side start body. */
function clientStartBody(toolCallId: string, args: string, name = "Bash"): unknown {
  return { tool_call_id: toolCallId, tool_name: name, tool_args: args };
}

/** A singular client-side end body. */
function clientEndBody(toolCallId: string, status: string): unknown {
  return { tool_call_id: toolCallId, status };
}

/** A singular return body. */
function returnBody(toolCallId: string, result: unknown, status = "success"): unknown {
  return { tool_call_id: toolCallId, status, tool_return: result };
}

/** The ids of the blocks a batch of updates carries, in order. */
function idsOf(updates: readonly ToolBlockUpdate[]): string[] {
  return updates.map((update) => update.block.id);
}

describe("a single call", () => {
  it("builds one running block with the call's own identity", () => {
    const table = createToolTable();
    const updates = ingestToolMessage(
      table,
      message("msg-call", "tool_call_message", toolCallBody("call_1", '{"command":"ls"}')),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe("msg-call");
    const block = updates[0]?.block;
    expect(block?.id).toBe("tool:call_1");
    expect(block?.type).toBe("tool_call");
    expect(block?.role).toBe("tool");
    expect(block?.runId).toBe("run-1");
    expect(block?.toolCallId).toBe("call_1");
    expect(block?.name).toBe("Bash");
    expect(block?.argumentsText).toBe('{"command":"ls"}');
    expect(block?.result).toBeNull();
    expect(block?.status).toBe("running");
    expect(block?.orphan).toBe(false);
    expect(table.tools.size).toBe(1);
  });
});

describe("several calls in one message", () => {
  it("turns a plural call batch into one block per call, in body order", () => {
    const table = createToolTable();
    const updates = ingestToolMessage(
      table,
      message("msg-calls", "tool_call_message", {
        tool_calls: [
          { tool_call_id: "call_a", name: "Read", arguments: '{"path":"a"}' },
          { tool_call_id: "call_b", name: "Bash", arguments: '{"command":"b"}' },
        ],
      }),
    );

    expect(idsOf(updates)).toEqual(["tool:call_a", "tool:call_b"]);
    expect(updates.map((update) => update.block.name)).toEqual(["Read", "Bash"]);
    expect(updates.map((update) => update.block.status)).toEqual(["running", "running"]);
    expect(updates.every((update) => update.messageId === "msg-calls")).toBe(true);
  });

  it("accepts the function-shaped call entry and its nested arguments", () => {
    const table = createToolTable();
    const updates = ingestToolMessage(
      table,
      message("msg-fn", "tool_call_message", {
        tool_calls: [
          { id: "call_fn", type: "function", function: { name: "Grep", arguments: '{"q":"x"}' } },
        ],
      }),
    );

    expect(updates[0]?.block.id).toBe("tool:call_fn");
    expect(updates[0]?.block.name).toBe("Grep");
    expect(updates[0]?.block.argumentsText).toBe('{"q":"x"}');
  });

  it("updates a plural return batch one entry at a time", () => {
    const table = createToolTable();
    ingestToolMessage(
      table,
      message("msg-calls", "tool_call_message", {
        tool_calls: [
          { tool_call_id: "call_a", name: "Read", arguments: "{}" },
          { tool_call_id: "call_b", name: "Bash", arguments: "{}" },
        ],
      }),
    );

    const updates = ingestToolMessage(
      table,
      message("msg-returns", "tool_return_message", {
        tool_returns: [
          { tool_call_id: "call_a", status: "success", tool_return: "A" },
          { tool_call_id: "call_b", status: "error", tool_return: "B failed" },
        ],
      }),
    );

    expect(idsOf(updates)).toEqual(["tool:call_a", "tool:call_b"]);
    expect(updates.map((update) => update.block.status)).toEqual(["success", "error"]);
    expect(updates.map((update) => update.block.result)).toEqual(["A", "B failed"]);
    // A result updates the call's block, so it stays filed under the call message.
    expect(updates.map((update) => update.messageId)).toEqual(["msg-calls", "msg-calls"]);
  });
});

describe("argument fragments", () => {
  it("appends fragments into one block and ignores a replayed fragment message", () => {
    const table = createToolTable();

    const first = ingestToolMessage(
      table,
      message("msg-f1", "tool_call_message", toolCallBody("call_1", '{"command":')),
    );
    const second = ingestToolMessage(
      table,
      message("msg-f2", "tool_call_message", toolCallBody("call_1", '"echo hi"}')),
    );

    expect(first).toHaveLength(1);
    expect(idsOf(second)).toEqual(["tool:call_1"]);
    expect(second[0]?.block.argumentsText).toBe('{"command":"echo hi"}');
    expect(second[0]?.block.status).toBe("running");

    // The same fragment message delivered again must not append its text twice.
    const replay = ingestToolMessage(
      table,
      message("msg-f2", "tool_call_message", toolCallBody("call_1", '"echo hi"}')),
    );
    expect(replay).toHaveLength(0);
    expect(table.tools.size).toBe(1);

    // A client start of an already-running call changes nothing visible, but it
    // records that the final return is still owed.
    const start = ingestToolMessage(
      table,
      message("msg-start", "client_tool_start", clientStartBody("call_1", '{"command":"echo hi"}')),
    );
    expect(start).toHaveLength(0);
    expect(table.tools.get("call_1")?.argumentsText).toBe('{"command":"echo hi"}');
    expect(table.tools.get("call_1")?.awaitingFinal).toBe(true);
  });
});

describe("approval record", () => {
  it("replaces streamed fragments with the complete record and waits for approval", () => {
    const table = createToolTable();
    ingestToolMessage(
      table,
      message("msg-fragment", "tool_call_message", toolCallBody("call_1", '{"command":"ec')),
    );

    const approval = ingestToolMessage(
      table,
      message(
        "msg-approval",
        "approval_request_message",
        toolCallBody("call_1", '{"command":"echo hi"}'),
      ),
    );

    expect(approval).toHaveLength(1);
    expect(approval[0]?.block.id).toBe("tool:call_1");
    expect(approval[0]?.block.status).toBe("awaiting_approval");
    expect(approval[0]?.block.argumentsText).toBe('{"command":"echo hi"}');
    // The block keeps the call's first message, not the approval message.
    expect(approval[0]?.messageId).toBe("msg-fragment");

    // A complete record wins: a fragment after it must not be appended.
    const later = ingestToolMessage(
      table,
      message("msg-f3", "tool_call_message", toolCallBody("call_1", '{"command":"echo hi"}')),
    );
    expect(later).toHaveLength(0);

    const started = ingestToolMessage(
      table,
      message("msg-start", "client_tool_start", clientStartBody("call_1", '{"command":"echo hi"}')),
    );
    expect(started[0]?.block.status).toBe("running");
    expect(started[0]?.block.argumentsText).toBe('{"command":"echo hi"}');
  });
});

describe("client-side end", () => {
  it("keeps the call running through the end marker and closes on the final return", () => {
    const table = createToolTable();

    ingestToolMessage(
      table,
      message(
        "msg-approval",
        "approval_request_message",
        toolCallBody("call_1", '{"command":"a"}'),
      ),
    );
    ingestToolMessage(
      table,
      message("msg-start", "client_tool_start", clientStartBody("call_1", '{"command":"a"}')),
    );

    const snapshot = ingestToolMessage(
      table,
      message("msg-stream-return", "tool_return_message", returnBody("call_1", "a3-tool-ok")),
    );
    expect(snapshot[0]?.block.status).toBe("running");
    expect(snapshot[0]?.block.result).toBe("a3-tool-ok");

    // The end records a status but is not a closing edge.
    const end = ingestToolMessage(
      table,
      message("msg-end", "client_tool_end", clientEndBody("call_1", "success")),
    );
    expect(end).toHaveLength(0);
    expect(table.tools.get("call_1")?.status).toBe("running");

    const final = ingestToolMessage(
      table,
      message("msg-final-return", "tool_return_message", returnBody("call_1", "a3-tool-ok\r\n")),
    );
    expect(idsOf(final)).toEqual(["tool:call_1"]);
    expect(final[0]?.block.status).toBe("success");
    expect(final[0]?.block.result).toBe("a3-tool-ok\r\n");
    expect(table.tools.size).toBe(1);
  });
});

describe("two returns for one call", () => {
  it("overwrites the result and keeps the same block", () => {
    const table = createToolTable();
    ingestToolMessage(
      table,
      message("msg-call", "tool_call_message", toolCallBody("call_1", "{}")),
    );

    const first = ingestToolMessage(
      table,
      message("msg-r1", "tool_return_message", returnBody("call_1", "snapshot", "success")),
    );
    const second = ingestToolMessage(
      table,
      message("msg-r2", "tool_return_message", returnBody("call_1", "final output", "error")),
    );

    expect(first[0]?.block.result).toBe("snapshot");
    expect(first[0]?.block.status).toBe("success");
    expect(second[0]?.block.id).toBe(first[0]?.block.id);
    expect(second[0]?.block.result).toBe("final output");
    expect(second[0]?.block.status).toBe("error");
    expect(table.tools.size).toBe(1);
  });
});

describe("orphan results", () => {
  it("keeps a result whose call was never seen, image parts included", () => {
    const table = createToolTable();
    const result = [
      { type: "text", text: "screenshot" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ];

    const updates = ingestToolMessage(
      table,
      message("msg-return", "tool_return_message", returnBody("call_orphan", result, "error")),
    );

    expect(updates).toHaveLength(1);
    expect(updates[0]?.messageId).toBe("msg-return");
    const block = updates[0]?.block;
    expect(block?.id).toBe("tool:call_orphan");
    expect(block?.orphan).toBe(true);
    expect(block?.name).toBeNull();
    expect(block?.argumentsText).toBe("");
    expect(block?.status).toBe("error");
    expect(block?.result).toEqual(result);
    expect(toolStats(table).orphanTools).toBe(1);

    // A later call for the same id neither duplicates nor reopens the block.
    const later = ingestToolMessage(
      table,
      message("msg-call", "tool_call_message", toolCallBody("call_orphan", '{"x":1}')),
    );
    expect(later).toHaveLength(0);
    expect(table.tools.size).toBe(1);
  });
});

describe("turn finished", () => {
  it("marks only the finished run's open calls incomplete", () => {
    const table = createToolTable();
    ingestToolMessage(table, message("msg-a", "tool_call_message", toolCallBody("call_a", "{}")));
    ingestToolMessage(
      table,
      message("msg-b", "approval_request_message", toolCallBody("call_b", "{}")),
    );
    ingestToolMessage(
      table,
      message("msg-c", "tool_call_message", toolCallBody("call_c", "{}"), "run-2"),
    );
    ingestToolMessage(
      table,
      message("msg-a-return", "tool_return_message", returnBody("call_a", "done")),
    );

    const updates = incompleteForRun(table, "run-1");

    expect(updates.map((update) => update.block.toolCallId)).toEqual(["call_b"]);
    expect(updates[0]?.block.status).toBe("incomplete");
    expect(table.tools.get("call_c")?.status).toBe("running");
    expect(toolStats(table).inFlightToolCalls).toBe(1);

    // A return that arrives afterwards is still real evidence for the call.
    const late = ingestToolMessage(
      table,
      message("msg-late", "tool_return_message", returnBody("call_b", "late output")),
    );
    expect(late[0]?.block.status).toBe("success");
    expect(late[0]?.block.id).toBe("tool:call_b");
  });
});

describe("page end", () => {
  it("closes every open call as incomplete and leaves terminal ones alone", () => {
    const table = createToolTable();
    ingestToolMessage(
      table,
      message("msg-open", "tool_call_message", toolCallBody("call_open", "{}")),
    );
    ingestToolMessage(
      table,
      message("msg-no-status", "tool_call_message", toolCallBody("call_nostatus", "{}")),
    );
    ingestToolMessage(
      table,
      message("msg-no-status-return", "tool_return_message", {
        tool_call_id: "call_nostatus",
        tool_return: "unknown",
      }),
    );
    ingestToolMessage(
      table,
      message("msg-success", "tool_call_message", toolCallBody("call_success", "{}")),
    );
    ingestToolMessage(
      table,
      message("msg-success-return", "tool_return_message", returnBody("call_success", "ok")),
    );
    ingestToolMessage(
      table,
      message("msg-failed", "tool_call_message", toolCallBody("call_failed", "{}")),
    );
    ingestToolMessage(
      table,
      message(
        "msg-failed-return",
        "tool_return_message",
        returnBody("call_failed", "boom", "error"),
      ),
    );
    ingestToolMessage(
      table,
      message(
        "msg-incomplete",
        "tool_call_message",
        toolCallBody("call_incomplete", "{}"),
        "run-2",
      ),
    );
    incompleteForRun(table, "run-2");

    const updates = incompleteAll(table);

    expect(updates.map((update) => update.block.toolCallId)).toEqual([
      "call_open",
      "call_nostatus",
    ]);
    expect(updates.map((update) => update.block.status)).toEqual(["incomplete", "incomplete"]);
    expect(table.tools.get("call_success")?.status).toBe("success");
    expect(table.tools.get("call_failed")?.status).toBe("error");
    expect(table.tools.get("call_incomplete")?.status).toBe("incomplete");
  });
});

describe("release", () => {
  it("drops finished calls and keeps open ones until they finish", () => {
    const table = createToolTable();
    ingestToolMessage(
      table,
      message("msg-done", "tool_call_message", toolCallBody("call_done", "{}")),
    );
    ingestToolMessage(
      table,
      message("msg-done-return", "tool_return_message", returnBody("call_done", "ok")),
    );
    ingestToolMessage(
      table,
      message("msg-open", "tool_call_message", toolCallBody("call_open", "{}")),
    );

    releaseToolMessage(table, "msg-done");
    expect(table.tools.has("call_done")).toBe(false);
    expect(table.tools.has("call_open")).toBe(true);

    // Releasing the still-open call's message must not lose its future result.
    releaseToolMessage(table, "msg-open");
    expect(table.tools.has("call_open")).toBe(true);
    expect(toolStats(table).totalTools).toBe(1);

    // A call whose owner message was released while open is cleaned up once the
    // message that carries its final result is released, so the table cannot grow
    // for the whole conversation.
    ingestToolMessage(
      table,
      message("msg-late-open", "tool_call_message", toolCallBody("call_late", "{}")),
    );
    releaseToolMessage(table, "msg-late-open");
    expect(table.tools.has("call_late")).toBe(true);

    ingestToolMessage(
      table,
      message("msg-late-return", "tool_return_message", returnBody("call_late", "done")),
    );
    releaseToolMessage(table, "msg-late-return");
    expect(table.tools.has("call_late")).toBe(false);
    expect(table.byMessage.has("msg-late-open")).toBe(false);
    expect(toolStats(table).totalTools).toBe(1);

    clearTools(table);
    expect(toolStats(table)).toEqual({
      totalTools: 0,
      inFlightToolCalls: 0,
      awaitingApproval: 0,
      orphanTools: 0,
      truncatedTools: 0,
    });
  });
});

describe("per-message cap", () => {
  it("counts calls over the cap without clearing blocks already built", () => {
    const table = createToolTable({ maxToolsPerMessage: 2 });
    const updates = ingestToolMessage(
      table,
      message("msg-batch", "tool_call_message", {
        tool_calls: ["call_1", "call_2", "call_3", "call_4"].map((toolCallId) => ({
          tool_call_id: toolCallId,
          name: "Bash",
          arguments: `{"id":"${toolCallId}"}`,
        })),
      }),
    );

    expect(idsOf(updates)).toEqual(["tool:call_1", "tool:call_2"]);
    expect(table.tools.has("call_1")).toBe(true);
    expect(table.tools.has("call_2")).toBe(true);
    expect(table.tools.has("call_3")).toBe(false);
    expect(toolStats(table).totalTools).toBe(2);
    expect(toolStats(table).truncatedTools).toBe(2);

    // The quota is per message: another message has its own budget.
    const other = ingestToolMessage(
      table,
      message("msg-other", "tool_call_message", toolCallBody("call_9", "{}")),
    );
    expect(idsOf(other)).toEqual(["tool:call_9"]);
    expect(toolStats(table).truncatedTools).toBe(2);
  });
});

describe("malformed bodies", () => {
  it("contributes nothing for a body with no recognisable call", () => {
    const table = createToolTable();

    expect(ingestToolMessage(table, message("msg-null", "tool_call_message", null))).toHaveLength(
      0,
    );
    expect(
      ingestToolMessage(table, message("msg-array", "tool_call_message", [1, 2, 3])),
    ).toHaveLength(0);
    expect(
      ingestToolMessage(table, message("msg-no-id", "tool_call_message", { name: "Bash" })),
    ).toHaveLength(0);
    expect(
      ingestToolMessage(table, message("msg-return-null", "tool_return_message", "not json")),
    ).toHaveLength(0);
    expect(toolStats(table).totalTools).toBe(0);
  });
});
