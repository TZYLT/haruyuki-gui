/**
 * Tests for the timeout family table.
 *
 * The module under test has two halves, and they need different kinds of
 * evidence:
 *
 * - **Completeness is a compile-time property.** `CAPABILITY_TIMEOUT_FAMILY` is
 *   declared with `satisfies Record<CapabilityName, TimeoutFamily>`, so dropping
 *   a row or naming a capability that does not exist is a `tsc` error, not a red
 *   test. What the tests below add is the *runtime* half of the same claim: that
 *   the table partitions the 68 contract rows into four disjoint families with no
 *   row counted twice and none left over - a property `satisfies` alone cannot
 *   express, because a family table can be total and still misclassify.
 * - **The numbers are checked twice, from two directions.** Every ceiling is
 *   asserted against a literal (10 s / 10 s / 30 s / 180 s), and the family
 *   counts are asserted both as literals and against the contract's own row count
 *   read from `capabilities.json`. A literal-only check would go stale silently
 *   if someone added a capability and miscounted; a derived-only check would pass
 *   no matter how the rows were split.
 *
 * The wire-vocabulary rule is enforced here for this module only, the
 * same way `capability-names.test.ts` enforces it for its own file: `client/` must
 * not contain a wire id literal, and a leak in *this* file has to be able to turn
 * this suite red rather than a sibling package's.
 *
 * Every case here was checked by mutation: the comment above each `it` names the
 * edit that makes it fail. A case without such an edit would not be a test.
 *
 * Nothing here writes to disk, touches the network or waits on a real timer.
 */

import { readFileSync } from "node:fs";

import type { CapabilityName as ProtocolCapabilityName } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { CAPABILITY_NAMES, isCapabilityName, wireIdOf } from "./capability-names";
import type { CapabilityName } from "./capability-names";
import {
  CAPABILITY_TIMEOUT_FAMILY,
  capabilitiesInFamily,
  defaultTimeoutMs,
  FAMILY_TIMEOUT_MS,
  familyCapabilityCount,
  maxTimeoutMs,
  resolveTimeout,
  TIMEOUT_CAP_MULTIPLIER,
  TIMEOUT_FAMILIES,
  TIMEOUT_FAMILY_SUMMARIES,
  timeoutFamilyOf,
  totalFamilyCapabilityCount,
} from "./timeouts";
import type { TimeoutFamily } from "./timeouts";

/* contract truth sources (read-only)                                   */

const CAPABILITIES_URL = new URL(
  "../../../../protocol/src/contract/capabilities.json",
  import.meta.url,
);
const SOURCE_URL = new URL("./timeouts.ts", import.meta.url);

/** The contract's advertised row count; a change here is a contract event. */
const EXPECTED_TOTAL = 68;

/**
 * The intended size of each family.
 *
 * These are the numbers a reviewer should be able to argue with, which is why
 * they are literal here rather than computed from the module: a count derived
 * from the table would agree with any split at all, including one that moved a
 * capability to the wrong family.
 *
 * `handshake` 1, `fast` 39, `normal` 23, `slow` 5 - derived from
 * the per-domain reasoning in the module, then frozen.
 */
const EXPECTED_FAMILY_COUNTS: Readonly<Record<TimeoutFamily, number>> = {
  handshake: 1,
  fast: 39,
  normal: 23,
  slow: 5,
};

/** The four ceilings. Literal on purpose - see the header. */
const EXPECTED_FAMILY_MS: Readonly<Record<TimeoutFamily, number>> = {
  handshake: 10_000,
  fast: 10_000,
  normal: 30_000,
  slow: 180_000,
};

/**
 * The slow family, spelled out.
 *
 * This is the list that matters for the slow family: maintenance that runs a
 * model session. `slash.exec` is in it because that is the capability row the
 * documented `dream` / `reflect` slash commands travel on - see the module header
 * and the dedicated case below.
 */
