/**
 * Context pressure: the numerator a provider reports, the ceiling it is divided
 * by, and the share of each component.
 *
 * Three rulings live here, and each one is a place where the obvious
 * implementation is wrong:
 *
 * 1. **The ceiling comes from three places, in order.** A conversation may carry
 *    its own limit, the agent's effective configuration may carry one, and the
 *    model catalog may know the model's window. The first one that exists wins.
 *    When none of them exists the limit is `null` -- "no ceiling" -- and never a
 *    number made up to fill the gap. A page renders that as the absolute figure
 *    with no ratio, which is the honest reading; a fabricated denominator would
 *    show a model with a very large window as nearly full.
 *
 * 2. **The server's legacy 128k clamp is not a ceiling.** A model-bearing update
 *    that omitted the window historically had it clamped to a global default,
 *    so a value of exactly {@link LEGACY_SERVER_CONTEXT_WINDOW_CLAMP} is
 *    indistinguishable from that clamping *unless* the model's own presets
 *    legitimately carry it. The engine reaches the same conclusion before it
 *    preserves a window across a model switch, and it falls back to the preset
 *    or catalog value; here the same treatment means "skip this layer and keep
 *    looking", because keeping a poisoned value would be permanent.
 *
 * 3. **The share denominator is not the sum of the parts.** The parts are a
 *    four-bytes-per-token estimate; the provider's `context_tokens` is the
 *    measured occupancy, and it is what the occupancy ratio uses. The estimate
 *    is only supposed to *approach* the measured figure; dividing the parts by
 *    their own sum would force them to total one hundred percent by
 *    construction and hide exactly the error the estimate admits. The sum is the
 *    denominator only when the provider reported no occupancy at all.
 *
 * Nothing here performs I/O and nothing here reads a model catalog: the three
 * candidates are supplied by the caller, which is the only layer that can look
 * them up. That also keeps this module a pure function, so a store can call it
 * on every usage report without a cache.
 *
 * No input is trusted. Usage frames carry different subsets, a resumed report can
 * arrive with a string where a count belongs, and a caller may hand in `null`:
 * every such field is read as absent rather than coerced, and nothing throws.
 */

import type { ContextView } from "@haruyuki/protocol";

import { asRecord } from "../merge/envelope.js";

/**
 * The server's legacy global window clamp. A model-bearing update that omitted
 * the window historically received exactly this value regardless of the model's
 * real window, which makes it a poison rather than a setting.
 *
 * Decimal 128000, not 131072 and not a shorthand for "128k": the comparison
 * against this literal is an equality, so a single digit off would leave the
 * recognition silently dead while every test still passed.
 */
export const LEGACY_SERVER_CONTEXT_WINDOW_CLAMP = 128000;

/** Where a ceiling came from, using the view's own closed set. */
export type ContextLimitSource = ContextView["source"];

/**
 * The three places a ceiling may come from, highest priority first.
 *
 * Each is `null`/absent when that layer has nothing to say, which is different
 * from a layer that *does* say something and was overruled as a clamp value.
 */
export type ContextLimitCandidates = {
  /** The conversation's own override, when that conversation was given one. */
  readonly conversationOverride?: number | null;
  /** The agent's effective configuration value. */
  readonly agentConfig?: number | null;
  /** The model catalog's window for the model the agent uses. */
  readonly modelCatalog?: number | null;
  /**
   * Whether the model's own catalog presets legitimately contain
   * {@link LEGACY_SERVER_CONTEXT_WINDOW_CLAMP}.
   *
   * False (the default) treats such a value as the server's clamp. A model whose
   * window really is 128k sets this so its own value survives.
   */
  readonly presetMatchesClamp?: boolean;
};

/** The ceiling and where it came from; both are derived together on purpose. */
export type ResolvedContextLimit = {
  /** The ceiling to divide by, or `null` when no layer offered one. */
  readonly limit: number | null;
  /** Which layer answered; `"none"` when none did. */
  readonly source: ContextLimitSource;
};

/** The components of one request, as estimated tokens. `system` includes memory. */
export type ContextParts = {
  readonly system: number;
  readonly tools: number;
  readonly messages: number;
};

/** One layer's name, its field, and the source label it resolves to. */
const LAYERS = [
  { key: "conversationOverride", source: "conversation-override" },
  { key: "agentConfig", source: "agent-config" },
  { key: "modelCatalog", source: "model-catalog" },
] as const;

/**
 * Whether a value is a real window rather than the server's clamp.
 *
 * A finite positive number is a candidate; exactly the clamp value is one only
 * when the model's presets carry it. Anything else is not a ceiling at all.
 *
 * @param value the raw candidate
 * @param presetMatchesClamp whether the model's presets legitimately carry it
 * @returns the ceiling, or `null` when the value is unusable or poisoned
 */
export function usableContextWindow(
  value: unknown,
  presetMatchesClamp: boolean = false,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  if (value === LEGACY_SERVER_CONTEXT_WINDOW_CLAMP && !presetMatchesClamp) {
    return null;
  }
  return value;
}

