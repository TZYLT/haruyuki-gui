/**
 * Envelope passthrough: turn one inbound frame into the four fields a consumer
 * may read, and never invent one.
 *
 * The whole contract is one sentence: **the four fields pass through verbatim,
 * and a missing field is absent rather than `undefined`**. Why that is worth a
 * module:
 *
 * - **The engine does not always send them.** 265 of the 295 recorded s2c frames
 *   carry all four; 30 do not (19 carry none, 11 carry only `runtime`). A reader
 *   that assumes `envelope.runtime.agent_id` exists throws on roughly one frame in
 *   ten, and the frames it throws on are exactly the ones a new engine version
 *   introduced.
 * - **Absent is a fact, not a default.** `{ envelope: {} }` and "no `envelope`"
 *   are different answers to "did the engine tag this frame?", and a consumer
 *   deciding whether to take its ordering from `event_seq` needs the difference.
 *   So a frame with none of the four produces no `envelope` key at all.
 * - **Nothing here interprets.** No field is validated, no `event_seq` compared, no
 *   `emitted_at` parsed into a number, no `idempotency_key` deduplicated. Converting
 *   a timestamp would invent a timezone rule the engine never stated, and treating
 *   `event_seq` as our ordering authority would be wrong (ordering belongs to
 *   the event merger, which is the only layer that sees the full sequence).
 *
 * The one thing this module does know is *which* four fields exist, and it takes
 * that from the frozen type rather than restating it: the key list is declared
 * `satisfies readonly (keyof EngineEventEnvelope)[]`, so renaming a field in
 * `types.ts` is a compile error here instead of a field silently leaving the
 * passthrough.
 */

import type { EngineEventEnvelope } from "./types";

/**
 * The four envelope fields, named once.
 *
 * `satisfies` rather than a bare array so the list cannot drift from
 * {@link EngineEventEnvelope}: adding a field to the type without adding it here
 * is a compile error, which is the only mechanical way to keep a passthrough
 * complete.
 */
export const ENVELOPE_KEYS = [
  "runtime",
  "event_seq",
  "emitted_at",
  "idempotency_key",
] as const satisfies readonly (keyof EngineEventEnvelope)[];

/**
 * Read the four envelope fields off one frame, verbatim.
 *
 * Absent fields are omitted entirely rather than set to `undefined`, so a consumer
 * that branches on presence sees the engine's own shape. A frame carrying none of
 * the four yields `undefined`, which the caller turns into "no `envelope` key" -
 * not an empty object, because those are different facts (see the module header).
 *
 * @param raw the untouched frame
 * @returns the envelope, or `undefined` when the frame carried none of the four
 */
export function envelopeOf(raw: unknown): EngineEventEnvelope | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }

  const source = raw as Record<string, unknown>;
  let envelope: EngineEventEnvelope | undefined;

  for (const key of ENVELOPE_KEYS) {
    const value = source[key];

    if (value === undefined) {
      continue;
    }

    envelope ??= {};
    // Assigned through a mutable view of the readonly type: the values are
    // engine output we have not validated, and they are stored exactly as
    // received. `exactOptionalPropertyTypes` is why this cannot be written as
    // `envelope[key] = value ?? undefined`.
    (envelope as Record<string, unknown>)[key] = value;
  }

  return envelope;
}
