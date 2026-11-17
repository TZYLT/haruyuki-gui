/**
 * What this file proves: reading a long conversation costs time in proportion to
 * its length, not to its length squared.
 *
 * ## Why a ratio instead of a duration
 *
 * A wall-clock threshold on one machine says more about the machine than about the
 * code: the same 1000 messages take 3 s on one box and 9 s on a busy one. The ratio
 * between two lengths measured **in the same run** cancels that out, and it is the
 * only form that still means something when the numbers move.
 *
 * What a quadratic regression looks like: 10× the messages taking 100× the time.
 * So the assertion is a ratio against the message-count ratio, with slack for
 * constant costs (setting up a page, starting a promise).
 *
 * A loose absolute ceiling stays as a second check -- it catches "everything got
 * slower" even when the ratio looks fine.
 */

import { describe, expect, it } from "vitest";

import { createLedger } from "./approvals";
import { createPager } from "./messages";
import { runRecovery } from "./recovery";

const PAGE = 50;

/** A conversation of `count` messages, handed out in pages of 50. */
function conversation(count: number) {
  const ids = Array.from({ length: count }, (_unused, index) => `m${String(count - index)}`);
  let served = 0;

  return {
    fetch: async () => {
      const slice = ids.slice(served, served + PAGE);
      served += PAGE;
      const hasMore = served < ids.length;

      return {
        ok: true as const,
        page: {
          messages: slice.map((id) => ({ id })),
          hasMore,
          nextBefore: slice.at(-1) ?? null,
        },
      };
    },
  };
}

async function timeRecovery(count: number): Promise<number> {
  const source = conversation(count);
  const started = performance.now();

  const outcome = await runRecovery({
    sync: async () => ({ approvals: [], states: ["device", "loop", "queue", "subagent"] }),
    page: (args) =>
      createPager({ limit: PAGE, fetch: () => source.fetch() }).page({
        agentId: "agent-a",
        conversationId: "default",
        ...args,
      }),
    ledger: createLedger(),
    now: () => "2026-11-17T12:00:00.000Z",
    maxPages: Math.ceil(count / PAGE) + 1,
  });

  expect(outcome.appended).toBe(count);
  expect(outcome.stopReason).toBe("complete");

  return performance.now() - started;
}

describe("history reading scale", () => {
  it("costs about ten times more for ten times the messages, not a hundred", async () => {
    // Warm up so the first run does not pay for module initialisation that the
    // second one would not.
    await timeRecovery(2 * PAGE);

    const small = await timeRecovery(10 * PAGE);
    const large = await timeRecovery(100 * PAGE);

    // Quadratic would be 100x; ten-fold with slack for constant costs is the
    // honest ceiling for linear work.
    const ratio = large / Math.max(small, 0.05);

    expect(ratio).toBeLessThan(25);
    // Second check, independent of the ratio: 1000 messages inside a generous
    // absolute ceiling.
    expect(large).toBeLessThan(10_000);
  });
});