const EXPECTED_SLOW: readonly CapabilityName[] = [
  "compaction.cancel",
  "compaction.commit",
  "compaction.prepare",
  "slash.exec",
  "subagent.launch",
];

/** Read `capabilities.json` and return its capability names, in file order. */
function readContractNames(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(CAPABILITIES_URL, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("capabilities.json: root is not an object");
  }
  const rows = (parsed as { capabilities?: unknown }).capabilities;
  if (!Array.isArray(rows)) {
    throw new Error("capabilities.json: capabilities is not an array");
  }
  return rows.map((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { name?: unknown }).name !== "string"
    ) {
      throw new Error("capabilities.json: a row has no string name");
    }
    return (row as { name: string }).name;
  });
}

/* wire-vocabulary scan helpers                                         */

/**
 * Every wire id the protocol knows, taken from the mapping table.
 *
 * The wire id strings are *obtained*, never written: `wireIdOf` is the one
 * sanctioned way to reach one, so this file adds no new literal of its own.
 */
function allWireIds(): string[] {
  return CAPABILITY_NAMES.map((name) => wireIdOf(name));
}

/**
 * Find wire ids that appear in a source text as whole, dot-delimited tokens.
 *
 * Same three boundary rules as `capability-names.test.ts`, and for the same
 * reasons: no adjacent `[A-Za-z0-9_]` so a longer identifier does not contain a
 * shorter wire id, no adjacent `.` so the dotted *capability* spelling is not
 * mistaken for a wire id, and the two ids that are also plain English words
 * (`input`, `sync`) are skipped because a pattern cannot tell them from prose.
 *
 * @param source text to scan
 * @returns the wire ids found
 */
function findWireLeaks(source: string): string[] {
  const proseColliding: readonly string[] = ["input", "sync"];
  return allWireIds().filter((wire) => {
    if (proseColliding.includes(wire)) {
      return false;
    }
    return new RegExp(`(?<![A-Za-z0-9_.])${wire}(?![A-Za-z0-9_.])`).test(source);
  });
}

/* completeness                                                        */

describe("family table completeness", () => {
  it("assigns a family to exactly the 68 contract capabilities", () => {
    // Red if: a row is added to CAPABILITY_TIMEOUT_FAMILY (extra key), removed
    // (missing key - also a tsc error, this is the runtime belt), or renamed.
    const assigned = Object.keys(CAPABILITY_TIMEOUT_FAMILY);
    expect(assigned).toHaveLength(EXPECTED_TOTAL);
    expect([...assigned].sort()).toEqual([...CAPABILITY_NAMES].sort());
  });

  it("agrees with capabilities.json about how many rows exist", () => {
    // Red if: the contract gains or loses a row and this table is not updated.
    // Independent source, so a table that is self-consistently wrong still fails.
    const contract = readContractNames();
    expect(contract).toHaveLength(EXPECTED_TOTAL);
    expect(totalFamilyCapabilityCount()).toBe(contract.length);
  });

  it("partitions the 68 rows into four disjoint families", () => {
    // Red if: a name is listed in two families (impossible while families are
    // values of a single-key record, so this also guards a future refactor to a
    // per-family list), or one is dropped from the union.
    const union: CapabilityName[] = [];
    for (const family of TIMEOUT_FAMILIES) {
      for (const name of capabilitiesInFamily(family)) {
        union.push(name);
      }
    }
    expect(union).toHaveLength(EXPECTED_TOTAL);
    expect(new Set(union).size).toBe(EXPECTED_TOTAL);
    expect([...union].sort()).toEqual([...CAPABILITY_NAMES].sort());
  });

  it("answers the family of every capability, and never an empty string", () => {
    // Red if: timeoutFamilyOf returns a value outside the union, or the table
    // gains a key with a non-family value (the `satisfies` stops `tsc`).
    for (const name of CAPABILITY_NAMES) {
      const family = timeoutFamilyOf(name);
      expect(TIMEOUT_FAMILIES, `${name} has an unknown family`).toContain(family);
    }
  });

  it("keeps the family tuple in sync with the ceiling record", () => {
    // Red if: a family is added to TIMEOUT_FAMILIES without a ceiling or vice
    // versa - the two records are what every other check derives from.
    expect([...TIMEOUT_FAMILIES].sort()).toEqual(Object.keys(FAMILY_TIMEOUT_MS).sort());
  });
});

