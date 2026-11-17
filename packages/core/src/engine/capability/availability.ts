/**
 * Capability availability: the only place that answers "may this entry be
 * shown at all?" (`D-03`, `INV-8`).
 *
 * Three states, and the difference between the last two is the point:
 *
 * - `available` — the engine advertises the feature and the version is new
 *   enough.
 * - `unavailable` — the engine *said* it does not have it (`feature-off`) or is
 *   older than the capability (`engine-too-old`). Hiding the entry here is
 *   correct: asking would fail.
 * - `unknown` — nobody has probed, or the engine did not advertise the flag.
 *   Hiding here would hide a working feature, so a caller shows the entry and
 *   lets the command fail loudly instead.
 *
 * Pure: no I/O, no clock, no caching. The probe is passed in.
 */

import type { CapabilityMeta, CapabilityName } from "@haruyuki/protocol";
import { CAPABILITY_META } from "@haruyuki/protocol";

import type { CapabilitySnapshot } from "../client/types.js";

/** Result of asking "may I show this capability?". */
export type CapabilityAvailability =
  | { readonly state: "available" }
  | {
      readonly state: "unavailable";
      readonly reason: "engine-too-old" | "feature-off";
    }
  | {
      readonly state: "unknown";
      readonly reason: "not-probed" | "flag-not-advertised";
    };

/**
 * Feature flag that gates a capability family.
 *
 * Only four families are gated by a coarse boolean; every other family is
 * always offered and is bounded by `since` alone. `conversation.switch` is the
 * one row that needs a second flag (`runtime_start`), because switch itself
 * starts a runtime.
 */
const FAMILY_FLAG: Readonly<Record<string, string>> = {
  agent: "agent_management",
  conversation: "conversation_management",
  memory: "memory_management",
};

/** Capability-specific overrides, checked before the family flag. */
const NAME_FLAGS: Readonly<Record<string, readonly string[]>> = {
  "conversation.switch": ["runtime_start", "conversation_management"],
  "subagent.launch": ["launch_subagent"],
};

/**
 * Parse a dotted version into numbers; non-numeric parts count as `0`.
 *
 * @param version version text such as `0.6.0`
 * @returns comparable numeric parts
 */
function versionParts(version: string): number[] {
  return version
    .split(/[.\-+]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isNaN(part) ? 0 : part));
}

/**
 * Whether `required` is at or below `actual`.
 *
 * Compares part by part, so `0.10.0` is newer than `0.9.9` (string comparison
 * would say the opposite).
 *
 * @param required the capability's `since`
 * @param actual the engine's reported version
 * @returns true when the engine is new enough
 */
export function isVersionAtLeast(required: string, actual: string): boolean {
  const left = versionParts(required);
  const right = versionParts(actual);
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;

    if (a !== b) {
      return a < b;
    }
  }

  return true;
}

/**
 * Flags that gate one capability, most specific first.
 *
 * @param name capability name
 * @returns flag keys, empty when the capability is ungated
 */
function flagsFor(name: CapabilityName): readonly string[] {
  const override = NAME_FLAGS[name];

  if (override !== undefined) {
    return override;
  }

  const family = name.split(".")[0] ?? "";
  const flag = FAMILY_FLAG[family];

  return flag === undefined ? [] : [flag];
}

/**
 * Decide whether a capability may be offered right now.
 *
 * Order matters: the version gate is checked first (it is knowable without a
 * probe), then the probe state, then the flags. An ungated capability ignores
 * the probe entirely, so a `confirmed-empty` engine still offers `workspace.*`.
 *
 * @param name capability name
 * @param probe latest capability snapshot
 * @param engineVersion version reported by the engine
 * @returns the tri-state verdict
 */
export function availabilityOf(
  name: CapabilityName,
  probe: CapabilitySnapshot,
  engineVersion: string,
): CapabilityAvailability {
  const meta: CapabilityMeta = CAPABILITY_META[name];

  if (!isVersionAtLeast(meta.since, engineVersion)) {
    return { state: "unavailable", reason: "engine-too-old" };
  }

  const flags = flagsFor(name);

  if (flags.length === 0) {
    return { state: "available" };
  }

  if (probe.state === "unknown") {
    return { state: "unknown", reason: "not-probed" };
  }

  if (probe.state === "confirmed-empty") {
    return { state: "unavailable", reason: "feature-off" };
  }

  for (const flag of flags) {
    const value = probe.booleans[flag];

    if (value === undefined) {
      return { state: "unknown", reason: "flag-not-advertised" };
    }

    if (value === false) {
      return { state: "unavailable", reason: "feature-off" };
    }
  }

  return { state: "available" };
}

/**
 * Whether a capability should appear in a command surface.
 *
 * 三态映射：`available`（引擎说明支持）/ `unavailable`（引擎说明不支持）/
 * `unknown`（引擎没说）。**`INV-8` 的"缺能力则隐藏"只对 `unavailable` 生效** ——
 * 对 `unknown` 隐藏等于替用户做了一个我们不知道的决定。
 *
 * `unknown` stays visible on purpose: hiding on ignorance turns a probed-late
 * engine into a broken-looking product, while a visible command that fails has
 * a visible cause.
 *
 * @param availability tri-state verdict
 * @returns true when the entry may be shown
 */
export function isOffered(availability: CapabilityAvailability): boolean {
  return availability.state !== "unavailable";
}
