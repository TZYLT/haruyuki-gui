/**
 * The context figures, pinned from the six sides that make them trustable.
 *
 * Every case can fail on its own, and each one names the wrong rule it catches:
 *
 * - the ceiling comes from three layers, in order, and the first answer wins;
 * - with no ceiling the ratio is absent, not zero -- an absent denominator is
 *   not a denominator of zero;
 * - a value that is exactly the server's legacy clamp is skipped, and the search
 *   continues downwards rather than stopping;
 * - a missing numerator is absent, not zero;
 * - a component's share is divided by the measured occupancy when there is one,
 *   by the estimates only when there is not;
 * - malformed reports are read as absent, never thrown over.
 *
 * Three of these were verified by breaking the module on purpose: filling an
 * absent ceiling with the sum of the parts, reporting an absent ratio as zero,
 * and dropping the clamp test. Each turns its own test red and leaves the others
 * green, which is what makes these assertions evidence rather than decoration.
 */

import { describe, expect, it } from "vitest";

import type { ContextView } from "@haruyuki/protocol";

import {
  contextShareDenominator,
  deriveContextView,
  LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
  readContextParts,
  readContextTokens,
  resolveContextLimit,
  usableContextWindow,
  type ContextLimitCandidates,
} from "./context.js";

/** One usage report as the merger hands it over: the engine's numbers, renamed. */
const MEASURED = {
  contextTokens: 23169,
  contextSystemTokens: 2074,
  contextMessagesTokens: 464,
  contextToolsTokens: 21305,
} as const;

/** The same report as the engine sends it, for the raw-delta reading path. */
const RAW = {
  delta: {
    context_tokens: 23169,
    context_system_tokens: 2074,
    context_messages_tokens: 464,
    context_tools_tokens: 21305,
  },
} as const;

/**
 * The five constructed inputs and the five answers they must produce.
 *
 * The table is the acceptance criterion itself: five rows in, five rows out. A
 * module that invents a ceiling, or that treats the clamp as one, fails a named
 * row instead of an aggregate.
 */
const FALLBACK_TABLE: ReadonlyArray<{
  readonly name: string;
  readonly candidates: ContextLimitCandidates;
  readonly limit: number | null;
  readonly source: ContextView["source"];
}> = [
  {
    name: "(a) conversation override alongside a model preset",
    candidates: { conversationOverride: 200_000, modelCatalog: 1_000_000 },
    limit: 200_000,
    source: "conversation-override",
  },
  {
    name: "(b) the agent's effective value only",
    candidates: { agentConfig: 400_000 },
    limit: 400_000,
    source: "agent-config",
  },
  {
    name: "(c) the model catalog only",
    candidates: { modelCatalog: 1_000_000 },
    limit: 1_000_000,
    source: "model-catalog",
  },
  {
    name: "(d) none of the three",
    candidates: {},
    limit: null,
    source: "none",
  },
  {
    name: "(e) exactly the clamp value and no preset match",
    candidates: {
      conversationOverride: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
      agentConfig: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
      modelCatalog: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
    },
    limit: null,
    source: "none",
  },
];

describe("the ceiling and where it came from", () => {
  it.each(FALLBACK_TABLE)("$name", ({ candidates, limit, source }) => {
    expect(resolveContextLimit(candidates)).toEqual({ limit, source });
    // The view must carry the same answer: two entry points, one rule.
    const view = deriveContextView(MEASURED, candidates);
    expect(view.limit).toBe(limit);
    expect(view.source).toBe(source);
  });

  it("prefers the highest layer that has a usable value, whatever the order of the rest", () => {
    expect(resolveContextLimit({ agentConfig: 400_000, modelCatalog: 1_000_000 })).toEqual({
      limit: 400_000,
      source: "agent-config",
    });
  });

  it("keeps looking below a clamp value instead of giving up", () => {
    // The clamp is skipped, so the next layer still answers. This is the half of
    // the rule the table's last row cannot show on its own: "not this value" is
    // not "none at all".
    expect(
      resolveContextLimit({
        conversationOverride: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
        agentConfig: 400_000,
      }),
    ).toEqual({ limit: 400_000, source: "agent-config" });
  });

  it("keeps a 128k window that the model's own presets carry", () => {
    expect(
      resolveContextLimit({
        modelCatalog: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
        presetMatchesClamp: true,
      }),
    ).toEqual({ limit: LEGACY_SERVER_CONTEXT_WINDOW_CLAMP, source: "model-catalog" });
  });

  it("refuses anything that is not a positive finite window", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "200000", null]) {
      expect(usableContextWindow(value)).toBeNull();
    }
    expect(usableContextWindow(200_000)).toBe(200_000);
    expect(
      resolveContextLimit({ conversationOverride: 0, agentConfig: -5, modelCatalog: Number.NaN }),
    ).toEqual({
      limit: null,
      source: "none",
    });
  });

  it("reads a caller that supplies no candidates at all", () => {
    expect(resolveContextLimit()).toEqual({ limit: null, source: "none" });
    expect(resolveContextLimit(null)).toEqual({ limit: null, source: "none" });
    expect(resolveContextLimit(undefined)).toEqual({ limit: null, source: "none" });
  });
});