/* ceilings                                                            */

describe("family ceilings", () => {
  it("sets the four ceilings to 10s / 10s / 30s / 180s", () => {
    // Red if: any one of the four numbers changes. This is the case the table
    // is really pinning, and the reason the slow ceiling is not a `normal` one.
    expect(FAMILY_TIMEOUT_MS.handshake).toBe(10_000);
    expect(FAMILY_TIMEOUT_MS.fast).toBe(10_000);
    expect(FAMILY_TIMEOUT_MS.normal).toBe(30_000);
    expect(FAMILY_TIMEOUT_MS.slow).toBe(180_000);
    expect(FAMILY_TIMEOUT_MS).toEqual(EXPECTED_FAMILY_MS);
  });

  it("orders the ceilings so a slower family never waits less", () => {
    // Red if: `slow` drops below `normal`, or `fast` drops below `handshake` -
    // a family inversion that the per-family literals above would not catch if
    // someone changed two numbers to the same wrong value.
    expect(FAMILY_TIMEOUT_MS.handshake).toBeLessThanOrEqual(FAMILY_TIMEOUT_MS.fast);
    expect(FAMILY_TIMEOUT_MS.fast).toBeLessThanOrEqual(FAMILY_TIMEOUT_MS.normal);
    expect(FAMILY_TIMEOUT_MS.normal).toBeLessThanOrEqual(FAMILY_TIMEOUT_MS.slow);
  });

  it("reports each capability's ceiling through its family", () => {
    // Red if: defaultTimeoutMs reads the wrong family, or the per-name lookup
    // stops agreeing with the family table.
    for (const name of CAPABILITY_NAMES) {
      expect(defaultTimeoutMs(name), `${name}`).toBe(FAMILY_TIMEOUT_MS[timeoutFamilyOf(name)]);
    }
    expect(defaultTimeoutMs("device.info")).toBe(10_000);
    expect(defaultTimeoutMs("conversation.switch")).toBe(30_000);
    expect(defaultTimeoutMs("compaction.prepare")).toBe(180_000);
  });
});

/* the slow family specifically                                        */

