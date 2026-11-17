/**
 * Tests for the approval ledger.
 *
 * Every case is about a user-visible count after a reconnection, so the cases
 * assert whole lists rather than flags: "one stale approval" and "two stale
 * approvals" differ by a doubled row on screen, and only the list shows which
 * one a change produced. The clock is injected everywhere, so no test depends on
 * the real time and a first-wins stamp is checked against a value the test
 * controls.
 */

import { describe, expect, it } from "vitest";

import { createLedger } from "./approvals";
import type { ApprovalLedger, PendingApproval } from "./controller";

const STAMP = "2024-01-01T00:00:00.000Z";

function approval(requestId: string, at = STAMP): PendingApproval {
  return { requestId, at };
}

/** The ids of a result list, in the order the ledger keeps them. */
function idsOf(list: readonly PendingApproval[]): string[] {
  return list.map((entry) => entry.requestId);
}

/** A clock that never moves, so a stamp the ledger invented is recognisable. */
function fixedClock(): { now: () => string; calls: () => number } {
  let calls = 0;
  return {
    now: () => {
      calls += 1;
      return "2024-06-01T12:00:00.000Z";
    },
    calls: () => calls,
  };
}

/**
 * Two tests here say "does not accumulate", and they must not share a name.
 *
 * They fail in different places: a second reconcile with the same set exercises
 * settlement (the number must not grow), while one id pushed twice inside a
 * single reconcile exercises dedupe (counting by id, not by frame). A shared name
 * would make "which one broke" a question answered by reading every test, so the
 * names say which mechanism each one pins.
 */
