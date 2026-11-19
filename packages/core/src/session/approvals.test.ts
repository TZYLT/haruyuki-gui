/**
 * One request, three paths, one row - and a row that remembers how it ended.
 *
 * The defect this suite exists to catch is the doubled badge: the same approval
 * arrives as a decision request, inside the device snapshot, and again in a
 * replay, and a table that files each arrival separately shows one waiting
 * request two or three times. Every assertion about the size of the waiting half
 * is therefore an assertion about deduplication, and each one goes red the moment
 * the id stops being the key.
 *
 * The second defect is subtler and the reason the resolution tests exist: a table
 * that only ever grows keeps counting an approval the user answered minutes ago,
 * so the count has to come down as well as up - and come down without deleting the
 * row, because the contract's entity carries three states and a table that filed
 * only waiters would implement two of them as constants.
 *
 * The third is what a resolution means afterwards: a decision is final, so the
 * same id turning up again - a late re-push, a replayed pass - must not start
 * waiting a second time.
 *
 * The remaining cases pin the "nothing throws, nothing is invented" rule: an
 * arrival with no request id has no key to deduplicate on, so it is counted and
 * skipped rather than filed under a made-up one, and three shapes of malformed
 * input each come back as a code.
 */

import { readFileSync } from "node:fs";

import type { ApprovalEntity } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { MergerChange } from "../merge/types.js";
import type { ApprovalTable } from "./approvals.js";
import { APPROVAL_RESOLVED_LIMIT, APPROVAL_TABLE_LIMIT, createApprovalTable } from "./approvals.js";

/** The fields every change carries. */
function base(overrides: Partial<MergerChange> = {}): Record<string, unknown> {
  return {
    authorAgentId: "agent-a",
    runtimeAgentId: "agent-a",
    subagentId: null,
    conversationId: "default",
    at: 1,
    ...overrides,
  };
}

/** A `control_request` frame as the merge layer would hand it over. */
function decisionRequest(
  requestId: string | undefined,
  options: { readonly at?: number; readonly tool?: string; readonly agentId?: string } = {},
): MergerChange {
  return {
    ...base({
      at: options.at ?? 1,
      authorAgentId: options.agentId ?? "agent-a",
      runtimeAgentId: options.agentId ?? "agent-a",
    }),
    kind: "approval.requested",
    requestId,
    body: {
      type: "control_request",
      request_id: "should-not-be-the-key",
      request: {
        subtype: "can_use_tool",
        tool_name: options.tool ?? "Bash",
        input: { command: "echo hi" },
      },
    },
  } as MergerChange;
}

/** One entry in a device snapshot's pending list. */
function pendingEntry(requestId: string, tool = "Bash"): Record<string, unknown> {
  return {
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: tool, input: { command: "echo hi" } },
  };
}

/** A `state.device` change carrying a pending list. */
function deviceSnapshot(
  entries: readonly Record<string, unknown>[],
  options: { readonly at?: number; readonly agentId?: string } = {},
): MergerChange {
  return {
    ...base({
      at: options.at ?? 2,
      authorAgentId: options.agentId ?? "agent-a",
      runtimeAgentId: options.agentId ?? "agent-a",
    }),
    kind: "state.device",
    value: { device_status: { is_online: true, pending_control_requests: entries } },
  } as MergerChange;
}

/** The resync reply the replay path arrives behind. */
function syncReply(raw: Record<string, unknown>, at = 3): MergerChange {
  return {
    ...base({ at }),
    kind: "passthrough",
    type: "sync_response",
    raw,
  } as MergerChange;
}

/** The ids a table holds as waiting, in order. */
function idsOf(table: ApprovalTable): string[] {
  return table.pending().map((row: ApprovalEntity) => row.requestId);
}

