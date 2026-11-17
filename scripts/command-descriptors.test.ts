/**
 * The command surface must not keep a second copy of capability names.
 *
 * Two different claims live here, and each has its own failure mode:
 *
 * 1. `descriptors.ts` contains no `family.action` literal, and the parameter
 *    table is *derived* from the snapshot rather than transcribed. The earlier
 *    version asserted the presence of two comment strings, which a hand-copied
 *    table could also satisfy; this one compares the generated key set against
 *    the snapshot's command fields, so a hand-written row reds.
 * 2. The check reads files, so it lives outside `packages/ui` (the renderer may
 *    not import Node builtins, R4). The rule is about the renderer's source,
 *    not about renderer code.
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
const SNAPSHOT = path.join(REPO_ROOT, "packages", "protocol", "src", "contract", "snapshot.json");

/** Envelope fields the transport owns; they never become command arguments. */
const ENVELOPE = new Set(["type", "request_id", "runtime"]);

/** Capability keys the generated table must declare: those with arguments. */
function expectedParameterKeys(): string[] {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
    commands: Array<{ wire: string; fields: Array<{ name: string }> }>;
  };
  const capabilities = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "packages/protocol/src/contract/capabilities.json"), "utf8"),
  ) as { capabilities: Array<{ name: string; wire: string }> };
  const byWire = new Map(snapshot.commands.map((command) => [command.wire, command]));
  const keys: string[] = [];

  for (const capability of capabilities.capabilities) {
    const fields = (byWire.get(capability.wire)?.fields ?? []).filter(
      (field) => !ENVELOPE.has(field.name),
    );

    if (fields.length > 0) {
      keys.push(capability.name);
    }
  }

  return keys.sort();
}

describe("command surface name discipline", () => {
  it("writes no family.action literal in descriptors.ts", () => {
    const source = readFileSync(DESCRIPTORS, "utf8");
    const literals = source.match(/"[a-z_]+\.[a-z_]+"/g) ?? [];

    expect(literals).toEqual([]);
  });

  it("takes its names from the protocol's generated table", () => {
    const source = readFileSync(DESCRIPTORS, "utf8");

    expect(source).toMatch(/import \{[^}]*CAPABILITY_META[^}]*\} from "@haruyuki\/protocol"/);
  });

  it("derives one parameter row per command that has arguments", () => {
    const source = readFileSync(GENERATED_PARAMS, "utf8");
    const declared = [...source.matchAll(/^  "([a-z_]+\.[a-zA-Z]+)": [[{]/gm)].map(
      (match) => match[1] as string,
    );

    expect([...declared].sort()).toEqual(expectedParameterKeys());
  });
});
