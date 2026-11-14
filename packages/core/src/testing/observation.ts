/**
 * observation.ts - post a frame stream through one transport double and record
 * what arrived.
 *
 * Scope sources: docs/18-A3 section 3.4.4 (the frozen `Observation` and
 * `TransportDouble` shapes), section 5.1 rule 4 ("a double moves frames; the
 * harness records them") and section 7 `R-06` (the two doubles use different
 * async granularity) plus section 8 (`INV-A3-4`, `INV-A3-8`). Frame rules:
 * docs/01-3 section 3.3. Requirement side: docs/17-A3 sections 4.3 and 5.1
 * .
 *
 * The frozen `Observation.rejected` entry is `{ raw, reason: "not-json" }`.
 * That shape can describe raw text that failed to parse, but it cannot honestly
 * describe a *structural* rejection such as a malformed envelope or a lossy
 * JSON round trip. The transport doubles already report those through their
 * `onReject` option (see `transport/delivery.ts`), so this module keeps the
 * frozen `rejected` list for text that really is not JSON and adds one optional
 * field, `transportRejections`, for everything the double refused. The addition
 * is reported for the route doc; it is not a widening of the frozen list.
 *
 * A rejected frame is never dropped silently. A double built by
 * {@link createObservedDouble} reports every rejection; a double built
 * elsewhere gets a fallback entry when fewer frames arrive than were posted,
 * with a reason that says the sink was missing instead of inventing a cause.
 */

import type { BridgeFrame, Clock, FrameChannel } from "./fixture";
import { reduce } from "./reducer";
import type {
  TransportDouble,
  TransportDoubleOptions,
  TransportRejection,
} from "./transport/delivery";
import { createIpcDouble } from "./transport/ipc";
import { createPostMessageDouble } from "./transport/postmessage";

/** One refusal in the frozen `Observation.rejected` shape. */
export type ObservationRejection = {
  raw: string;
  reason: "not-json";
};

/**
 * The frozen observation shape the harness compares.
 *
 * `transportRejections` is the additive field described in the file comment;
 * it is omitted (not empty) when the double rejected nothing, so an observation
 * from a well-behaved run is byte-identical to the frozen shape.
 */
export type Observation = {
  scenario: string;
  /** Frames in arrival order, after the double's JSON round trip. */
  frames: BridgeFrame[];
  /** The same frames grouped per channel, each in arrival order. */
  byChannel: Record<FrameChannel, BridgeFrame[]>;
  /** Text the double refused because it is not JSON at all. */
  rejected: ObservationRejection[];
  /** {@link reduce} over `frames`; the only self-proof object here. */
  state: unknown;
  /** Every refusal the double reported, structural ones included. */
  transportRejections?: TransportRejection[];
};

/**
 * Additive options of {@link observeThrough}.
 *
 * The frozen `Observation` carries a `scenario` name, but the frozen
 * `observeThrough` signature has no argument that supplies it. The optional
 * fourth argument fills that gap; the three-argument frozen call still works
 * and leaves the scenario empty.
 */
export type ObserveOptions = {
  scenario?: string;
};

/**
 * A transport double that exposes the rejections it reported.
 *
 * A double is not a frozen seam: the frozen `TransportDouble` has no failure
 * channel, so the sink lives beside the double, not inside it.
 */
export interface RecordingTransportDouble extends TransportDouble {
  /** Rejections in post order; the array is live and append-only. */
  readonly transportRejections: TransportRejection[];
}

/**
 * Build one double whose rejections are recorded for {@link observeThrough}.
 *
 * @param name Which platform shape to model.
 * @param options Forwarded to the double; an `onReject` here is still called,
 * after the rejection has been recorded.
 */
export function createObservedDouble(
  name: TransportDouble["name"],
  options: TransportDoubleOptions = {},
): RecordingTransportDouble {
  const transportRejections: TransportRejection[] = [];
  const onReject = (rejection: TransportRejection): void => {
    transportRejections.push(rejection);
    options.onReject?.(rejection);
  };
  const double =
    name === "ipc" ? createIpcDouble({ onReject }) : createPostMessageDouble({ onReject });

  return {
    name,
    post: double.post,
    onFrame: double.onFrame,
    close: double.close,
    transportRejections,
  };
}

