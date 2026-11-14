/**
 * delivery.ts - the async delivery and rejection rules shared by both transport
 * doubles.
 *
 * Scope sources: docs/18-A3 section 1.2 `R-06` (a harness that only ever sees
 * one ordering cannot tell a real cross-channel race from an artefact, so the
 * two doubles must use different async granularity), section 3.4.4 (the frozen
 * `TransportDouble` shape), section 5.1 rule 4 ("a double moves and copies
 * frames; it never interprets them") and section 8 (`INV-A3-4`: JSON round trip
 * before delivery, malformed frames rejected at post time; `INV-A3-8`: within a
 * channel order is kept, across channels it is not guaranteed; a double must
 * not "helpfully" sort). Requirement side: docs/17-A3 section 4.3 and pick-path.
 *
 * The frozen interface has no failure channel, so rejection is reported through
 * an option rather than through a new member: `post` stays `void`, the
 * `TransportDouble` shape stays exactly the four frozen members, and the
 * factory accepts an `onReject` callback. `reason` is diagnostic prose, not an
 * enum: the frozen `Observation.rejected.reason` union is not widened here
 * .
 *
 * The frame type is `BridgeFrame`, the corpus envelope already defined in
 * `../fixture`, rather than a second `Frame` declaration. The frozen docs name
 * the type `Frame`; the repo has exactly one definition and reusing it keeps
 * the doubles and the fixture loader from drifting apart.
 */

import type { BridgeFrame, FrameChannel } from "../fixture";

/** Channels a bridge frame may use. */
const FRAME_CHANNELS = ["control", "stream", "bulk"] as const;

/**
 * One frame that was rejected at post time.
 *
 * `raw` is a best-effort text form of the value handed to `post`: JSON text when
 * the value can be serialised, otherwise a fallback marker. `reason` is prose so
 * nothing in this module invents a frozen rejection code.
 */
export type TransportRejection = {
  raw: string;
  reason: string;
};

/**
 * Options both transport doubles accept.
 *
 * `onReject` is called synchronously inside `post`, exactly once per rejected
 * frame. A frame reported here is never delivered and never retried.
 */
export type TransportDoubleOptions = {
  onReject?: (rejection: TransportRejection) => void;
};

/**
 * The frozen shape every double implements.
 *
 * Kept here, next to the rules every implementation shares, so neither double
 * can add a member to its own copy of the contract.
 */
export interface TransportDouble {
  readonly name: "ipc" | "postmessage";
  post(frame: BridgeFrame): void;
  onFrame(cb: (frame: BridgeFrame) => void): () => void;
  close(): void;
}

/** How a double schedules one drain: `queueMicrotask` or `setTimeout(0)`. */
export type DeliveryScheduler = (task: () => void) => void;

/** Configuration of {@link createDelivery}. */
export type DeliveryConfig = {
  name: TransportDouble["name"];
  schedule: DeliveryScheduler;
  options: TransportDoubleOptions;
};

/**
 * The delivery machinery plus the rejection entry point.
 *
 * `reject` exists for platform-shaped helpers (an IPC channel check) that can
 * refuse a call before it becomes a frame; it follows the same reporting rule.
 */
export type Delivery = {
  readonly double: TransportDouble;
  reject(value: unknown, reason: string): void;
};

/** Result of copying one frame through JSON. */
type FrameCopy = { ok: true; frame: BridgeFrame } | { ok: false; reason: string };

/** Result of turning a value into JSON text. */
type Serialised = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Build one transport double around a scheduler.
 *
 * A single FIFO queue is used per double: frames are delivered in the order
 * `post` was called, which is at least as strong as the per-channel ordering
 * `INV-A3-8` requires. The cross-channel freedom comes from the scheduler
 * granularity each double chooses, not from reordering frames here: a frame's
 * `seq` and `t` are never read for anything but shape validation.
 */
export function createDelivery(config: DeliveryConfig): Delivery {
  const listeners = new Set<(frame: BridgeFrame) => void>();
  const queue: BridgeFrame[] = [];
  const report = config.options.onReject;
  let closed = false;
  let scheduled = false;

  function reject(value: unknown, reason: string): void {
    report?.({ raw: rawOf(value), reason });
  }

  function drain(): void {
    scheduled = false;

    if (closed) {
      return;
    }

    const pending = queue.splice(0);

    for (const frame of pending) {
      // A listener may close the double mid-drain; the rest is then dropped,
      // which is what "close stops delivery" means.
      if (closed) {
        return;
      }

      for (const listener of listeners) {
        listener(frame);
      }
    }
  }

  const double: TransportDouble = {
    name: config.name,

    post(frame) {
      if (closed) {
        reject(frame, "transport is closed");
        return;
      }

      const copy = copyFrame(frame);

      if (!copy.ok) {
        reject(frame, copy.reason);
        return;
      }

      queue.push(copy.frame);

      if (!scheduled) {
        scheduled = true;
        config.schedule(drain);
      }
    },

    onFrame(callback) {
      if (closed) {
        return () => {};
      }

      listeners.add(callback);

      return () => {
        listeners.delete(callback);
      };
    },

    close() {
      if (closed) {
        return;
      }

      closed = true;
      queue.length = 0;
      listeners.clear();
    },
  };

  return { double, reject };
}

/**
 * Validate and copy one frame exactly once, at post time.
 *
 * The order is deliberate: serialise first (so a cycle or a BigInt reports as
 * "not JSON-serialisable"), then prove the round trip is faithful, then check
 * the envelope. That way a `NaN` in `seq` is reported as a lossy round trip,
 * while a `seq` of `0` - which survives JSON untouched - is reported as a
 * malformed frame.
 */
