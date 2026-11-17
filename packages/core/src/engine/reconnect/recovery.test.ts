/**
 * What this file proves: the counting and the sequence.
 *
 * Given a set of approvals remembered as waiting and a set the resync pushed
 * back, the stale count is what the code says it is, the pages are read in order
 * until the engine says there are no older ones (or the budget runs out), and the
 * steps arrive in the order the render layer expects.
 *
 * What it does not prove: that the engine re-pushes a waiting approval at all.
 * No recording of that behaviour exists in this repository -- a real approval is
 * addressed to the client, and the recorder is not one -- so the resync side is
 * supplied by a stub here and the claim rests on reading the resync path, not on
 * a frame anyone captured.
 */

import { describe, expect, it } from "vitest";

import { createLedger } from "./approvals";
import { createPager } from "./messages";
import type { PageResult } from "./controller";
import { runRecovery } from "./recovery";
import type { RecoveryPorts, SyncOutcome } from "./recovery";
import type { RecoveryStep } from "./types";

const at = "2026-11-17T12:00:00.000Z";

function ledgerWith(ids: readonly string[]) {
  const ledger = createLedger();
  for (const id of ids) {
    ledger.notePending({ requestId: id, at });
  }
  return ledger;
}

function pageOf(ids: readonly string[], hasMore: boolean, nextBefore: string | null): PageResult {
  return {
    ok: true,
    page: { messages: ids.map((id) => ({ id })), hasMore, nextBefore },
  };
}

function ports(overrides: Partial<RecoveryPorts> & { sync?: () => Promise<SyncOutcome> } = {}) {
  const calls: Array<string | null> = [];

  const base: RecoveryPorts = {
    sync: async () => ({ approvals: [], states: ["device", "loop", "queue", "subagent"] }),
    page: async ({ before }) => {
      calls.push(before);
      return { ok: false, error: new Error("no page configured") };
    },
    ledger: createLedger(),
    now: () => at,
    ...overrides,
  };

  return { ports: base, calls };
}

describe("recovery sequence", () => {
  it("counts what the resync forgot as stale", async () => {
    // Two were waiting; the resync pushes one back. The other will never be
    // answered, so it is stale -- and this subtraction is the only source of the
    // number.
    const ledger = ledgerWith(["req-1", "req-2"]);
    const { ports: input } = ports({
      sync: async () => ({ approvals: ["req-1"], states: ["device", "loop"] }),
      page: async () => pageOf(["m3"], false, "m3"),
      ledger,
    });

    const outcome = await runRecovery(input);

    expect(outcome.staleCount).toBe(1);
    expect(outcome.approvalsRecovered).toBe(1);
    expect(outcome.stopReason).toBe("complete");
  });

  it("does not accumulate when the recovery runs twice", async () => {
    // A retry resyncs. Running the same reconciliation again must not turn one
    // stale approval into two.
    const ledger = ledgerWith(["req-1", "req-2"]);
    const { ports: input } = ports({
      sync: async () => ({ approvals: ["req-1"], states: ["device"] }),
      page: async () => pageOf(["m3"], false, "m3"),
      ledger,
    });

    const first = await runRecovery(input);
    const second = await runRecovery(input);

    expect(first.staleCount).toBe(1);
    expect(second.staleCount).toBe(1);
  });

  it("reports nothing stale when everything came back", async () => {
    const ledger = ledgerWith(["req-1", "req-2"]);
    const { ports: input } = ports({
      sync: async () => ({ approvals: ["req-1", "req-2"], states: ["device"] }),
      page: async () => pageOf([], false, null),
      ledger,
    });

    const outcome = await runRecovery(input);

    expect(outcome.staleCount).toBe(0);
  });

  it("reads pages in order until the engine says there are no older ones", async () => {
    // `hasMore` is the stop rule; the cursor on that last page is still set,
    // because the engine really does return one there.
    const pages: PageResult[] = [
      pageOf(["m5", "m4"], true, "m4"),
      pageOf(["m3", "m2"], true, "m2"),
      pageOf(["m1"], false, "m1"),
    ];
    const seen: Array<string | null> = [];
    const { ports: input } = ports({
      page: async ({ before }) => {
        seen.push(before);
        return pages.shift() ?? pageOf([], false, null);
      },
    });

    const outcome = await runRecovery(input);

    expect(seen).toEqual([null, "m4", "m2"]);
    expect(outcome.pages).toBe(3);
    expect(outcome.appended).toBe(5);
    expect(outcome.hasMore).toBe(false);
    expect(outcome.nextBefore).toBe("m1");
    expect(outcome.stopReason).toBe("complete");
  });

  it("stops on the page budget and says so", async () => {
    const { ports: input } = ports({
      page: async () => pageOf(["m"], true, "m"),
    });

    const outcome = await runRecovery(input);

    expect(outcome.pages).toBe(3);
    expect(outcome.hasMore).toBe(true);
    expect(outcome.stopReason).toBe("page-budget");
  });

  it("honours a page budget and a page size the caller chose", async () => {
    const seen: number[] = [];
    const { ports: input } = ports({
      maxPages: 1,
      pageLimit: 2,
      page: async ({ limit }) => {
        seen.push(limit);
        return pageOf(["m2", "m1"], true, "m1");
      },
    });

    const outcome = await runRecovery(input);

    expect(seen).toEqual([2]);
    expect(outcome.pages).toBe(1);
    expect(outcome.stopReason).toBe("page-budget");
  });

  it("stops on a failed page and keeps what it already had", async () => {
    let call = 0;
    const { ports: input } = ports({
      page: async () => {
        call += 1;
        return call === 1 ? pageOf(["m2"], true, "m2") : { ok: false, error: new Error("boom") };
      },
    });

    const outcome = await runRecovery(input);

    expect(outcome.pages).toBe(1);
    expect(outcome.appended).toBe(1);
    expect(outcome.stopReason).toBe("history-failed");
  });

  it("reports the steps in the order the render layer expects", async () => {
    const steps: RecoveryStep[] = [];
    const { ports: input } = ports({
      sync: async () => ({ approvals: ["req-1"], states: ["device", "queue"] }),
      page: async () => pageOf(["m2", "m1"], false, "m1"),
    });

    await runRecovery(input, (step) => steps.push(step));

    expect(steps.map((step) => step.step)).toEqual(["sync", "messages", "states"]);
    const states = steps[2];
    expect(states !== undefined && states.step === "states" ? states.covered : []).toEqual([
      "device",
      "queue",
    ]);
  });

  it("lets a failed resync fail the whole sequence", async () => {
    // Everything after the resync would be acting on a view known to be
    // incomplete, so there is nothing useful to report as a partial success.
    const { ports: input } = ports({
      sync: async () => {
        throw new Error("resync failed");
      },
    });

    await expect(runRecovery(input)).rejects.toThrow("resync failed");
  });

  it("keys the ledger through the pager, so a page of ids is what decides continuity", async () => {
    // The two halves meet here: the pager is what fetches, and the ledger is what
    // remembers. A recovery built out of both must not need a third copy of
    // either.
    const ledger = ledgerWith(["req-1"]);
    const pager = createPager({
      fetch: async () => ({
        ok: true,
        page: { messages: [{ id: "m1" }], hasMore: false, nextBefore: "m1" },
      }),
    });
    const { ports: input } = ports({
      ledger,
      page: (args) => pager.page({ agentId: "agent-a", conversationId: "default", ...args }),
      sync: async () => ({ approvals: [], states: ["device"] }),
    });

    const outcome = await runRecovery(input);

    expect(outcome.pages).toBe(1);
    expect(outcome.staleCount).toBe(1);
  });
});