/**
 * Post every frame through a double, collect the arrivals, and fold them.
 *
 * The double is used, not owned: this function subscribes, posts, waits for the
 * delivery queues to drain, unsubscribes and returns. It never calls `close`.
 *
 * Arrival order is what the double chose. The observation records it as it is
 * (INV-A3-8 does not promise cross-channel order); comparison is the layer that
 * avoids asserting an order the bridge never promises.
 *
 * @param double Transport double, ideally from {@link createObservedDouble}.
 * @param frames Frames to post, in source order.
 * @param clock Injected clock; given one virtual turn to model pacing.
 * @param options Optional scenario name; see {@link ObserveOptions}.
 */
export async function observeThrough(
  double: TransportDouble,
  frames: readonly BridgeFrame[],
  clock: Clock,
  options: ObserveOptions = {},
): Promise<Observation> {
  const received: BridgeFrame[] = [];
  const transportRejections: TransportRejection[] = [];
  const rejected: ObservationRejection[] = [];
  const sink = rejectionLogOf(double);

  /**
   * Record one rejection, and classify only a *text* source as `rejected`.
   *
   * The frozen entry is `{ raw, reason: "not-json" }`: it describes a text frame
   * that could not be parsed. An object frame rejected for its structure has no
   * text at all - its `raw` is a stand-in such as `"[object Object]"` - and
   * putting that in `rejected` invented a payload no shell ever sent and made two
   * different frames indistinguishable. Such a rejection lives only in
   * `transportRejections`, which carries the real reason; `rejected` stays empty
   * for a transport that only ever hands over objects, and fills up for a textual
   * one (the raw-wire observation).
   */
  const record = (rejection: TransportRejection, source: unknown): void => {
    transportRejections.push(rejection);

    if (typeof source === "string" && !isJsonText(source)) {
      rejected.push({ raw: source, reason: "not-json" });
    }
  };

  const unsubscribe = double.onFrame((frame) => {
    received.push(frame);
  });

  try {
    for (const frame of frames) {
      const seen = sink === undefined ? 0 : sink.length;

      try {
        double.post(frame);
      } catch (error) {
        record({ raw: rawOf(frame), reason: `post threw: ${detailOf(error)}` }, frame);
      }

      if (sink !== undefined) {
        for (const rejection of sink.slice(seen)) {
          record(rejection, frame);
        }
      }
    }

    // The injected clock gets its turn first, so a caller can model pacing.
    // Then two real event-loop turns: the doubles deliver on a microtask
    // (`ipc`) or a zero-delay timer (`postmessage`), and the
    // clock is not required to provide either granularity.
    await clock.sleep(0);
    await nextTurn();
    await nextTurn();
  } finally {
    unsubscribe();
  }

  // Anything posted that neither arrived nor was reported would be a silent
  // drop. Count what should have arrived from what the double rejected; if the
  // double exposed no sink, the reason says so rather than guessing a cause.
  const expectedArrivals = frames.length - transportRejections.length;
  const missing = expectedArrivals - received.length;

  if (missing > 0) {
    transportRejections.push({
      raw: "",
      reason:
        `${missing} frame(s) were posted but neither delivered nor reported; ` +
        "the double exposed no rejection sink for them",
    });
  }

  const byChannel: Record<FrameChannel, BridgeFrame[]> = {
    control: [],
    stream: [],
    bulk: [],
  };

  for (const frame of received) {
    byChannel[frame.ch].push(frame);
  }

  const observation: Observation = {
    scenario: options.scenario ?? "",
    frames: received,
    byChannel,
    rejected,
    state: reduce(received),
  };

  if (transportRejections.length > 0) {
    observation.transportRejections = transportRejections;
  }

  return observation;
}

/** Read the live rejection log from a double built by {@link createObservedDouble}. */
function rejectionLogOf(double: TransportDouble): TransportRejection[] | undefined {
  const candidate = double as { transportRejections?: unknown };

  return Array.isArray(candidate.transportRejections)
    ? (candidate.transportRejections as TransportRejection[])
    : undefined;
}

/** True when `raw` can be parsed as JSON text. */
function isJsonText(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort text form of a value handed to `post`.
 *
 * Matches the rule the doubles use for their rejection `raw`: JSON text when
 * the value serialises, a fallback marker otherwise. Kept here because a
 * double's private helper is not importable, and a rejection must never be lost
 * for want of a label.
 */
function rawOf(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Readable message for a thrown value of unknown shape. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wait one real macrotask turn, the coarsest granularity a double uses. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
