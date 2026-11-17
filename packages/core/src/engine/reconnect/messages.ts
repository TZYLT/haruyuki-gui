/**
 * History paging for one conversation: one request per page, and nothing else.
 *
 * The engine answers one page at a time. How many pages a recovery is worth is a
 * decision, and decisions belong to the controller, so the pager asks once,
 * reports exactly what came back, and stops. It does not loop, retry, or
 * pre-fetch while the answer still looks promising: a pager that fetched "enough"
 * on its own would hide both the cost of a recovery and the fact that the choice
 * was ever made.
 *
 * ## The agent is an argument because the request cannot carry it any other way
 *
 * The engine command that lists messages has no request-scope field for the
 * agent, so the agent has to travel inside the query parameters, as though it
 * were part of the filter. Omitting it does not make the call slower - it makes
 * it fail: the engine invents a default agent name from the conversation id and
 * answers `Agent agent-local-default not found`, which reads like a missing
 * agent rather than a missing parameter. The pager therefore demands the agent
 * explicitly instead of leaving a caller free to forget it and then debug that
 * misleading answer.
 *
 * ## `hasMore` and the cursor are two separate facts
 *
 * {@link MessagePager.hasOlder} reads `hasMore` alone. The engine has been
 * observed answering "no more pages" while still returning a non-null cursor, so
 * a caller that pages until the cursor goes null asks for one page too many.
 * `nextBefore` is kept because a caller that does continue needs somewhere to
 * continue from - not because it means anything on its own.
 *
 * ## Failures are values
 *
 * Invalid arguments and a fetch that rejects both come back as
 * `{ ok: false, error }`. Nothing here throws: a caller would otherwise have to
 * write the "did that page work?" branch twice, once around the call and once
 * around the catch, and the two would eventually disagree.
 */

import type { MessagePage, MessagePager, PageFetcher, PageResult } from "./controller";

export interface PagerOptions {
  /** Default 50. */
  readonly limit?: number;
  readonly fetch: PageFetcher;
}

/** Used when neither the call nor the pager was configured with a limit. */
const DEFAULT_LIMIT = 50;

/**
 * The argument bag the contract takes, derived rather than re-declared so this
 * file and `controller.ts` cannot drift apart.
 */
type PageArgs = Parameters<MessagePager["page"]>[0];

/** Whether `value` is a string with at least one non-whitespace character. */
function isFilled(value: unknown): value is string {
  // The `typeof` guard is not pointless politeness: this is the boundary where an
  // untyped caller (a restored cursor, a settings file) arrives, and calling
  // `.trim()` on a number would throw out of a function whose point is not
  // throwing.
  return typeof value === "string" && value.trim().length > 0;
}

/** Whole numbers above zero. Fractional or absent limits are refused, not rounded. */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function createPager(options: PagerOptions): MessagePager {
  const { fetch } = options;
  // Kept unresolved on purpose: `undefined` here means "the caller said nothing",
  // which is a different fact from "the caller said 50". Resolution happens per
  // call, where the per-call limit can win.
  const configuredLimit = options.limit;

  /**
   * Why `args` cannot be sent, or `null` when they can.
   *
   * Checked before the fetch is touched, so a rejected argument costs no engine
   * round trip and cannot look like a page the engine refused.
   */
  function refusal(args: PageArgs, limit: number): string | null {
    if (!isFilled(args.agentId)) return "agentId must be a non-empty string";
    if (!isFilled(args.conversationId)) return "conversationId must be a non-empty string";
    if (!isPositiveInteger(limit)) return "limit must be a positive integer";
    return null;
  }

  async function page(args: PageArgs): Promise<PageResult> {
    // Per-call first, then the pager's own setting, then the constant: the
    // narrowest scope that said anything wins.
    const limit = args.limit ?? configuredLimit ?? DEFAULT_LIMIT;

    const problem = refusal(args, limit);
    if (problem !== null) {
      return { ok: false, error: new Error(`messages.page: ${problem}`) };
    }

    try {
      // `await` inside `try` is what turns a rejected promise into a value; the
      // bare `return fetch(...)` would hand the rejection to the caller. The
      // result is returned as it arrived - same object, same `messages` order -
      // because the caller is entitled to treat it as the engine's own answer.
      return await fetch({
        agentId: args.agentId,
        conversationId: args.conversationId,
        limit,
        before: args.before,
      });
    } catch (error) {
      // Passed through as-is: the caller knows better than this layer what a
      // particular rejection means, and rewriting it would lose that.
      return { ok: false, error };
    }
  }

  return {
    page,
    // `hasMore` only. See the module comment: a non-null `nextBefore` alongside
    // `hasMore: false` is a real engine answer, and treating the cursor as the
    // signal would make the caller request one page too many.
    hasOlder: (page: MessagePage): boolean => page.hasMore === true,
  };
}
