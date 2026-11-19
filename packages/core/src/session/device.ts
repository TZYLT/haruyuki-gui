/**
 * One device frame, projected onto the eight facts a page may draw.
 *
 * The engine's device payload is a settings page wearing a state frame's name:
 * `available_toolsets`, `experiments`, `supported_commands`, `reflection_settings`
 * and friends, thirteen kilobytes of it, none of which a session view needs. A
 * frame that size does not fit one frame of the renderer's channel, so the
 * payload is never forwarded whole. Eight fields survive the projection, and they
 * are the contract's eight, not a convenient subset: renaming one here would
 * break every consumer that reads the contract rather than this file.
 *
 * Two rules decide what happens to a payload that is not what the engine promised:
 *
 * 1. **Nothing is invented.** A nullable field the payload does not name stays
 *    `null`; a count that is not reported is never `0`. On a device panel, `0`
 *    background processes and "the engine did not say" are different facts, and
 *    only one of them is a reason to draw an empty list.
 * 2. **A row that cannot answer is a row, not an exception.** Four of the eight
 *    fields are non-nullable in the contract (the two flags and the two counts),
 *    so there is nothing honest to put there when the payload omits or mistypes
 *    them: the whole row becomes unreadable and says why in a machine code. It
 *    never throws, and one bad payload never clears the last good one.
 *
 * The byte ceiling is enforced here too, because the caller's next step is a
 * frame. Nothing is truncated to make a row fit: an over-long value is dropped
 * like any other unreadable one, and a row that still cannot fit - an identity
 * from a malformed envelope will do it - is refused as oversized rather than
 * handed to a channel that would cut it. A silently halved identity is worse
 * than a visible code.
 */

import type { DeviceEntity } from "@haruyuki/protocol";

import { asRecord } from "../merge/envelope.js";
import type { MergerChange } from "../merge/types.js";

/** Most bytes the projected entity may take; the frame budget it has to fit. */
export const DEVICE_VIEW_BYTES = 512;

/** Longest string field kept. A longer one is dropped, not truncated. */
const FIELD_CHAR_LIMIT = 200;

/**
 * Why a payload produced no entity.
 *
 * - `not-a-device-change` - the caller handed in another kind; a misuse, not
 *   malformed data.
 * - `no-agent` - no usable agent identity, so there is no key to file the row
 *   under.
 * - `no-payload` - the change's value is not an object at all.
 * - `missing-fields` - a field the contract cannot express as `null` was absent.
 * - `wrong-type` - such a field was present with the wrong type.
 * - `oversized` - the row would not fit {@link DEVICE_VIEW_BYTES}.
 * - `unreadable` - reading the payload itself failed; a hostile object can throw
 *   from a property access and that must not escape a read path.
 */
export type DeviceProblem =
  | "not-a-device-change"
  | "no-agent"
  | "no-payload"
  | "missing-fields"
  | "wrong-type"
  | "oversized"
  | "unreadable";

/** One payload's outcome: an entity, or the code that explains its absence. */
export type DeviceReading = {
  readonly entity: DeviceEntity | null;
  readonly problem: DeviceProblem | null;
};

/** A value read off the payload, with the reason when it is not usable. */
type Read<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "absent" | "type" };

/**
 * Read the engine state out of a change's value.
 *
 * The change's `value` is the engine's frame as the merger received it. In the
 * recorded corpus that is the whole message, with the state nested under its own
 * key; a caller that already unwrapped it passes the state itself and works the
 * same. Reading one level of nesting is the difference between the two shapes,
 * so it is done here rather than demanded of every caller.
 *
 * @param raw the change's value
 * @returns the state record, or `null` when there is none
 */
function payloadOf(raw: unknown): Record<string, unknown> | null {
  const value = asRecord(raw);

  if (value === null) {
    return null;
  }

  return asRecord(value["device_status"]) ?? value;
}

/**
 * The agent this payload belongs to.
 *
 * The envelope's author is preferred because it is the identity the merge layer
 * already resolved; the connection's agent is the fallback. An empty string is
 * the merger's spelling of "the envelope named no connection", so it is treated
 * as absent rather than as an id.
 *
 * @param change the change being projected
 * @returns the id, or `null` when neither field names one
 */
