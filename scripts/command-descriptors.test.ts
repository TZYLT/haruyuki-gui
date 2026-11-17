/**
 * The command surface must not keep a second copy of capability names.
 *
 * This lives outside `packages/ui` on purpose: the check reads a source file
 * from disk, and the renderer may not import Node builtins (R4). The rule it
 * enforces is about the renderer's source, not about renderer code.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DESCRIPTORS = path.join(REPO_ROOT, "packages", "ui", "src", "command", "descriptors.ts");
const GENERATED_PARAMS = path.join(
  REPO_ROOT,
  "packages",
  "ui",
  "src",
  "command",
  "params.generated.ts",
);

describe("command surface name discipline", () => {
  it("writes no family.action literal in descriptors.ts", () => {
    const source = readFileSync(DESCRIPTORS, "utf8");
    const literals = source.match(/"[a-z_]+\.[a-z_]+"/g) ?? [];

    expect(literals).toEqual([]);
  });

  it("takes its names from the protocol's generated table", () => {
    const source = readFileSync(DESCRIPTORS, "utf8");

    expect(source).toContain("CAPABILITY_META");
    expect(source).toMatch(/from "@haruyuki\/protocol"/);
  });

  it("keeps the generated parameter table free of hand-written rows", () => {
    const source = readFileSync(GENERATED_PARAMS, "utf8");

    expect(source).toContain("generated from the contract snapshot");
    expect(source).toContain("satisfies Partial<Record<CapabilityName");
  });
});