/**
 * The three-layer fallback.
 *
 * Each layer is tried in order and the first usable value wins. A layer holding
 * the server's clamp value is skipped rather than used, so the search continues
 * downwards; if every layer is empty or poisoned the answer is `null` with
 * source `"none"`.
 *
 * @param candidates the ceilings the caller could find, highest priority first
 * @returns the ceiling and the layer that supplied it
 */
export function resolveContextLimit(
  candidates: ContextLimitCandidates | null | undefined = {},
): ResolvedContextLimit {
  // A caller with a malformed envelope can hand in anything; a primitive simply
  // has no layers, which resolves to "no ceiling" like an empty object does.
  const supplied = asRecord(candidates);
  const matchesPreset = supplied?.["presetMatchesClamp"] === true;

  for (const layer of LAYERS) {
    const window = usableContextWindow(supplied?.[layer.key], matchesPreset);
    if (window !== null) {
      return { limit: window, source: layer.source };
    }
  }

  return { limit: null, source: "none" };
}

/** A finite non-negative count, or `null`; strings and `null` are not counts. */
function readCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The record a usage report lives on.
 *
 * A caller may hand over the snapshot the merger built (already renamed) or the
 * engine's raw delta, which nests the same fields under `delta`. Reading both
 * costs one lookup and means the two callers cannot disagree about where the
 * numbers are.
 */
function usageRecord(usage: unknown): Record<string, unknown> | null {
  const supplied = asRecord(usage);
  return asRecord(supplied?.["delta"]) ?? supplied;
}

/** The provider's measured occupancy, or `null` when it was not reported. */
export function readContextTokens(usage: unknown): number | null {
  const record = usageRecord(usage);
  return readCount(record?.["contextTokens"]) ?? readCount(record?.["context_tokens"]);
}

/**
 * The three estimated components, or `null` when none was reported.
 *
 * A report that names only some of the three zeroes the rest, as the engine does
 * for the same numbers: the three are written together by one producer, so a
 * partial report is a report about that request, not a claim that a component
 * vanished. Negative or non-finite fields are treated as not reported.
 */
export function readContextParts(usage: unknown): ContextParts | null {
  const record = usageRecord(usage);
  if (!record) return null;

  const system =
    readCount(record["contextSystemTokens"]) ?? readCount(record["context_system_tokens"]);
  const messages =
    readCount(record["contextMessagesTokens"]) ?? readCount(record["context_messages_tokens"]);
  const tools =
    readCount(record["contextToolsTokens"]) ?? readCount(record["context_tools_tokens"]);

  if (system === null && messages === null && tools === null) {
    return null;
  }

  return Object.freeze({ system: system ?? 0, tools: tools ?? 0, messages: messages ?? 0 });
}

/** The sum of the three estimates. */
function partsTotal(parts: ContextParts): number {
  return parts.system + parts.messages + parts.tools;
}

/**
 * The denominator a component's share is divided by.
 *
 * The provider's measured occupancy when there is one, the sum of the estimates
 * otherwise -- never the sum while a measured figure exists, because that would
 * make the three shares total one hundred percent by construction. A
 * non-positive or non-finite measurement is not a denominator either; it falls
 * back to the sum instead of dividing by zero.
 *
 * @param parts the three estimates
 * @param tokens the measured occupancy, when the provider reported one
 * @returns the denominator, or `null` when there is nothing to divide
 */
export function contextShareDenominator(
  parts: ContextParts | null | undefined,
  tokens: number | null | undefined,
): number | null {
  const measured = readCount(tokens);
  if (measured !== null && measured > 0) {
    return measured;
  }
  if (!parts) return null;
  const total = partsTotal(parts);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * Build one conversation's context view.
 *
 * The numerator is the provider's figure; with no report it stays `null`, never
 * zero. The denominator is the three-layer fallback. The ratio exists only when
 * both do -- with no ceiling there is nothing to be a percentage *of*, so it is
 * `null` rather than zero. It is a percentage (0-100), not a fraction, and it is
 * not clamped: an occupancy above the ceiling is a real state worth seeing.
 *
 * The view is frozen: it is published through the snapshot and several readers
 * share it, so a second copy with a different rule cannot appear.
 *
 * @param usage one usage report, as a snapshot or as the engine's raw delta
 * @param candidates the ceilings the caller could find
 * @returns the derived view
 */
export function deriveContextView(
  usage: unknown,
  candidates: ContextLimitCandidates | null | undefined = {},
): ContextView {
  const tokens = readContextTokens(usage);
  const parts = readContextParts(usage);
  const { limit, source } = resolveContextLimit(candidates);
  const percentage = tokens !== null && limit !== null ? (tokens / limit) * 100 : null;

  return Object.freeze({
    tokens,
    limit,
    source,
    // Zero to one hundred, and deliberately not clamped: the engine caps its own
    // figure at 100 for the percentage badge it draws, but this is data, and an
    // occupancy above the ceiling is a real state worth showing.
    percentage,
    parts,
    // True when this view carries the three estimates -- they are always
    // estimates (a four-bytes-per-token heuristic), so carrying them is what
    // makes the view estimated, even when the occupancy itself was measured.
    estimated: parts !== null,
  });
}
