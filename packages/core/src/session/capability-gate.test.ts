/**
 * The capability table must not lose rows, and `unknown` is a row.
 *
 * The failure this suite exists to catch is a filter: `rows.filter(row =>
 * row.state !== "unavailable")` reads as a harmless cleanup and silently drops
 * the `unknown` rows with it, hiding features nobody has probed. So the central
 * assertion here is arity - the table has one row per capability name in the
 * contract - plus the explicit `unknown` rows, and both go red when a filter is
 * introduced.
 *
 * The rest is a 4 x 3 table: four engine situations crossed with three gating
 * shapes (a family-gated capability, a capability gated by its own flag, and an
 * ungated one). Each cell states the verdict the availability rule owes, so a
 * row that changes its mind about `unknown` versus `unavailable` fails here even
 * if the rule itself still compiles.
 */

import { CAPABILITY_META } from "@haruyuki/protocol";
import type { CapabilityName } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import type { CapabilitySnapshot } from "../engine/client/types.js";
import { availabilityOf, isOffered } from "../engine/capability/availability.js";
import type { CapabilityAvailability } from "../engine/capability/availability.js";
import { capabilityTable, isCapabilityShown } from "./capability-gate.js";

/** The version every capability in the current contract was introduced at. */
const CURRENT_VERSION = "0.6.0";

const ALL_ON: CapabilitySnapshot = {
  state: "probed",
  booleans: {
    agent_management: true,
    conversation_management: true,
    launch_subagent: true,
    memory_management: true,
    runtime_start: true,
  },
  slashCommands: [],
  probedAt: 1,
};

/** An engine that answered, and did not advertise the subagent flag. */
const PARTIAL: CapabilitySnapshot = {
  state: "probed",
  booleans: { agent_management: true, conversation_management: true },
  slashCommands: [],
  probedAt: 1,
};

const UNPROBED: CapabilitySnapshot = { state: "unknown" };
const EMPTY: CapabilitySnapshot = { state: "confirmed-empty", probedAt: 1 };

/** A capability gated by its family's flag. */
const FAMILY_GATED: CapabilityName = "agent.get";
/** A capability with a flag of its own, checked before the family flag. */
const NAME_GATED: CapabilityName = "subagent.launch";
/** A capability no flag gates: bounded by the version alone. */
const UNGATED: CapabilityName = "workspace.list";

const AVAILABLE: CapabilityAvailability = { state: "available" };
const NOT_PROBED: CapabilityAvailability = { state: "unknown", reason: "not-probed" };
const FLAG_MISSING: CapabilityAvailability = { state: "unknown", reason: "flag-not-advertised" };
const FEATURE_OFF: CapabilityAvailability = { state: "unavailable", reason: "feature-off" };
const TOO_OLD: CapabilityAvailability = { state: "unavailable", reason: "engine-too-old" };

interface Row {
  readonly scenario: string;
  readonly probe: CapabilitySnapshot;
  readonly version: string;
  readonly expected: Readonly<
    Record<"family-gated" | "name-gated" | "ungated", CapabilityAvailability>
  >;
}

/**
 * The combination table: four engine situations, three gating shapes.
 *
 * Row order matters to the reader, not to the code - a row that stops agreeing
 * with `availabilityOf` is a regression in the table, and one that agrees with
 * it while both are wrong is what the `unknown` arity checks below are for.
 */
const ROWS: readonly Row[] = [
  {
    scenario: "engine older than the capability",
    probe: ALL_ON,
    version: "0.0.1",
    expected: { "family-gated": TOO_OLD, "name-gated": TOO_OLD, ungated: TOO_OLD },
  },
  {
    scenario: "nothing has been probed",
    probe: UNPROBED,
    version: CURRENT_VERSION,
    expected: { "family-gated": NOT_PROBED, "name-gated": NOT_PROBED, ungated: AVAILABLE },
  },
  {
    scenario: "the probe answered with nothing",
    probe: EMPTY,
    version: CURRENT_VERSION,
    expected: { "family-gated": FEATURE_OFF, "name-gated": FEATURE_OFF, ungated: AVAILABLE },
  },
  {
    scenario: "the flag was not advertised",
    probe: PARTIAL,
    version: CURRENT_VERSION,
    expected: { "family-gated": AVAILABLE, "name-gated": FLAG_MISSING, ungated: AVAILABLE },
  },
];

