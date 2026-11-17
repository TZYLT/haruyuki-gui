/**
 * Generate the command parameter table that `packages/ui/src/command/` ships.
 *
 * Source of truth is the contract snapshot that `scripts/contract/cli.mjs` produces; this
 * script only reshapes it for the command surface. `--check` regenerates in
 * memory and fails on any difference, so a snapshot bump cannot leave the table
 * stale (the command surface never keeps a second copy of names).
 *
 * Usage:
 *   node scripts/generate-command-params.mjs           # write
 *   node scripts/generate-command-params.mjs --check    # verify only
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const SNAPSHOT = path.join(REPO_ROOT, "packages", "protocol", "src", "contract", "snapshot.json");
const CAPABILITIES = path.join(
  REPO_ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "capabilities.json",
);
const OUTPUT = path.join(REPO_ROOT, "packages", "ui", "src", "command", "params.generated.ts");

/** Fields the transport owns; they never appear as a command argument. */
const ENVELOPE_FIELDS = new Set(["type", "request_id", "runtime"]);

/**
 * Classify one wire field type into the small vocabulary the command panel
 * renders. Unknown shapes stay `"value"` rather than guessing a control.
 *
 * @param {string} type wire type text from the snapshot
 * @returns {string}
 */
function kindOf(type) {
  const text = type.trim();

  if (text === "string") return "string";
  if (text === "boolean") return "boolean";
  if (text === "number") return "number";
  if (text.startsWith('"') || text.includes(" | ")) {
    const options = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    return options.length > 0 ? "enum" : "value";
  }
  if (text.endsWith("[]") || text.startsWith("readonly ") || text.startsWith("Array<")) {
    return "list";
  }
  if (text.startsWith("{") || text.startsWith("Record<") || text.includes("interface")) {
    return "object";
  }

  return "value";
}

/**
 * Enum members of a union type, or null when the field is not an enumeration.
 *
 * @param {string} type wire type text
 * @returns {string[] | null}
 */
function optionsOf(type) {
  if (!type.includes('"')) return null;

  const options = [...type.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  return options.length > 0 ? options : null;
}

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const capabilities = JSON.parse(readFileSync(CAPABILITIES, "utf8")).capabilities;
const commandByWire = new Map(snapshot.commands.map((command) => [command.wire, command]));

/** @type {string[]} */
const lines = [
  "/**",
  " * Command parameter table, generated from the contract snapshot.",
  " *",
  " * Do not edit by hand: `node scripts/generate-command-params.mjs` rewrites it,",
  " * and `--check` fails when it drifts from `snapshot.json`.",
  " */",
  'import type { CapabilityName } from "@haruyuki/protocol";',
  "",
  '/** Controls a parameter renders as; `value` means "open the detail panel". */',
  "export type CommandParamKind =",
  '  | "string"\n  | "boolean"\n  | "number"\n  | "enum"\n  | "list"\n  | "object"\n  | "value";',
  "",
  "export interface CommandParamSpec {",
  "  readonly name: string;",
  "  readonly kind: CommandParamKind;",
  "  readonly required: boolean;",
  "  readonly options?: readonly string[];",
  "}",
  "",
  "/**",
  " * Per-capability arguments, envelope fields excluded (`type`, `request_id`,",
  " * `runtime`). A capability with no arguments is absent, not empty.",
  " */",
  "export const COMMAND_PARAMS = {",
];

for (const capability of capabilities) {
  const command = commandByWire.get(capability.wire);
  const fields = (command?.fields ?? []).filter((field) => !ENVELOPE_FIELDS.has(field.name));

  if (fields.length === 0) {
    continue;
  }

  lines.push(`  ${JSON.stringify(capability.name)}: [`);

  for (const field of fields) {
    const kind = kindOf(field.type);
    const options = optionsOf(field.type);
    const parts = [
      `name: ${JSON.stringify(field.name)}`,
      `kind: ${JSON.stringify(kind)}`,
      `required: ${field.optional === true ? "false" : "true"}`,
    ];

    if (options !== null) {
      parts.push(`options: [${options.map((option) => JSON.stringify(option)).join(", ")}]`);
    }

    lines.push(`    { ${parts.join(", ")} },`);
  }

  lines.push("  ],");
}

lines.push("} as const satisfies Partial<Record<CapabilityName, readonly CommandParamSpec[]>>;");

const body = lines.join("\n");
const output = body.endsWith("\n") ? body : `${body}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUTPUT, "utf8");

  if (current !== output) {
    console.error(
      `generate-command-params: ${path.relative(REPO_ROOT, OUTPUT)} is stale; run without --check`,
    );
    process.exit(1);
  }

  console.log("generate-command-params: up to date");
} else {
  writeFileSync(OUTPUT, output);
  console.log(`generate-command-params: wrote ${path.relative(REPO_ROOT, OUTPUT)}`);
}
