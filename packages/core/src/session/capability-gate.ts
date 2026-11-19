/**
 * Capability gate: one agent's whole capability surface, as a table.
 *
 * A read-side composition, not a second rule book. `availabilityOf` answers
 * "may this one capability be shown?" for a single name; a capability panel asks
 * that question for every name at once, and the only thing worth owning here is
 * what a *table* does with the answers.
 *
 * What the table keeps, and why:
 *
 * - `unknown` rows stay. "Nobody has probed" and "the engine did not advertise
 *   the flag" are not evidence that a capability is missing. A table that dropped
 *   those rows would hide a feature that may well work, on no evidence at all.
 * - `unavailable` rows stay too, carrying their reason. The engine said no, or
 *   is older than the capability; whether to draw the row is the display layer's
 *   call, and it can only state a reason that is still in the row.
 *
 * So this module filters nothing, and visibility is a separate predicate
 * ({@link isCapabilityShown}) that delegates to the project's existing rule
 * rather than restating it.
 *
 * Pure: no I/O, no clock, no caching. The probe and the engine version are
 * passed in by the caller, which is the only place that knows which agent this
 * table is about.
 */

import type { CapabilityName } from "@haruyuki/protocol";
import { CAPABILITY_META } from "@haruyuki/protocol";

import type { CapabilitySnapshot } from "../engine/client/types.js";
import { availabilityOf, isOffered } from "../engine/capability/availability.js";
import type { CapabilityAvailability } from "../engine/capability/availability.js";

/** Every capability, keyed by its name, with the verdict it got. */
export type CapabilityTable = Readonly<Record<CapabilityName, CapabilityAvailability>>;

/** What the gate needs: one agent's probe snapshot and the engine's version. */
export interface CapabilityGateInput {
  /** The agent's latest capability probe; `{ state: "unknown" }` when unprobed. */
  readonly probe: CapabilitySnapshot;
  /** The version the engine reported, such as `0.6.0`. */
  readonly engineVersion: string;
}

/**
 * Every capability name, taken from the generated table.
 *
 * Derived rather than typed out: a hand-written list of dozens of names drifts
 * the moment the contract gains a row, and the drift would be invisible because
 * the table's type cannot count its members.
 */
const CAPABILITY_NAMES: readonly CapabilityName[] = Object.freeze(
  (Object.keys(CAPABILITY_META) as CapabilityName[]).sort((left, right) =>
    left === right ? 0 : left < right ? -1 : 1,
  ),
);

/**
 * Version used when the caller passes something that is not a version.
 *
 * The version axis asks "is the engine too old to have this capability?". With
 * no readable version that question cannot be answered yes, and answering it
 * anyway would hide capabilities on a guess. So the version gate abstains - this
 * value is newer than every `since` in the table - and the flag axis still
 * decides. The alternative, treating the absence as `0.0.0`, would mark the
 * entire table `unavailable` and hide a working product.
 */
const VERSION_ABSTAINS = "9999.0.0";

/**
 * Read a probe defensively.
 *
 * The type says a caller hands in a `CapabilitySnapshot`, but the probe is
 * engine-facing data, and a malformed one must not throw out of a read path. An
 * unreadable probe becomes "nobody has probed", which yields `unknown` for the
 * gated capabilities and changes nothing for the ungated ones - the direction
 * that hides nothing.
 *
 * @param value whatever the caller passed
 * @returns a snapshot the availability rule can read
 */
function readProbe(value: unknown): CapabilitySnapshot {
  if (typeof value !== "object" || value === null) {
    return { state: "unknown" };
  }

  const probe = value as {
    state?: unknown;
    booleans?: unknown;
    slashCommands?: unknown;
    probedAt?: unknown;
  };

  switch (probe.state) {
    case "unknown":
      return { state: "unknown" };
    case "confirmed-empty":
      return { state: "confirmed-empty", probedAt: readNumber(probe.probedAt) };
    case "probed": {
      const booleans = readBooleans(probe.booleans);

      // A probe whose flag map is unreadable is not a probe that found no flags:
      // the latter is `probed` with `{}` and means "the flag was not
      // advertised". Without the map we know nothing, so say so.
      if (booleans === null) {
        return { state: "unknown" };
      }

      return {
        state: "probed",
        booleans,
        slashCommands: readStrings(probe.slashCommands),
        probedAt: readNumber(probe.probedAt),
      };
    }
    default:
      return { state: "unknown" };
  }
}

/**
 * Keep only boolean flag values.
 *
 * A flag of the wrong type is treated as not advertised, which the availability
 * rule reports as `unknown` rather than as a refusal.
 *
 * @param value candidate flag map
 * @returns the readable flags, or null when there is no map at all
 */
function readBooleans(value: unknown): Readonly<Record<string, boolean>> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const flags: Record<string, boolean> = {};

  for (const [key, flag] of Object.entries(value)) {
    if (typeof flag === "boolean") {
      flags[key] = flag;
    }
  }

  return flags;
}

/**
 * @param value candidate list of advertised command names
 * @returns the string entries; empty when there is no readable list
 */
function readStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * @param value candidate timestamp
 * @returns the number, or `0` when it is not one
 */
function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * @param value candidate engine version
 * @returns a comparable version string
 */
function readVersion(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : VERSION_ABSTAINS;
}

/**
 * Build the capability table for one agent.
 *
 * Every name in the contract is a row, including the ones the engine refused and
 * the ones nobody has probed: the caller decides what to draw, and it can only
 * decide that from a row it can still see.
 *
 * @param input the agent's probe snapshot and the engine version
 * @returns every capability name mapped to its tri-state verdict, frozen
 */
export function capabilityTable(input: CapabilityGateInput): CapabilityTable {
  const probe = readProbe(input?.probe);
  const engineVersion = readVersion(input?.engineVersion);
  const rows = {} as Record<CapabilityName, CapabilityAvailability>;

  for (const name of CAPABILITY_NAMES) {
    rows[name] = availabilityOf(name, probe, engineVersion);
  }

  return Object.freeze(rows);
}

/**
 * Whether one capability belongs on screen, read off a built table.
 *
 * A lookup and the shared rule, not a second rule: `isOffered` already states
 * that `available` and `unknown` are shown and only `unavailable` is hidden, so
 * this predicate hands the row to it instead of repeating the comparison.
 *
 * @param table a table built by {@link capabilityTable}
 * @param name the capability to ask about
 * @returns true when the entry may be shown
 */
export function isCapabilityShown(table: CapabilityTable, name: CapabilityName): boolean {
  return isOffered(table[name]);
}