describe("capabilityTable: one row per capability, no filtering", () => {
  it("keeps a row for every capability in the contract", () => {
    const table = capabilityTable({ probe: UNPROBED, engineVersion: CURRENT_VERSION });
    const names = Object.keys(CAPABILITY_META) as CapabilityName[];

    // Arity, not "more than zero": a filter that drops `unknown` leaves the
    // table non-empty and still plausible-looking.
    expect(Object.keys(table)).toHaveLength(names.length);
    expect(Object.keys(table).sort()).toEqual([...names].sort());
  });

  it("keeps the capabilities nobody has probed, as unknown", () => {
    // Red when the `unknown` rows are filtered out: the keys alone go red, and
    // the verdict below names what was lost.
    const table = capabilityTable({ probe: UNPROBED, engineVersion: CURRENT_VERSION });

    expect(Object.keys(table)).toContain(FAMILY_GATED);
    expect(Object.keys(table)).toContain(NAME_GATED);
    expect(table[FAMILY_GATED]).toEqual(NOT_PROBED);
    expect(table[NAME_GATED]).toEqual(NOT_PROBED);
  });

  it("keeps the rows the engine refused, with their reason", () => {
    const table = capabilityTable({ probe: EMPTY, engineVersion: CURRENT_VERSION });

    expect(table[FAMILY_GATED]).toEqual(FEATURE_OFF);
    expect(table[NAME_GATED]).toEqual(FEATURE_OFF);
  });

  it("treats a missing flag as unknown, not as a refusal", () => {
    const table = capabilityTable({ probe: PARTIAL, engineVersion: CURRENT_VERSION });

    expect(table[NAME_GATED]).toEqual(FLAG_MISSING);
  });

  it("counts every tri-state in one table, none of them dropped", () => {
    // A partially advertised engine produces all three states at once, which is
    // the row a two-state implementation cannot represent.
    const table = capabilityTable({ probe: PARTIAL, engineVersion: CURRENT_VERSION });
    const states = new Set(Object.values(table).map((row) => row.state));

    expect(states).toContain("available");
    expect(states).toContain("unknown");
    expect(states.size).toBeGreaterThanOrEqual(2);
  });
});

describe("capabilityTable: 4 x 3 verdicts", () => {
  for (const row of ROWS) {
    it(`agrees with the availability rule when ${row.scenario}`, () => {
      const table = capabilityTable({ probe: row.probe, engineVersion: row.version });

      for (const [shape, expected] of Object.entries(row.expected)) {
        const name =
          shape === "family-gated" ? FAMILY_GATED : shape === "name-gated" ? NAME_GATED : UNGATED;

        expect(table[name]).toEqual(expected);
        // Same rule, reached directly: the table must not restate the verdicts
        // in its own words and drift from them.
        expect(table[name]).toEqual(availabilityOf(name, row.probe, row.version));
      }
    });
  }
});

describe("capabilityTable: the version axis covers the whole table", () => {
  it("marks every row unavailable when the engine is older than all of them", () => {
    // The version gate is knowable without a probe, so it does not leave a
    // single row behind - including the ungated families, which the probe cannot
    // affect either way.
    const table = capabilityTable({ probe: ALL_ON, engineVersion: "0.0.1" });
    const rows = Object.values(table);

    expect(rows).toHaveLength(Object.keys(CAPABILITY_META).length);
    expect(
      rows.every((row) => row.state === "unavailable" && row.reason === "engine-too-old"),
    ).toBe(true);
  });
});

describe("isCapabilityShown", () => {
  it("shows available and unknown, hides only unavailable", () => {
    const table = capabilityTable({ probe: UNPROBED, engineVersion: CURRENT_VERSION });

    // `unknown` is the point: it stays on screen so a working feature is not
    // hidden on no evidence.
    expect(isCapabilityShown(table, FAMILY_GATED)).toBe(true);
    expect(isCapabilityShown(table, UNGATED)).toBe(true);

    const emptied = capabilityTable({ probe: EMPTY, engineVersion: CURRENT_VERSION });
    expect(isCapabilityShown(emptied, FAMILY_GATED)).toBe(false);

    const old = capabilityTable({ probe: ALL_ON, engineVersion: "0.0.1" });
    expect(isCapabilityShown(old, UNGATED)).toBe(false);
  });

  it("is the shared rule, not a second copy of it", () => {
    const probes: readonly CapabilitySnapshot[] = [ALL_ON, PARTIAL, UNPROBED, EMPTY];

    for (const probe of probes) {
      const table = capabilityTable({ probe, engineVersion: CURRENT_VERSION });

      for (const name of Object.keys(table) as CapabilityName[]) {
        expect(isCapabilityShown(table, name)).toBe(isOffered(table[name]));
      }
    }
  });
});

describe("capabilityTable: malformed input never throws", () => {
  it("reads a bad probe as unprobed instead of failing", () => {
    const inputs = [
      { probe: null, engineVersion: CURRENT_VERSION },
      { probe: {}, engineVersion: CURRENT_VERSION },
      { probe: { state: "probed" }, engineVersion: CURRENT_VERSION },
      { probe: { state: "nonsense" }, engineVersion: CURRENT_VERSION },
      { probe: "unknown", engineVersion: CURRENT_VERSION },
    ] as unknown as { probe: CapabilitySnapshot; engineVersion: string }[];

    for (const input of inputs) {
      const table = capabilityTable(input);

      expect(Object.keys(table)).toHaveLength(Object.keys(CAPABILITY_META).length);
      expect(table[FAMILY_GATED]).toEqual(NOT_PROBED);
      expect(table[UNGATED]).toEqual(AVAILABLE);
    }
  });

  it("keeps the ungated rows when the version is unreadable", () => {
    // No readable version is not "version zero": the version axis abstains and
    // the probe still decides, so the product does not lose its whole surface to
    // a malformed header.
    const table = capabilityTable({
      probe: ALL_ON,
      engineVersion: undefined as unknown as string,
    });

    expect(table[UNGATED]).toEqual(AVAILABLE);
    expect(table[FAMILY_GATED]).toEqual(AVAILABLE);
  });
});