function copyFrame(frame: BridgeFrame): FrameCopy {
  const serialised = serialise(frame);

  if (!serialised.ok) {
    return serialised;
  }

  let copy: unknown;

  try {
    copy = JSON.parse(serialised.text);
  } catch (error) {
    return { ok: false, reason: `not JSON-serialisable: ${detailOf(error)}` };
  }

  if (!isFaithfulCopy(frame, copy)) {
    return {
      ok: false,
      reason:
        "not JSON-serialisable: the JSON round trip would change the frame " +
        "(undefined, NaN, Infinity, functions, symbols, Date/Map/Set and cycles " +
        "are outside the JSON subset)",
    };
  }

  const problem = frameProblem(copy);

  if (problem !== null) {
    return { ok: false, reason: `malformed frame: ${problem}` };
  }

  return { ok: true, frame: copy as BridgeFrame };
}

/** Serialise a value, turning every failure into a rejection reason. */
function serialise(value: unknown): Serialised {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch (error) {
    return { ok: false, reason: `not JSON-serialisable: ${detailOf(error)}` };
  }

  if (text === undefined) {
    return { ok: false, reason: "not JSON-serialisable: the value produced no JSON text" };
  }

  return { ok: true, text };
}

/**
 * Check that `copy` carries exactly the data `original` had.
 *
 * `JSON.parse(JSON.stringify(x))` is the round trip the contract asks for, but
 * it is lossy: it drops `undefined` fields, turns `NaN` into `null`, calls
 * `toJSON` on a `Date` and flattens a `Map` to `{}`. Comparing the two values
 * makes those losses observable instead of silently changing a frame. Cycles
 * never reach this function because `JSON.stringify` throws first.
 */
function isFaithfulCopy(original: unknown, copy: unknown): boolean {
  if (original === null || copy === null) {
    return original === copy;
  }

  if (typeof original !== typeof copy) {
    return false;
  }

  if (typeof original === "number" || typeof original === "string") {
    return original === copy;
  }

  if (typeof original === "boolean") {
    return original === copy;
  }

  if (typeof original !== "object") {
    // Function, symbol, bigint and undefined never survive the round trip.
    return false;
  }

  if (Array.isArray(original) || Array.isArray(copy)) {
    if (!Array.isArray(original) || !Array.isArray(copy)) {
      return false;
    }

    if (original.length !== copy.length) {
      return false;
    }

    return original.every((entry, index) => isFaithfulCopy(entry, copy[index]));
  }

  if (!isRecord(original) || !isRecord(copy)) {
    return false;
  }

  // A class instance, Date, Map or Set reaches JSON as a plain object or a
  // string. Only a plain object (or a null-prototype record) is an honest copy.
  const prototype = Object.getPrototypeOf(original);

  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  // Symbol-keyed properties are invisible to JSON.
  if (Object.getOwnPropertySymbols(original).length > 0) {
    return false;
  }

  const originalKeys = Object.keys(original).sort();
  const copyKeys = Object.keys(copy).sort();

  if (originalKeys.length !== copyKeys.length) {
    return false;
  }

  for (let index = 0; index < originalKeys.length; index += 1) {
    const key = originalKeys[index];

    if (key === undefined || key !== copyKeys[index]) {
      return false;
    }

    if (!isFaithfulCopy(Reflect.get(original, key), Reflect.get(copy, key))) {
      return false;
    }
  }

  return true;
}

/**
 * Validate the frame envelope declared in `../fixture`.
 *
 * Returns the first structural problem, or `null` when the frame is valid.
 * `t` is only checked for being a non-empty string: its vocabulary belongs to
 * C5, and a transport double must not interpret it , so the corpus-A3 section 5.1
 * rule 4).
 */
function frameProblem(value: unknown): string | null {
  if (!isRecord(value)) {
    return `frame must be a JSON object, found ${describe(value)}`;
  }

  if (value.v !== 1) {
    return `frame "v" must be 1, found ${preview(value.v)}`;
  }

  if (!isFrameChannel(value.ch)) {
    return `frame "ch" must be one of ${FRAME_CHANNELS.join(", ")}, found ${preview(value.ch)}`;
  }

  const seq = value.seq;

  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    return `frame "seq" must be a positive integer, found ${preview(seq)}`;
  }

  const t = value.t;

  if (typeof t !== "string" || t.length === 0) {
    return `frame "t" must be a non-empty string, found ${preview(t)}`;
  }

  if (!isRecord(value.body)) {
    return `frame "body" must be a JSON object, found ${describe(value.body)}`;
  }

  const page = value.page;

  if (page !== undefined && !isPage(page)) {
    return `frame "page" must be an object with a boolean "more", found ${preview(page)}`;
  }

  return null;
}

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `value` is one of the three bridge channel names. */
function isFrameChannel(value: unknown): value is FrameChannel {
  return typeof value === "string" && (FRAME_CHANNELS as readonly string[]).includes(value);
}

/** True for the optional `page` envelope field. */
function isPage(value: unknown): value is { more: boolean } {
  return isRecord(value) && typeof value.more === "boolean";
}

/** Best-effort text form of a value that may never become JSON. */
function rawOf(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Name a decoded value's shape for a rejection message. */
function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return "an array";
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

/** Compact display of a value that already came out of JSON. */
function preview(value: unknown): string {
  const text = JSON.stringify(value);
  return text ?? String(value);
}

/** Readable message for a thrown value of unknown shape. */
function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