describe("createLedger", () => {
  it("records one waiting approval per id and keeps the first stamp", () => {
    const ledger: ApprovalLedger = createLedger();
    ledger.notePending(approval("req-1", "2024-01-01T00:00:00.000Z"));
    ledger.notePending(approval("req-1", "2024-02-02T00:00:00.000Z"));

    // The second note is a no-op: one entry, and it still carries the first
    // stamp, because that is when the approval was first seen waiting.
    expect(ledger.pendingCount()).toBe(1);
    expect(ledger.reconcile([]).stale).toEqual([
      { requestId: "req-1", at: "2024-01-01T00:00:00.000Z" },
    ]);
  });

  it("forgets a resolved approval so it is never reported stale", () => {
    const ledger = createLedger();
    ledger.notePending(approval("answered-early"));
    ledger.notePending(approval("still-waiting"));

    ledger.noteResolved("answered-early");
    ledger.noteResolved("answered-early");
    // An id nobody noted is a no-op, not a late arrival to remember.
    ledger.noteResolved("never-seen");

    expect(ledger.pendingCount()).toBe(1);
    expect(idsOf(ledger.reconcile([]).stale)).toEqual(["still-waiting"]);
    expect(idsOf(ledger.reconcile([]).pending)).toEqual([]);
  });

  it("splits what came back from what the resync forgot", () => {
    const ledger = createLedger();
    const first = approval("req-1", "2024-01-01T00:00:01.000Z");
    const second = approval("req-2", "2024-01-01T00:00:02.000Z");
    ledger.notePending(first);
    ledger.notePending(second);

    const result = ledger.reconcile(["req-1"]);

    // The entries are the remembered objects, so a caller that stored the
    // approval it noted sees the same instance come back with its own stamp.
    expect(result.pending).toHaveLength(1);
    expect(result.pending[0]).toBe(first);
    expect(result.stale).toHaveLength(1);
    expect(result.stale[0]).toBe(second);
  });

  it("does not accumulate across a second replay", () => {
    const ledger = createLedger();
    ledger.notePending(approval("req-1"));
    ledger.notePending(approval("req-2"));

    // The recovery resyncs, then a retry resyncs again with the same set. Two
    // waiting approvals, one pushed back, so the answer is one stale -- not two
    // rows, and not zero after the first call consumed something.
    const firstRun = ledger.reconcile(["req-1"]);
    const retry = ledger.reconcile(["req-1"]);

    expect(idsOf(firstRun.stale)).toEqual(["req-2"]);
    expect(idsOf(retry.stale)).toEqual(["req-2"]);
    expect(retry.stale).toHaveLength(1);
    expect(idsOf(retry.pending)).toEqual(["req-1"]);
    // The identical query is answered from the cache rather than recomputed.
    expect(retry).toBe(firstRun);
    // Only one of the two is still waiting: the other was dropped by the resync.
    expect(ledger.pendingCount()).toBe(1);
  });

  it("counts an id once even when pushed twice", () => {
    const ledger = createLedger();
    ledger.notePending(approval("req-1"));

    const result = ledger.reconcile(["req-1", "req-1"]);

    expect(idsOf(result.pending)).toEqual(["req-1"]);
    expect(idsOf(result.stale)).toEqual([]);
  });

  it("keeps stale approvals remembered so a later set still sees them", () => {
    const ledger = createLedger();
    const first = approval("req-1", "2024-01-01T00:00:01.000Z");
    const second = approval("req-2", "2024-01-01T00:00:02.000Z");
    ledger.notePending(first);
    ledger.notePending(second);

    expect(idsOf(ledger.reconcile(["req-1"]).stale)).toEqual(["req-2"]);
    // Reconciling did not forget req-2: a later resync that does push it back
    // reports it as waiting, with the stamp it was first noted with.
    expect(ledger.reconcile(["req-2"]).pending).toEqual([second]);
    expect(ledger.reconcile(["req-1", "req-2"]).stale).toEqual([]);
    expect(ledger.pendingCount()).toBe(2);
  });

  it("does not carry the previous answer into a newly noted approval", () => {
    const ledger = createLedger();
    ledger.notePending(approval("req-1"));
    const before = ledger.reconcile(["req-1"]);
    expect(idsOf(before.stale)).toEqual([]);

    ledger.notePending(approval("req-2"));
    const after = ledger.reconcile(["req-1"]);

    // The new approval is only known since after the last resync answered, so it
    // cannot have been in that set: it is stale now, and the answer that was
    // already handed out did not grow a row underneath its caller.
    expect(idsOf(after.stale)).toEqual(["req-2"]);
    expect(after).not.toBe(before);
    expect(idsOf(before.stale)).toEqual([]);
  });

  it("counts what is waiting, not what is remembered", () => {
    const ledger = createLedger();
    ledger.notePending(approval("req-1"));
    ledger.notePending(approval("req-2"));

    expect(ledger.pendingCount()).toBe(2);
    ledger.reconcile(["req-1"]);
    // The resync stopped pushing req-2, so it is remembered but not waiting.
    expect(ledger.pendingCount()).toBe(1);

    // A resolution removes the entry entirely, and the other stays stale.
    ledger.noteResolved("req-1");
    expect(ledger.pendingCount()).toBe(0);
    expect(idsOf(ledger.reconcile([]).stale)).toEqual(["req-2"]);
  });

  it("counts an approval the engine pushes again after being dropped", () => {
    const ledger = createLedger();
    ledger.notePending(approval("req-1"));
    ledger.reconcile([]);
    expect(ledger.pendingCount()).toBe(0);

    // A push after a resync means the approval is waiting again; the earlier
    // "no longer waiting" mark must not keep it out of the count.
    ledger.notePending(approval("req-1"));
    expect(ledger.pendingCount()).toBe(1);
  });

  it("returns two empty lists for an empty ledger and never throws", () => {
    const ledger = createLedger();

    expect(ledger.reconcile([])).toEqual({ pending: [], stale: [] });
    // A recovery that reconnects before any approval arrived asks again.
    expect(ledger.reconcile(["req-1"]).stale).toEqual([]);
    expect(ledger.pendingCount()).toBe(0);
  });

  it("falls back to the clock only when the caller leaves the stamp out", () => {
    const clock = fixedClock();
    const ledger = createLedger({ now: clock.now });

    ledger.notePending({ requestId: "no-stamp" } as PendingApproval);
    ledger.notePending(approval("given-stamp", STAMP));

    expect(ledger.reconcile([]).stale).toEqual([
      { requestId: "no-stamp", at: "2024-06-01T12:00:00.000Z" },
      { requestId: "given-stamp", at: STAMP },
    ]);
    // A supplied stamp is kept as given; the clock is not consulted for it.
    expect(clock.calls()).toBe(1);
  });
});