function agentIdOf(change: MergerChange): string | null {
  if (change.authorAgentId !== null && change.authorAgentId !== "") {
    return change.authorAgentId;
  }

  return change.runtimeAgentId === "" ? null : change.runtimeAgentId;
}

/** A required boolean. */
function readFlag(record: Record<string, unknown>, key: string): Read<boolean> {
  const value = record[key];

  if (value === undefined) {
    return { ok: false, reason: "absent" };
  }

  return typeof value === "boolean" ? { ok: true, value } : { ok: false, reason: "type" };
}

/** A required array, reported as its length. */
function readCount(record: Record<string, unknown>, key: string): Read<number> {
  const value = record[key];

  if (value === undefined) {
    return { ok: false, reason: "absent" };
  }

  return Array.isArray(value) ? { ok: true, value: value.length } : { ok: false, reason: "type" };
}

/**
 * An optional string field.
 *
 * Empty, non-string and over-long values all become `null`: the shape has one
 * slot for "no value", and a half-shown path or a truncated toolset id would
 * read as a real value to the page.
 *
 * @param record the payload
 * @param key the engine's field name
 * @returns the value, or `null`
 */
function readText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  if (typeof value !== "string" || value === "" || value.length > FIELD_CHAR_LIMIT) {
    return null;
  }

  return value;
}

/** Which problem a refused required field deserves. */
function problemOf(reason: "absent" | "type"): DeviceProblem {
  return reason === "absent" ? "missing-fields" : "wrong-type";
}

/**
 * Compose the entity and check it against the byte ceiling.
 *
 * @param agentId the row's key
 * @param payload the device state
 * @param loop the agent's loop state, supplied by the caller (see {@link projectDevice})
 * @returns the entity, or the code for a row that would not fit
 */
function compose(
  agentId: string,
  payload: Record<string, unknown>,
  loop: string | null,
): DeviceReading {
  const online = readFlag(payload, "is_online");
  if (!online.ok) {
    return { entity: null, problem: problemOf(online.reason) };
  }

  const processing = readFlag(payload, "is_processing");
  if (!processing.ok) {
    return { entity: null, problem: problemOf(processing.reason) };
  }

  const approvals = readCount(payload, "pending_control_requests");
  if (!approvals.ok) {
    return { entity: null, problem: problemOf(approvals.reason) };
  }

  const processes = readCount(payload, "background_processes");
  if (!processes.ok) {
    return { entity: null, problem: problemOf(processes.reason) };
  }

  // The loop state is not in this payload: it travels as its own change kind,
  // so it cannot be read here without this module folding two kinds together.
  // It arrives as an argument instead, and an absent one stays `null` - "the
  // caller has not seen a loop frame" is a fact, not an empty state.
  const entity: DeviceEntity = {
    agentId,
    view: {
      isOnline: online.value,
      isProcessing: processing.value,
      permissionMode: readText(payload, "current_permission_mode"),
      cwd: readText(payload, "current_working_directory"),
      toolsetPreference: readText(payload, "current_toolset_preference"),
      pendingApprovals: approvals.value,
      backgroundProcesses: processes.value,
      loop,
    },
  };

  if (JSON.stringify(entity).length > DEVICE_VIEW_BYTES) {
    return { entity: null, problem: "oversized" };
  }

  return { entity, problem: null };
}

/**
 * Normalize a loop state handed in by the display assembly.
 *
 * The merge layer keeps every loop state verbatim and never collapses them, so
 * this only rejects what is not a state at all: empty strings and non-strings
 * become `null` rather than being shown as a value.
 *
 * @param loop whatever the caller observed
 * @returns the state, or `null` when the caller has none
 */
export function readLoop(loop: unknown): string | null {
  return typeof loop === "string" && loop !== "" ? loop : null;
}

/**
 * Project one change onto a device entity.
 *
 * Total: every input answers, nothing throws, and a non-device change is refused
 * by code rather than by exception.
 *
 * The device payload carries no removal delta, unlike the queue payload: it is a
 * whole snapshot of what is true now, and the contract's entity has no slot for
 * departed entries. Nothing is left stranded by not applying one, so none is
 * looked for.
 *
 * @param change the change to project
 * @param loop the agent's loop state if the caller has one; `null` when not
 * @returns the entity, or the code explaining why there is none
 */