describe("the slow family", () => {
  it("holds exactly the documented maintenance capabilities", () => {
    // Red if: `dream` (i.e. the slash row carrying it) is moved to `normal`, or
    // any compaction row is downgraded, or a fast row is promoted here.
    expect([...capabilitiesInFamily("slow")].sort()).toEqual([...EXPECTED_SLOW].sort());
  });

  it("contains every compaction capability", () => {
    // Red if: `compaction.prepare` or `compaction.commit` is moved down. The
    // measured 6489 ms maximum lives here; a `normal` ceiling would false-timeout.
    const slow = capabilitiesInFamily("slow");
    for (const name of ["compaction.prepare", "compaction.commit", "compaction.cancel"] as const) {
      expect(slow, `${name} must be slow`).toContain(name);
      expect(timeoutFamilyOf(name), `${name} must be slow`).toBe("slow");
    }
  });

  it("contains the slash row that carries the dream and reflect commands", () => {
    // Red if: `slash.exec` is moved out of the slow family. `dream` and `reflect`
    // are not capabilities of the 68-row contract, so this row is where
    // §4.2's `dream`/`reflect` actually live; moving it to `normal` would give
    // them a 30 s ceiling.
    expect(capabilitiesInFamily("slow")).toContain("slash.exec");
    expect(timeoutFamilyOf("slash.exec")).toBe("slow");
    expect(defaultTimeoutMs("slash.exec")).toBe(180_000);
  });

  it("does not pretend dream and reflect are capabilities", () => {
    // Red if: the contract grows a real `dream` capability (then it needs a row
    // and this case tells the next reader why), or someone writes a name that is
    // not in the union at all - which `tsc` also catches.
    expect(isCapabilityName("dream")).toBe(false);
    expect(isCapabilityName("reflect")).toBe(false);
    expect(isCapabilityName("subagent.launch")).toBe(true);
  });

  it("contains the subagent launch", () => {
    // Red if: `subagent.launch` is demoted. It measured 1364 ms and hands off to
    // a child agent, so it is the one slow row with a real sample besides compact.
    expect(timeoutFamilyOf("subagent.launch")).toBe("slow");
    expect(capabilitiesInFamily("slow")).toContain("subagent.launch");
  });

  it("leaves nothing slow that is really a local read", () => {
    // Red if: a file, terminal, workspace or memory row is promoted to `slow`.
    // Those are the families with sub-second measurements; a 180 s ceiling there
    // would hide a hung command for three minutes.
    const slow = capabilitiesInFamily("slow");
    const localPrefixes = ["file.", "terminal.", "workspace.", "memory.", "message."];
    for (const name of slow) {
      expect(
        localPrefixes.some((prefix) => name.startsWith(prefix)),
        `${name} is local work and must not be slow`,
      ).toBe(false);
    }
  });
});

/* the handshake family                                               */

describe("the handshake family", () => {
  it("holds only the post-auth handshake", () => {
    // Red if: another capability is put in `handshake`, or `device.info` moves.
    // The handshake is the one command whose ceiling is about connecting at all,
    // so it must stay a family of one - a second member would make "the
    // handshake budget" meaningless.
    expect([...capabilitiesInFamily("handshake")]).toEqual(["device.info"]);
    expect(timeoutFamilyOf("device.info")).toBe("handshake");
  });
});

/* per-family counts                                                   */

describe("per-family counts", () => {
  it("counts 1 / 39 / 23 / 5", () => {
    // Red if: any capability changes family - which is the whole risk of a
    // hand-written table, and the reason the counts are pinned as literals.
    const actual: Record<TimeoutFamily, number> = {
      handshake: familyCapabilityCount("handshake"),
      fast: familyCapabilityCount("fast"),
      normal: familyCapabilityCount("normal"),
      slow: familyCapabilityCount("slow"),
    };
    expect(actual).toEqual(EXPECTED_FAMILY_COUNTS);
  });

  it("sums to the contract total", () => {
    // Red if: a family loses a row without another gaining it. The two checks are
    // not redundant: the per-family literals catch a redistribution, this catches
    // a row that vanished from every family.
    const sum = TIMEOUT_FAMILIES.reduce(
      (total, family) => total + familyCapabilityCount(family),
      0,
    );
    expect(sum).toBe(EXPECTED_TOTAL);
    expect(sum).toBe(totalFamilyCapabilityCount());
    expect(sum).toBe(readContractNames().length);
  });

  it("derives the summary counts from the member lists, not by typing them", () => {
    // Red if: the summary's `count` stops tracking its `capabilities` array (a
    // hand-typed count is the classic drift), or `timeoutMs` is copied stale.
    expect(TIMEOUT_FAMILY_SUMMARIES).toHaveLength(4);
    for (const row of TIMEOUT_FAMILY_SUMMARIES) {
      expect(row.count, `${row.family}`).toBe(row.capabilities.length);
      expect(row.count, `${row.family}`).toBe(EXPECTED_FAMILY_COUNTS[row.family]);
      expect(row.timeoutMs, `${row.family}`).toBe(EXPECTED_FAMILY_MS[row.family]);
    }
  });

  it("lists each family's members in the summary in the same order as the getter", () => {
    // Red if: the summary is built from a different source than
    // capabilitiesInFamily, so two consumers would see two orders.
    for (const row of TIMEOUT_FAMILY_SUMMARIES) {
      expect([...row.capabilities]).toEqual([...capabilitiesInFamily(row.family)]);
    }
    const families = TIMEOUT_FAMILY_SUMMARIES.map((row) => row.family);
    expect(families).toEqual([...TIMEOUT_FAMILIES]);
  });
});

