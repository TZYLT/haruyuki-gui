/**
 * compare.ts - compare two observations over the things the bridge promises.
 *
 * Scope: the `ComparisonReport` and `createComparisonHarness` shapes below. The
 * promise being compared is that within a channel order is kept and across
 * channels it is not guaranteed, so only the per-channel projection can be
 * compared element for element.
 *
 * What is compared:
 *
 * - `byChannel.<channel>` arrays, element for element. That is the same-channel
 *   arrival order, which the bridge does promise, plus each frame's content.
 * - the reducer output: its `control`/`stream`/`bulk` logs and its folded
 *   `state` map.
 * - `rejected`, the frozen non-JSON list, and `transportRejections`, the
 *   additive structural list.
 *
 * What is deliberately not compared:
 *
 * - The top-level `frames` list index by index. It is arrival order across all
 *   three channels, and comparing it would assert an order the bridge does not
 *   guarantee. Its per-channel projection carries the same information and is
 *   compared instead. This is also why no `frames[i]` path is produced: a diff
 *   there would be a cross-channel ordering accusation.
 * - `scenario`. Two observations of the same scenario may be labelled
 *   differently by their caller, and the name is metadata, not bridge output.
 *
 * Diff grammar: every diff is one line, `<path>: <left> !== <right>`. A path is
 * rooted at an observation field: `byChannel.<channel>[<index>]` and
 * `rejected[<index>]`, `transportRejections[<index>]`; the reducer output is
 * presented as its four sections, so `control[<index>]`, `stream[<index>]`,
 * `bulk[<index>]` and `state` (the folded map, e.g. `state.queue.pending`) are
 * roots too. Object keys use `.name` when they are identifier-shaped and
 * `["odd key"]` otherwise; arrays use `[<index>]`. Values are compact JSON
 * previews, capped at 120 characters. Diffs are sorted and unique, so `equal`
 * is exactly `diffs.length === 0`.
 */

import type { BridgeFrame, Clock, FrameChannel } from "./fixture";
import type { Observation } from "./observation";
import { observeThrough } from "./observation";
import type { ReducedState } from "./reducer";
import type { TransportDouble } from "./transport/delivery";

/** The three frozen channels, in a fixed order so diffs sort deterministically. */
const CHANNELS: readonly FrameChannel[] = ["control", "stream", "bulk"];

/** Longest value preview in one diff line. */
const PREVIEW_LIMIT = 120;

/** An identifier-shaped object key can use dot notation in a path. */
const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The frozen report shape. */
export type ComparisonReport = {
  equal: boolean;
  diffs: string[];
};

/** The frozen harness shape. */
export type ComparisonHarness = {
  observe(
    double: TransportDouble,
    frames: readonly BridgeFrame[],
    clock: Clock,
  ): Promise<Observation>;
  compare(a: Observation, b: Observation): ComparisonReport;
};

/**
 * Compare two observations without asserting cross-channel order.
 *
 * @param a First observation, usually the `ipc` shell.
 * @param b Second observation, usually the `postMessage` shell.
 */
export function compareObservations(a: Observation, b: Observation): ComparisonReport {
  const diffs: string[] = [];

  for (const channel of CHANNELS) {
    diffValue(`byChannel.${channel}`, a.byChannel[channel], b.byChannel[channel], diffs);
  }

  diffReduced(a.state, b.state, diffs);
  diffValue("rejected", a.rejected, b.rejected, diffs);
  diffValue("transportRejections", a.transportRejections ?? [], b.transportRejections ?? [], diffs);

  const sorted = [...new Set(diffs)].sort();

  return { equal: sorted.length === 0, diffs: sorted };
}

/**
 * Build the frozen harness: the two entry points with no state of their own.
 *
 * The wrapper exists so a caller can inject one object instead of importing two
 * functions; `observe` is {@link observeThrough} unchanged.
 */
export function createComparisonHarness(): ComparisonHarness {
  return {
    observe: observeThrough,
    compare: compareObservations,
  };
}

/**
 * Compare the reducer output by its four sections.
 *
 * The sections are presented as their own path roots (`control`, `stream`,
 * `bulk`, `state`) instead of sitting under another `state.` segment: that
 * keeps `state.queue.pending` readable and keeps a folded `state.control` key
 * from colliding with the `control` log. If `state` is not a reducer output
 * (the frozen field is `unknown`), the whole value is compared under `state`.
 */
function diffReduced(left: unknown, right: unknown, out: string[]): void {
  const leftState = asReducedState(left);
  const rightState = asReducedState(right);

  if (leftState === undefined || rightState === undefined) {
    diffValue("state", left, right, out);
    return;
  }

  diffValue("control", leftState.control, rightState.control, out);
  diffValue("stream", leftState.stream, rightState.stream, out);
  diffValue("bulk", leftState.bulk, rightState.bulk, out);
  diffValue("state", leftState.state, rightState.state, out);
}

/** Read `value` as a reducer output, or `undefined` when it is not one. */
function asReducedState(value: unknown): ReducedState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const { control, stream, bulk, state } = value;

  if (
    !Array.isArray(control) ||
    !Array.isArray(stream) ||
    !Array.isArray(bulk) ||
    !isRecord(state)
  ) {
    return undefined;
  }

  return {
    control: control as BridgeFrame[],
    stream: stream as BridgeFrame[],
    bulk: bulk as BridgeFrame[],
    state,
  };
}

/** Append every difference between `left` and `right` below `path`. */
function diffValue(path: string, left: unknown, right: unknown, out: string[]): void {
  if (Object.is(left, right)) {
    return;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);

    for (let index = 0; index < length; index += 1) {
      diffValue(`${path}[${index}]`, left[index], right[index], out);
    }

    return;
  }

  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);

    for (const key of [...keys].sort()) {
      const segment = joinPath(path, key);
      const hasLeft = Object.prototype.hasOwnProperty.call(left, key);
      const hasRight = Object.prototype.hasOwnProperty.call(right, key);

      if (!hasLeft) {
        out.push(`${segment}: absent !== ${preview(right[key])}`);
      } else if (!hasRight) {
        out.push(`${segment}: ${preview(left[key])} !== absent`);
      } else {
        diffValue(segment, left[key], right[key], out);
      }
    }

    return;
  }

  out.push(`${path}: ${preview(left)} !== ${preview(right)}`);
}

/** Join one object key onto a path. */
function joinPath(path: string, key: string): string {
  return IDENTIFIER_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** One compact, single-line, length-capped value preview. */
function preview(value: unknown): string {
  let text: string;

  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }

  const singleLine = text.replace(/\s+/g, " ");

  return singleLine.length > PREVIEW_LIMIT
    ? `${singleLine.slice(0, PREVIEW_LIMIT)}...`
    : singleLine;
}

/** True for a decoded JSON object (not null, not an array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