export function projectDevice(change: MergerChange, loop: string | null = null): DeviceReading {
  if (change.kind !== "state.device") {
    return { entity: null, problem: "not-a-device-change" };
  }

  try {
    const agentId = agentIdOf(change);

    if (agentId === null) {
      return { entity: null, problem: "no-agent" };
    }

    const payload = payloadOf(change.value);

    if (payload === null) {
      return { entity: null, problem: "no-payload" };
    }

    return compose(agentId, payload, loop);
  } catch {
    // A payload can be a proxy, a throwing getter or a revoked object. The
    // caller is a socket callback: costing one row is the acceptable failure,
    // and the next frame still flows.
    return { entity: null, problem: "unreadable" };
  }
}

/**
 * What the projector has seen so far.
 *
 * Every applied change counts exactly once, and the refusal reasons stay apart
 * because a page maps each one to its own readable code: "the engine sent no
 * such field" and "the engine sent it as the wrong type" are different repairs,
 * and rolling them into one `unreadable` count would make the diagnostic say
 * less than the reading already knows.
 */
export type DeviceProjectionStats = {
  /** Rows that produced an entity. */
  readonly readable: number;
  /** Rows refused because a required field was absent. */
  readonly missingFields: number;
  /** Rows refused because a required field had the wrong type. */
  readonly wrongType: number;
  /** Rows refused because they would not fit one frame. */
  readonly oversized: number;
  /** Rows refused for every other reason: no payload, no identity, unreadable. */
  readonly unreadable: number;
};

/** Folds a stream of changes into the latest device row, plus counts. */
export interface DeviceProjector {
  /** The most recent readable entity, or `null` before any; a bad row never clears it. */
  readonly latest: DeviceEntity | null;
  readonly stats: DeviceProjectionStats;
  /**
   * Record the agent's loop state.
   *
   * The loop state is observed on its own change kind, by the assembly layer
   * that sees both. Feeding it here keeps this module a single-kind projection:
   * it never reaches into another change to complete this one.
   *
   * @param loop the latest loop state; `null` when the caller has none
   */
  setLoop(loop: string | null): void;
  /**
   * Project one change and record its outcome.
   *
   * @param change the change to project
   * @returns the same reading {@link projectDevice} would give
   */
  apply(change: MergerChange): DeviceReading;
}

/**
 * Build a projector.
 *
 * The state is the latest row only. A device frame is a full snapshot of what is
 * true now, so folding older frames on top of it would resurrect values the
 * engine has already replaced; that is also why feeding every frame and feeding
 * only the last one land on the same row.
 *
 * The loop state is remembered across frames and applied to each row, so a row
 * projected after `setLoop` carries it whether or not the device frame itself
 * mentioned it. Calling `setLoop` again does not rewrite the row already handed
 * out; it applies to the next `apply`, which is what keeps the published value
 * as immutable as the contract says.
 *
 * @returns a projector over consecutive device changes
 */
export function createDeviceProjector(): DeviceProjector {
  let latest: DeviceEntity | null = null;
  let loop: string | null = null;
  let readable = 0;
  let missingFields = 0;
  let wrongType = 0;
  let oversized = 0;
  let unreadable = 0;

  return {
    get latest(): DeviceEntity | null {
      return latest;
    },
    get stats(): DeviceProjectionStats {
      return { readable, missingFields, wrongType, oversized, unreadable };
    },
    setLoop(next: string | null): void {
      loop = readLoop(next);
    },
    apply(change: MergerChange): DeviceReading {
      const reading = projectDevice(change, loop);

      if (reading.entity !== null) {
        latest = reading.entity;
        readable += 1;

        return reading;
      }

      switch (reading.problem) {
        case "missing-fields":
          missingFields += 1;
          break;
        case "wrong-type":
          wrongType += 1;
          break;
        case "oversized":
          oversized += 1;
          break;
        default:
          unreadable += 1;
          break;
      }

      return reading;
    },
  };
}