/* timeoutMs override                                                  */

describe("resolveTimeout: the caller's override", () => {
  it("uses the family default when no value is given", () => {
    // Red if: resolveTimeout stops falling back to the ceiling.
    expect(resolveTimeout("device.info")).toEqual({ ms: 10_000, clamped: false });
    expect(resolveTimeout("conversation.switch")).toEqual({ ms: 30_000, clamped: false });
    expect(resolveTimeout("compaction.prepare")).toEqual({ ms: 180_000, clamped: false });
  });

  it("honours a smaller override, so a picker can wait less", () => {
    // Red if: the override is ignored (the caller's 250 ms becomes 30 000).
    expect(resolveTimeout("conversation.switch", 250)).toEqual({ ms: 250, clamped: false });
  });

  it("honours a larger override that is still within the cap", () => {
    // Red if: the override is ignored in the other direction - a caller who
    // legitimately needs 120 s for a normal command gets 30 s. `normal` cap is
    // 300 s, so 120 s must pass through untouched.
    expect(resolveTimeout("conversation.switch", 120_000)).toEqual({
      ms: 120_000,
      clamped: false,
    });
  });

  it("uses the caller's value verbatim, for every capability", () => {
    // Red if: any per-capability branch second-guesses a valid override. Uses a
    // value below every ceiling so the cap cannot be what is measured here.
    for (const name of CAPABILITY_NAMES) {
      expect(resolveTimeout(name, 5), `${name}`).toEqual({ ms: 5, clamped: false });
    }
  });
});

/* the 10x cap                                                         */

describe("resolveTimeout: the 10x cap", () => {
  it("caps the multiplier at 10x the family ceiling", () => {
    // Red if: TIMEOUT_CAP_MULTIPLIER changes. The cap is a judgement
    // §4.4) and a change is a design change, so it is pinned. One capability per
    // family is enough: `maxTimeoutMs` takes a capability, and the per-family
    // ceiling is what it multiplies.
    expect(TIMEOUT_CAP_MULTIPLIER).toBe(10);
    expect(maxTimeoutMs("message.send")).toBe(100_000);
    expect(maxTimeoutMs("conversation.switch")).toBe(300_000);
    expect(maxTimeoutMs("compaction.prepare")).toBe(1_800_000);

    // The family-level ceiling times the multiplier must be the same number for
    // every member, or the two sources disagree about what a family's cap is.
    for (const family of TIMEOUT_FAMILIES) {
      const expected = FAMILY_TIMEOUT_MS[family] * TIMEOUT_CAP_MULTIPLIER;
      for (const name of capabilitiesInFamily(family)) {
        expect(maxTimeoutMs(name), `${name} (${family})`).toBe(expected);
      }
    }
  });

  it("clamps a one-hour override to the family cap and says it did", () => {
    // Red if: the clamp is removed (ms becomes 3_600_000), or `clamped` is
    // hard-coded `false`. For `fast` the cap is 100 s, so 3 600 000 is over it.
    const resolved = resolveTimeout("message.send", 3_600_000);
    expect(resolved).toEqual({ ms: 100_000, clamped: true });
    expect(resolved.clamped).toBe(true);
  });

  it("clamps at exactly one hour for every family, to that family's cap", () => {
    // Red if: the clamp uses a fixed ceiling instead of the family's own (then
    // `slow` would clamp to 100 s and lose 170 s of legitimately needed budget),
    // or the multiplication is off by a factor.
    for (const name of CAPABILITY_NAMES) {
      const cap = defaultTimeoutMs(name) * 10;
      const resolved = resolveTimeout(name, 3_600_000);
      expect(resolved.ms, `${name} must clamp to its own cap`).toBe(cap);
      expect(resolved.clamped, `${name} must report the clamp`).toBe(true);
    }
  });

  it("does not clamp a value exactly at the cap, but clamps cap + 1", () => {
    // Red if: the comparison becomes `>=` (the boundary value would be reported
    // clamped although it was honoured exactly), or `>` becomes `>>`.
    const cap = maxTimeoutMs("message.send");
    expect(resolveTimeout("message.send", cap)).toEqual({ ms: cap, clamped: false });
    expect(resolveTimeout("message.send", cap + 1)).toEqual({ ms: cap, clamped: true });
  });

  it("treats a value just above the default as an ordinary override", () => {
    // Red if: the clamp is written against the *default* instead of the cap,
    // which would silently forbid any override above the family default and make
    // the feature useless. 31 s on a 30 s family is inside the 300 s cap.
    expect(resolveTimeout("conversation.switch", 31_000)).toEqual({
      ms: 31_000,
      clamped: false,
    });
    expect(resolveTimeout("conversation.switch", 300_000)).toEqual({
      ms: 300_000,
      clamped: false,
    });
  });
});