describe("the ratio", () => {
  it("is the measured occupancy over the ceiling, as a percentage", () => {
    const view = deriveContextView(MEASURED, { agentConfig: 100_000 });
    expect(view.tokens).toBe(23169);
    expect(view.limit).toBe(100_000);
    expect(view.percentage).toBeCloseTo(23.169, 6);
  });

  it("is null, not zero, when there is no ceiling", () => {
    // A zero here would render as an empty bar and read as "nothing used", which
    // is the opposite of "we do not know the ceiling".
    const view = deriveContextView(MEASURED, {});
    expect(view.limit).toBeNull();
    expect(view.percentage).toBeNull();
    expect(view.percentage).not.toBe(0);
  });

  it("stays above one hundred when the occupancy is above the ceiling", () => {
    // Not clamped: an over-full context is a real state a page must be able to
    // show rather than a number to tidy away.
    const view = deriveContextView(MEASURED, { agentConfig: 10_000 });
    expect(view.percentage).toBeCloseTo(231.69, 6);
  });

  it("is null when the numerator is missing, but the ceiling is still reported", () => {
    const view = deriveContextView({}, { agentConfig: 100_000 });
    expect(view.tokens).toBeNull();
    expect(view.limit).toBe(100_000);
    expect(view.percentage).toBeNull();
    expect(view.parts).toBeNull();
    expect(view.estimated).toBe(false);
  });
});

describe("the numerator", () => {
  it("reads the renamed snapshot field and the engine's raw one", () => {
    expect(readContextTokens(MEASURED)).toBe(23169);
    expect(readContextTokens(RAW)).toBe(23169);
  });

  it("is absent rather than zero when it was not reported", () => {
    expect(readContextTokens({ contextTokens: null })).toBeNull();
    expect(readContextTokens({ context_tokens: null })).toBeNull();
    expect(readContextTokens({})).toBeNull();
    expect(readContextTokens(null)).toBeNull();
  });

  it("does not crash when the report is malformed", () => {
    // The caller is a socket callback, and a missing figure is never worth a
    // session.
    for (const bad of [
      "garbage",
      42,
      [],
      { contextTokens: "23169" },
      { context_tokens: Number.NaN },
      true,
    ]) {
      const view = deriveContextView(bad, { agentConfig: 100_000 });
      expect(view.tokens).toBeNull();
      expect(view.percentage).toBeNull();
    }
  });
});

describe("the three estimates", () => {
  it("reads all three components", () => {
    expect(readContextParts(MEASURED)).toEqual({ system: 2074, tools: 21305, messages: 464 });
    expect(readContextParts(RAW)).toEqual({ system: 2074, tools: 21305, messages: 464 });
  });

  it("is null when no component was reported, and zeroes only the missing ones otherwise", () => {
    expect(readContextParts({ contextTokens: 23169 })).toBeNull();
    expect(readContextParts({ contextSystemTokens: 2074 })).toEqual({
      system: 2074,
      tools: 0,
      messages: 0,
    });
  });

  it("divides a component's share by the measured occupancy, not by the sum", () => {
    // The acceptance point of the sharing rule: the estimate is meant to approach
    // the measured figure, so the measured figure is the denominator.
    const parts = { system: 2074, messages: 464, tools: 21305 };
    expect(contextShareDenominator(parts, 23169)).toBe(23169);
    expect(contextShareDenominator(parts, 23169)).not.toBe(
      parts.system + parts.messages + parts.tools,
    );
  });

  it("divides by the sum only when no measurement exists", () => {
    // An old ledger row, or a request the provider gave no occupancy for.
    const parts = { system: 2074, messages: 464, tools: 21305 };
    const sum = parts.system + parts.messages + parts.tools;
    expect(contextShareDenominator(parts, null)).toBe(sum);
    expect(contextShareDenominator(parts, undefined)).toBe(sum);
    expect(contextShareDenominator(parts, 0)).toBe(sum);
    expect(contextShareDenominator(parts, -1)).toBe(sum);
    expect(contextShareDenominator(parts, Number.NaN)).toBe(sum);
    expect(contextShareDenominator(null, null)).toBeNull();
  });

  it("marks the view as estimated only when it carries estimates", () => {
    expect(deriveContextView(MEASURED, { agentConfig: 100_000 }).estimated).toBe(true);
    expect(deriveContextView({ contextTokens: 23169 }, { agentConfig: 100_000 }).estimated).toBe(
      false,
    );
  });
});

describe("what a consumer may do with the view", () => {
  it("hands out a frozen value, since several readers share it", () => {
    const view = deriveContextView(MEASURED, { agentConfig: 100_000 });
    expect(Object.isFrozen(view)).toBe(true);
    expect(() => {
      (view as { limit: number | null }).limit = 1;
    }).toThrow();
  });

  it("keeps the absence of a ceiling distinguishable from a ceiling of zero", () => {
    // The whole point of `null`: a page prints the absolute figure and no ratio,
    // which no number can be made to stand for.
    const unknown = deriveContextView(MEASURED, {});
    const known = deriveContextView(MEASURED, { agentConfig: 200_000 });
    expect(unknown).not.toEqual(known);
    expect(unknown.percentage).toBeNull();
    expect(known.percentage).not.toBeNull();
  });
});
