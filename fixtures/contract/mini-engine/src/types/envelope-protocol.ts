/**
 * Two-level `extends` chain for the mini engine fixture.
 *
 * Kept out of both protocol unions on purpose: it exercises heritage merging in
 * the type index without moving the fixture's command / message counts that the
 * contract gate asserts.
 *
 * `EnvelopeLeafMessage` inherits `request_id`, `event_seq` and `emitted_at`
 * through `EnvelopeMiddle`, and `EnvelopeMiddle` overrides `emitted_at` (the
 * member becomes optional). Adding a field to `EnvelopeBase` must therefore
 * change both the leaf field list and the leaf `shapeFingerprint`, which is what
 * the scan tests prove on a temp copy.
 */

export interface EnvelopeBase {
  request_id: string;
  event_seq: number;
  emitted_at: string;
}

export interface EnvelopeMiddle extends EnvelopeBase {
  /** Redeclared on purpose: the child wins over the base member. */
  emitted_at?: string;
  parent_message_id?: string;
}

export interface EnvelopeLeafMessage extends EnvelopeMiddle {
  type: "envelope_leaf";
  payload: string;
}