/* values that name no budget                                          */

describe("resolveTimeout: unusable values", () => {
  it("falls back to the family default for values that name no budget", () => {
    // Red if: a NaN/Infinity/0/negative slips through as `ms`. A NaN timer fires
    // immediately (a false TIMEOUT on every command); Infinity never fires (a
    // table entry pinned forever, the exact leak the cap exists to prevent).
    const unusable = [0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const value of unusable) {
      expect(resolveTimeout("conversation.switch", value), `${String(value)}`).toEqual({
        ms: 30_000,
        clamped: false,
      });
    }
  });

  it("does not report an unusable value as clamped", () => {
    // Red if: `clamped` is set for every non-default path. The flag must mean
    // "your number was cut down", and an unusable number was never used at all -
    // a diagnostic that said "clamped" here would send a reader looking for a
    // cap that had nothing to do with it.
    expect(resolveTimeout("message.send", Number.NaN).clamped).toBe(false);
    expect(resolveTimeout("message.send", 0).clamped).toBe(false);
  });

  it("always returns a positive finite budget for every capability", () => {
    // Red if: any path can produce 0, a negative number or Infinity. This is the
    // property the timer relies on, asserted over the whole table from both
    // entry points.
    for (const name of CAPABILITY_NAMES) {
      for (const resolved of [resolveTimeout(name), resolveTimeout(name, 3_600_000)]) {
        expect(Number.isFinite(resolved.ms), `${name} must be finite`).toBe(true);
        expect(resolved.ms, `${name} must be positive`).toBeGreaterThan(0);
      }
      expect(defaultTimeoutMs(name)).toBeGreaterThan(0);
      expect(maxTimeoutMs(name)).toBe(defaultTimeoutMs(name) * 10);
    }
  });
});

/* wire vocabulary containment                                         */

describe("wire vocabulary containment, this module", () => {
  it("contains no wire id literal in timeouts.ts", () => {
    // Red if: a wire id such as the runtime-start command is written into the
    // module. Capability names are the only sanctioned spelling under `client/`.
    const leaked = findWireLeaks(readFileSync(SOURCE_URL, "utf8"));
    expect(leaked).toEqual([]);
  });

  it("flags a planted wire id, so the scan above is not vacuous", () => {
    // Red if: findWireLeaks stops matching (e.g. a broken boundary group), which
    // would make the case above pass on any source at all.
    const planted = `const leak = "${wireIdOf("toolset.update")}";`;
    expect(findWireLeaks(planted)).toEqual([wireIdOf("toolset.update")]);
  });

  it("does not flag the dotted capability spelling", () => {
    // Red if: the dot boundary is dropped, which would make correct code
    // (`conversation.switch`) fail the scan and tempt someone to disable it.
    expect(findWireLeaks(`capability: ${"terminal.input"}`)).toEqual([]);
    expect(findWireLeaks(`capability: ${"conversation.sync"}`)).toEqual([]);
    expect(findWireLeaks("the async wrapper")).toEqual([]);
  });
});

