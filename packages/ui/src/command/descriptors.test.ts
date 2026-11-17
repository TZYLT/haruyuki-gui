/**
 * `the log` descriptor guarantees.
 *
 * Three things are asserted here, and each fails for a different mistake:
 *
 * 1. The table covers exactly the capabilities the command surface offers
 *    (`CAPABILITY_NAMES` minus the legacy `file.ops`) and nothing else.
 * 2. No capability name is written as a literal in `descriptors.ts` 
 *    the names must come from `@haruyuki/protocol`'s generated tables.
 * 3. Search keys are ASCII and never contain the Chinese copy .
 */
/* eslint-disable no-restricted-imports -- this suite runs under Node and must
   compare the table against the contract tables themselves; the renderer-side
   R4/R7 rules are about shipped code, not test-time reads. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { CAPABILITY_META } from "@haruyuki/protocol";
import type { CapabilityName } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { COMMAND_DESCRIPTORS, filterDescriptors } from "./descriptors.js";

const SOURCE = path.join(import.meta.dirname, "descriptors.ts");

/** Names the surface offers: everything except the bidirectional legacy body. */
const EXPECTED: readonly string[] = (Object.keys(CAPABILITY_META) as CapabilityName[])
  .filter((name) => (CAPABILITY_META[name] as { readonly legacy?: true }).legacy !== true)
  .sort((left, right) => left.localeCompare(right));

describe("COMMAND_DESCRIPTORS", () => {
  it("covers exactly the capabilities the surface offers", () => {
    expect(COMMAND_DESCRIPTORS.map((row) => row.name)).toEqual(EXPECTED);
  });

  it("keeps every capability name out of this module's source ", () => {
    const source = readFileSync(SOURCE, "utf8");
    const literals = source.match(/"[a-z_]+\.[a-z_]+"/g) ?? [];

    expect(literals).toEqual([]);
  });

  it("derives keys from the name so a row cannot point at another row's copy", () => {
    for (const row of COMMAND_DESCRIPTORS) {
      expect(row.labelKey).toBe(
        `page.command.${row.family}.${row.name.slice(row.family.length + 1)}.label`,
      );
      expect(row.descKey.endsWith(".desc")).toBe(true);
    }
  });

  it("searches ASCII only", () => {
    for (const row of COMMAND_DESCRIPTORS) {
      for (const key of row.searchKeys) {
        expect(key).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  it("prefix matches rank before inner matches", () => {
    const results = filterDescriptors("apply");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.searchKeys.some((key) => key.startsWith("apply"))).toBe(true);
  });

  it("returns the whole table for an empty query", () => {
    expect(filterDescriptors("   ")).toHaveLength(COMMAND_DESCRIPTORS.length);
  });
});
