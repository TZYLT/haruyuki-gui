import { describe, expect, it } from "vitest";

import { checkHeaderFields, KNOWN_HEADER_KEYS } from "./fixture-header.mjs";

const header = (extra: Record<string, unknown>) => ({ kind: "wire", schemaVersion: 1, ...extra });

describe("header-field reporting", () => {
  it("says nothing about the fields the format defines", () => {
    const warnings: string[] = [];
    checkHeaderFields(
      "a.jsonl",
      header({ scenario: "x", redaction: "r2", clock: "real" }),
      warnings,
    );

    expect(warnings).toEqual([]);
  });

  it("reports an unknown field with its type and size, and rejection is not the point", () => {
    const warnings: string[] = [];
    checkHeaderFields("a.jsonl", header({ origin: "hand-written", extra: 7 }), warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("note a.jsonl:1");
    expect(warnings[0]).toContain("origin (string, 12 chars)");
    expect(warnings[0]).toContain("extra (number)");
  });

  it("treats a near-miss as a typo rather than a new field", () => {
    // A mistyped field makes the rule that field was meant to satisfy report
    // something else, so the diagnostic has to name the spelling.
    const warnings: string[] = [];
    checkHeaderFields("a.jsonl", header({ redaction_: "r2" }), warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WARN a.jsonl:1 header-field near "redaction"');
    expect(warnings[0]).toContain('does not read "redaction_"');
  });

  it("does not mistake a genuinely new field for a typo", () => {
    const warnings: string[] = [];
    checkHeaderFields("a.jsonl", header({ originReason: "because" }), warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.startsWith("note ")).toBe(true);
  });

  it("keeps the known set free of fields the gate does not read", () => {
    // If a field the gate never reads were dropped from the set, every ordinary
    // fixture would report a note and the real news would be buried.
    expect(KNOWN_HEADER_KEYS.has("scenario")).toBe(true);
    expect(KNOWN_HEADER_KEYS.has("origin")).toBe(false);
  });
});