/** Every recorded s2c frame of one fixture, in file order. */
function recorded(file: string): readonly Record<string, unknown>[] {
  const path = new URL(`../../../../fixtures/engine/recordings/${file}`, import.meta.url);
  const text = readFileSync(path, "utf8");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The merge layer's change for one recorded approval frame, or `null`. */
function changeOf(frame: Record<string, unknown>): MergerChange | null {
  const message = frame["msg"] as Record<string, unknown> | undefined;
  const at = typeof frame["at"] === "number" ? frame["at"] : 0;

  if (message === undefined || frame["dir"] !== "s2c") {
    return null;
  }

  switch (message["type"]) {
    case "control_request":
      return {
        ...base({ at }),
        kind: "approval.requested",
        requestId: message["request_id"],
        body: message,
      } as MergerChange;

    case "update_device_status": {
      const state = message["device_status"];

      return { ...base({ at }), kind: "state.device", value: state } as MergerChange;
    }

    default:
      return null;
  }
}

describe("one request across three paths", () => {
  it("counts a request once when all three paths report it", () => {
    const table = createApprovalTable();

    // The decision request, the device snapshot, and a replay of the same id.
    table.ingest(decisionRequest("req-1"));
    table.ingest(deviceSnapshot([pendingEntry("req-1")]));
    table.applyReplay(["req-1"]);

    expect(table.pendingCount()).toBe(1);
    expect(idsOf(table)).toEqual(["req-1"]);
    expect(table.size).toBe(1);
  });

  it("keeps one row and updates it when a second path describes the same id differently", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-2", { at: 10, tool: "Bash" }));

    const first = table.get("req-2");
    expect(first).not.toBeNull();
    expect(first?.toolName).toBe("Bash");

    // The device snapshot names the same request with a fuller body and a
    // different arrival time: one row, updated in place, first stamp kept.
    table.ingest(deviceSnapshot([pendingEntry("req-2", "Read")], { at: 20 }));

    const after = table.get("req-2");
    expect(table.pendingCount()).toBe(1);
    expect(table.stats().added).toBe(1);
    expect(table.stats().refreshed).toBe(1);
    expect(after?.toolName).toBe("Read");
    expect(after?.requestedAt).toBe(10);
  });

  it("never reports more than one row for one id, however many times it arrives", () => {
    const table = createApprovalTable();
    let peak = 0;

    for (let round = 0; round < 5; round += 1) {
      table.ingest(decisionRequest("req-3"));
      table.ingest(deviceSnapshot([pendingEntry("req-3")]));
      table.applyReplay(["req-3"]);
      peak = Math.max(peak, table.pendingCount());
    }

    expect(peak).toBe(1);
    expect(table.pendingCount()).toBe(1);
    expect(table.stats().added).toBe(1);
  });
});

describe("an approval that is no longer waiting", () => {
  it("stops counting the row when the device snapshot stops listing it", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-4"));
    expect(table.pendingCount()).toBe(1);

    table.ingest(deviceSnapshot([pendingEntry("req-4")]));
    expect(table.pendingCount()).toBe(1);

    // The next snapshot lists nothing: the approval stopped waiting.
    table.ingest(deviceSnapshot([]));

    expect(table.pendingCount()).toBe(0);
    expect(idsOf(table)).toEqual([]);
    // The row is still readable, and says how it ended. Nothing on this path
    // reported a decision, so this module cannot claim one.
    expect(table.get("req-4")?.state).toBe("expired");
    expect(table.stats().expired).toBe(1);
  });

  it("stops counting the row when a replay pass no longer reports it", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-5"));
    table.ingest(decisionRequest("req-6"));
    expect(table.pendingCount()).toBe(2);

    // The engine replayed one of the two: the other stopped waiting.
    table.applyReplay(["req-5"]);

    expect(table.pendingCount()).toBe(1);
    expect(idsOf(table)).toEqual(["req-5"]);
    expect(table.get("req-6")?.state).toBe("expired");
    expect(table.stats().replayResolved).toBe(1);
  });

  it("stops counting the row when a resync reply names an empty list", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-7"));
    table.ingest(syncReply({ type: "sync_response", pending_control_requests: [] }));

    expect(table.pendingCount()).toBe(0);
    expect(table.get("req-7")?.state).toBe("expired");
  });

  it("leaves the rows waiting when a snapshot names no pending list at all", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-8"));
    // A device frame whose payload is a plain object naming no list: the engine
    // did not say "nothing is waiting", so nothing is resolved on the strength of
    // it.
    table.ingest({ ...base(), kind: "state.device", value: {} } as MergerChange);

    expect(table.pendingCount()).toBe(1);
    expect(table.get("req-8")?.state).toBe("pending");
    expect(table.stats().missingList).toBe(1);
  });

  it("does not let one agent's snapshot resolve another agent's rows", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-9", { agentId: "agent-b" }));

    // This snapshot comes from another connection and lists nothing at all; it
    // says nothing about a request it never listed.
    table.ingest(deviceSnapshot([], { agentId: "agent-a" }));

    expect(table.pendingCount("agent-b")).toBe(1);
    expect(table.pendingCount()).toBe(1);
    expect(table.get("req-9")?.state).toBe("pending");
  });
});

