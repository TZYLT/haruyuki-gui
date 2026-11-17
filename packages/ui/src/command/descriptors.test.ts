/**
 * Descriptor guarantees.
 *
 * Each block fails for a different mistake:
 *
 * 1. the table covers exactly the capabilities the surface offers;
 * 2. no capability name is written as a literal;
 * 3. every key a descriptor names exists in **both** locales —
 *    that equality is the only checkable form of "the keys are generated, not
 *    hand-copied";
 * 4. search keys are ASCII only.
 */
// eslint-disable-next-line no-restricted-imports -- 测试要拿契约表当预期值，权威判定在 scripts/check-boundaries.mjs
import { CAPABILITY_META } from "@haruyuki/protocol";
import type { CapabilityName } from "@haruyuki/protocol";
import { describe, expect, it } from "vitest";

import { en } from "../i18n/locales/en.js";
import { zhCN } from "../i18n/locales/zh-CN.js";
import {
  CAPABILITY_DESCRIPTORS,
  CAPABILITY_FAMILIES,
  COMMAND_DESCRIPTOR_LIST,
  descriptorFor,
  filterDescriptors,
} from "./descriptors.js";

/** Names the surface offers: everything except the bidirectional legacy body. */
const EXPECTED: readonly string[] = (Object.keys(CAPABILITY_META) as CapabilityName[])
  .filter((name) => (CAPABILITY_META[name] as { readonly legacy?: true }).legacy !== true)
  .sort((left, right) => left.localeCompare(right));

describe("CAPABILITY_DESCRIPTORS", () => {
  it("covers exactly the capabilities the surface offers", () => {
    expect(COMMAND_DESCRIPTOR_LIST.map((row) => row.name)).toEqual(EXPECTED);
    expect(Object.keys(CAPABILITY_DESCRIPTORS)).toEqual(EXPECTED);
  });

  it("keeps every descriptor key in both locales", () => {
    const englishKeys = new Set(Object.keys(en));
    const chineseKeys = new Set(Object.keys(zhCN));
    const wanted = new Set<string>();

    for (const row of COMMAND_DESCRIPTOR_LIST) {
      wanted.add(row.labelKey);
      wanted.add(row.descKey);
    }

    for (const family of CAPABILITY_FAMILIES) {
      wanted.add(family.nameKey);
    }

    const missingEnglish = [...wanted].filter((key) => !englishKeys.has(key));
    const missingChinese = [...wanted].filter((key) => !chineseKeys.has(key));

    expect(missingEnglish).toEqual([]);
    expect(missingChinese).toEqual([]);
  });

  it("declares no command copy the table cannot reach (no orphans)", () => {
    const wanted = new Set<string>();

    for (const row of COMMAND_DESCRIPTOR_LIST) {
      wanted.add(row.labelKey);
      wanted.add(row.descKey);
    }

    for (const family of CAPABILITY_FAMILIES) {
      wanted.add(family.nameKey);
    }

    // Both directions matter: a missing key breaks a row, and an orphan key is
    // copy nobody can reach -- the i18n gate cannot see these (they are built
    // from a table), so this assertion is the only thing that keeps a renamed
    // command from leaving its old copy behind forever.
    const orphans = [...new Set([...Object.keys(en), ...Object.keys(zhCN)])]
      .filter((key) => key.startsWith("page.command."))
      .filter((key) => !wanted.has(key));

    expect(orphans).toEqual([]);
  });

  it("uses four segments at most", () => {
    const keys = [
      ...COMMAND_DESCRIPTOR_LIST.flatMap((row) => [row.labelKey, row.descKey]),
      ...CAPABILITY_FAMILIES.map((family) => family.nameKey),
    ];

    for (const key of keys) {
      expect(key.split(".").length).toBeLessThanOrEqual(4);
    }
  });

  it("searches ASCII only", () => {
    for (const row of COMMAND_DESCRIPTOR_LIST) {
      for (const key of row.searchKeys) {
        expect(key).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  it("prefix matches rank before inner matches", () => {
    const results = filterDescriptors("s");
    const prefixHits = results.filter((row) => row.searchKeys.some((key) => key.startsWith("s")));
    const innerHits = results.filter((row) => !row.searchKeys.some((key) => key.startsWith("s")));

    // Every prefix hit must come before every inner hit, not merely first.
    expect(prefixHits.length).toBeGreaterThan(0);
    expect(innerHits.length).toBeGreaterThan(0);
    expect(results.slice(0, prefixHits.length)).toEqual(prefixHits);
  });

  it("groups every descriptor under exactly one family", () => {
    const grouped = CAPABILITY_FAMILIES.flatMap((family) => family.descriptors);

    expect(grouped).toHaveLength(COMMAND_DESCRIPTOR_LIST.length);
    expect(new Set(grouped.map((row) => row.name)).size).toBe(COMMAND_DESCRIPTOR_LIST.length);
  });

  it("looks a row up by name without a non-null assertion", () => {
    expect(descriptorFor("agent.get")?.name).toBe("agent.get");
    expect(descriptorFor("agent.notAThing" as CapabilityName)).toBeUndefined();
  });

  it("does not hand out the module's own array to a caller", () => {
    expect(filterDescriptors("")).not.toBe(COMMAND_DESCRIPTOR_LIST);
    expect(filterDescriptors("   ")).not.toBe(COMMAND_DESCRIPTOR_LIST);
  });
});
