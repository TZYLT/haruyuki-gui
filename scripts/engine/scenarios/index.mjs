#!/usr/bin/env node
/**
 * index - the scenario catalogue for the real-engine wire recorder.
 *
 * Order is order of value: cheapest and most reliable first, most likely to be
 * blocked last. Every entry is the same `{ name, description, commands }` shape,
 * and `commands` is exactly the array `record.mjs --send` expects, so a scenario
 * file is the single source of truth for a recording.
 *
 * Usage:
 *   node scripts/engine/scenarios/index.mjs --list
 *   node scripts/engine/scenarios/index.mjs --emit terminal
 *     [--out _research/engine-raw/terminal.cmd.json]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import approval from "./approval.mjs";
import compaction from "./compaction.mjs";
import memory from "./memory.mjs";
import subagent from "./subagent.mjs";
import terminal from "./terminal.mjs";
import toolCall from "./tool-call.mjs";
import userMessage from "./user-message.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SEND_ROOT = path.join(REPO_ROOT, "_research", "engine-raw");

/** Catalogue in delivery order; every scenario lives beside the recorder. */
export const scenarios = [terminal, memory, userMessage, toolCall, approval, subagent, compaction];

/** Look one scenario up by its `name`, or null. */
export function scenarioByName(name) {
  return scenarios.find((scenario) => scenario.name === name) ?? null;
}

/** Serialised `--send` payload for one scenario. */
export function toSendJson(scenario) {
  return `${JSON.stringify(scenario.commands, null, 2)}\n`;
}

/** Default `--send` path for a scenario, under the gitignored raw root. */
export function sendPathFor(scenario) {
  return path.join(SEND_ROOT, `${scenario.name}.cmd.json`);
}

/** CLI: --list prints the catalogue, --emit writes the --send JSON file. */
function main(argv) {
  const flag = (name) => {
    const index = argv.indexOf(name);
    return index === -1 ? null : (argv[index + 1] ?? null);
  };
  if (argv.includes("--list") || argv.length === 0) {
    for (const scenario of scenarios)
      process.stdout.write(`${scenario.name}: ${scenario.description}\n`);
    return 0;
  }
  const name = flag("--emit");
  const scenario = name === null ? null : scenarioByName(name);
  if (scenario === null) {
    process.stderr.write(`unknown scenario: ${String(name)}\n`);
    return 2;
  }
  const target = path.resolve(process.cwd(), flag("--out") ?? sendPathFor(scenario));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, toSendJson(scenario));
  process.stdout.write(`${target}\n`);
  return 0;
}

const entry =
  process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (entry === import.meta.url) process.exitCode = main(process.argv.slice(2));

export default scenarios;