describe("a decision is final", () => {
  it("records the answer and stops counting the row", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-decided"));
    expect(table.pendingCount()).toBe(1);
    expect(table.get("req-decided")?.state).toBe("pending");

    // The answer is sent from this side, so the caller says so here; no frame
    // reports it.
    expect(table.resolve("req-decided")).toBe(true);

    expect(table.pendingCount()).toBe(0);
    expect(idsOf(table)).toEqual([]);
    expect(table.get("req-decided")?.state).toBe("decided");
    expect(table.stats().decided).toBe(1);
    expect(table.stats().expired).toBe(0);
    // The row survives its wait, with the facts it was filed under.
    expect(table.get("req-decided")?.toolName).toBe("Bash");
    expect(table.resolved().map((row) => row.requestId)).toEqual(["req-decided"]);
  });

  it("takes the requested verdict when it is an expiry", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-lapsed"));
    table.resolve("req-lapsed", "expired");

    expect(table.pendingCount()).toBe(0);
    expect(table.get("req-lapsed")?.state).toBe("expired");
    expect(table.stats().expired).toBe(1);
    expect(table.stats().decided).toBe(0);
  });

  it("never starts waiting again when the resolved id comes back on any path", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-once"));
    table.resolve("req-once");

    // A late re-push of the live frame, the device snapshot, and a replayed pass
    // all name it again. An id is decided once.
    table.ingest(decisionRequest("req-once"));
    table.ingest(deviceSnapshot([pendingEntry("req-once")]));
    table.applyReplay(["req-once"]);

    expect(table.pendingCount()).toBe(0);
    expect(idsOf(table)).toEqual([]);
    expect(table.get("req-once")?.state).toBe("decided");
    expect(table.stats().added).toBe(1);
    expect(table.stats().decided).toBe(1);
  });

  it("is idempotent: answering twice, or answering a stranger, changes nothing", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-twice"));

    expect(table.resolve("req-twice")).toBe(true);
    expect(table.resolve("req-twice")).toBe(false);
    expect(table.resolve("never-seen")).toBe(false);

    expect(table.pendingCount()).toBe(0);
    expect(table.resolved()).toHaveLength(1);
    expect(table.stats().decided).toBe(1);
  });
});

describe("the pending count a badge reads", () => {
  it("counts per agent and in total, and never counts a finished row", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest("req-a", { agentId: "agent-a" }));
    table.ingest(decisionRequest("req-b", { agentId: "agent-b" }));
    table.ingest(decisionRequest("req-b-2", { agentId: "agent-b" }));

    expect(table.pendingCount()).toBe(3);
    expect(table.pendingCount("agent-a")).toBe(1);
    expect(table.pendingCount("agent-b")).toBe(2);
    expect(table.pending("agent-b").map((row) => row.requestId)).toEqual(["req-b", "req-b-2"]);

    table.resolve("req-b");

    expect(table.pendingCount()).toBe(2);
    expect(table.pendingCount("agent-b")).toBe(1);
    expect(table.resolved("agent-b").map((row) => row.requestId)).toEqual(["req-b"]);
    // The entity is still there, only no longer counted as waiting.
    expect(table.size).toBe(3);
  });
});

describe("an approval with nothing to key on", () => {
  it("counts a missing request id and never files it", () => {
    const table = createApprovalTable();

    table.ingest(decisionRequest(undefined));
    table.ingest(decisionRequest(""));

    expect(table.size).toBe(0);
    expect(table.stats().missingId).toBe(2);
  });

  it("counts a replay entry with no id and skips it", () => {
    const table = createApprovalTable();

    table.applyReplay([{ request: {} }, "req-10"]);

    expect(idsOf(table)).toEqual(["req-10"]);
    expect(table.stats().missingId).toBe(1);
  });
});