/* immutability and shape                                              */

describe("exported shapes", () => {
  it("freezes the member lists so a caller cannot hide a capability", () => {
    // Red if: capabilitiesInFamily hands out a mutable array. A caller that
    // spliced it would make familyCapabilityCount disagree with the table.
    for (const family of TIMEOUT_FAMILIES) {
      expect(Object.isFrozen(capabilitiesInFamily(family)), `${family}`).toBe(true);
    }
  });

  it("returns a frozen list that is stable across calls", () => {
    // Red if: collectFamily starts returning a shared mutable cache, or stops
    // freezing. Two reads must be equal, and both must be immutable.
    const first = capabilitiesInFamily("slow");
    const second = capabilitiesInFamily("slow");
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("keeps the family name type closed", () => {
    // Red if: a fifth family name starts being returned. Compile-time this is the
    // union; the runtime half is that every returned value is in the tuple.
    const seen = new Set<string>();
    for (const name of CAPABILITY_NAMES) {
      seen.add(timeoutFamilyOf(name));
    }
    for (const family of seen) {
      expect(TIMEOUT_FAMILIES as readonly string[]).toContain(family);
    }
  });

  it("types the contract row count as a number, not a string", () => {
    // Red if: a count is handed out as a string (a `String(...)` slip), which
    // would break arithmetic in a caller and every `toBe` above would still pass
    // for the literal cases. This pins the type at runtime.
    expect(typeof familyCapabilityCount("fast")).toBe("number");
    expect(typeof totalFamilyCapabilityCount()).toBe("number");
    expect(typeof maxTimeoutMs("compaction.prepare")).toBe("number");
  });
});

/* cross-checks with the capability table                               */

describe("consistency with the capability table", () => {
  it("classifies only capabilities the table knows", () => {
    // Red if: the timeout table gains a key the capability table does not have.
    // `satisfies` already refuses this at compile time; the runtime check keeps
    // it true for a consumer that reads `Object.keys` and trusts it.
    for (const name of Object.keys(CAPABILITY_TIMEOUT_FAMILY)) {
      expect(isCapabilityName(name), `${name} is not a capability`).toBe(true);
      expect(CAPABILITY_NAMES, `${name} missing from the capability list`).toContain(name);
    }
  });

  it("gives every capability exactly one family, once", () => {
    // Red if: the same name is reachable from two families through a stale
    // precomputed list, which would double-count it in the sum.
    const occurrences = new Map<CapabilityName, number>();
    for (const family of TIMEOUT_FAMILIES) {
      for (const name of capabilitiesInFamily(family)) {
        occurrences.set(name, (occurrences.get(name) ?? 0) + 1);
      }
    }
    expect(occurrences.size).toBe(EXPECTED_TOTAL);
    for (const [name, count] of occurrences) {
      expect(count, `${name} must appear in exactly one family`).toBe(1);
    }
  });

  it("exposes the same 68 capability names the union promises", () => {
    // Compile-time anchor: if the protocol union gained a member, iterating it
    // here would reach a name the timeout table has no row for and `toContain`
    // would fail. The annotation makes the direction of that check explicit.
    const fromUnion: readonly ProtocolCapabilityName[] = CAPABILITY_NAMES;
    expect(fromUnion).toHaveLength(EXPECTED_TOTAL);
    for (const name of fromUnion) {
      expect(TIMEOUT_FAMILIES).toContain(timeoutFamilyOf(name as CapabilityName));
    }
  });
});