describe("malformed input", () => {
  it("survives a body that is not an object", () => {
    const table = createApprovalTable();

    // The key is still readable, so the row is filed with nothing invented.
    const change = {
      ...base(),
      kind: "approval.requested",
      requestId: "req-11",
      body: null,
    } as MergerChange;

    table.ingest(change);

    expect(table.get("req-11")?.toolName).toBe("");
    expect(table.get("req-11")?.input).toEqual({});
  });

  it("survives a device payload that is not an object", () => {
    const table = createApprovalTable();

    table.ingest({ ...base(), kind: "state.device", value: 42 } as MergerChange);
    table.ingest({
      ...base(),
      kind: "approval.requested",
      requestId: "req-12",
      body: {},
    } as MergerChange);

    expect(table.pendingCount()).toBe(1);
    expect(table.stats().missingList).toBe(1);
  });

  it("survives a payload that throws when read", () => {
    const table = createApprovalTable();

    const hostile = {
      ...base(),
      kind: "approval.requested",
      get requestId(): string {
        throw new Error("revoked");
      },
      body: {},
    } as unknown as MergerChange;

    // The caller is a socket callback: one unreadable arrival must not escape.
    expect(() => table.ingest(hostile)).not.toThrow();
    expect(table.stats().unreadable).toBe(1);
    expect(table.size).toBe(0);
  });

  it("counts a pending list entry that is not an object", () => {
    const table = createApprovalTable();

    table.ingest(deviceSnapshot([{ request_id: "req-13" }, "not-an-entry", null] as never));

    expect(table.pendingCount()).toBe(1);
    expect(table.stats().unreadable).toBe(2);
  });

  it("never throws when asked to resolve a value that is not an id", () => {
    const table = createApprovalTable();

    expect(() => table.resolve("")).not.toThrow();
    expect(table.resolve("")).toBe(false);
    expect(table.pendingCount()).toBe(0);
  });
});

describe("bounds", () => {
  it("evicts the oldest waiting row instead of growing without limit", () => {
    const table = createApprovalTable({ limit: 2 });

    table.ingest(decisionRequest("req-14"));
    table.ingest(decisionRequest("req-15"));
    table.ingest(decisionRequest("req-16"));

    expect(table.pendingCount()).toBe(2);
    expect(table.get("req-14")).toBeNull();
    expect(table.stats().evictedPending).toBe(1);
  });

  it("gives finished rows their own bound and never evicts a waiter for one", () => {
    const table = createApprovalTable({ limit: 2, resolvedLimit: 1 });

    table.ingest(decisionRequest("req-17"));
    table.ingest(decisionRequest("req-18"));

    table.resolve("req-17");
    table.resolve("req-18");

    // The second resolution pushed the first out of the finished half; both
    // waiters were resolved, so neither was dropped to make room.
    expect(table.pendingCount()).toBe(0);
    expect(table.resolved().map((row) => row.requestId)).toEqual(["req-18"]);
    expect(table.stats().evictedResolved).toBe(1);
    expect(table.stats().evictedPending).toBe(0);
  });

  it("corrects a bound that is not a positive integer", () => {
    const table = createApprovalTable({ limit: 0, resolvedLimit: -1 });

    expect(APPROVAL_TABLE_LIMIT).toBeGreaterThan(0);
    expect(APPROVAL_RESOLVED_LIMIT).toBeGreaterThan(0);

    table.ingest(decisionRequest("req-19"));
    table.resolve("req-19");

    expect(table.pendingCount()).toBe(0);
    expect(table.resolved()).toHaveLength(1);
  });
});

describe("the recorded approval session", () => {
  const frames = recorded("approval.jsonl");
  const changes = frames.map(changeOf).filter((change): change is MergerChange => change !== null);

  it("finds the decision request and the device snapshot that carry one id", () => {
    const table = createApprovalTable();

    for (const change of changes) {
      table.ingest(change);
    }

    // One request was asked and then stopped being listed: the live frame and
    // the device snapshot both reported it, the table counted it once, and it is
    // now a resolved row rather than a waiting one.
    expect(table.pendingCount()).toBe(0);
    expect(table.stats().deviceSnapshots + table.stats().missingList).toBeGreaterThan(0);
    expect(table.stats().added).toBeGreaterThan(0);
    expect(table.stats().expired).toBe(table.stats().added);
    expect(table.size).toBe(table.stats().added);
  });

  it("never rises above one badge for that request while it waits", () => {
    const table = createApprovalTable();
    let peak = 0;

    for (const change of changes) {
      table.ingest(change);
      peak = Math.max(peak, table.pendingCount());
    }

    expect(peak).toBe(1);
    expect(table.stats().missingId).toBe(0);
  });
});
