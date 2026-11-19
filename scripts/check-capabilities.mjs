#!/usr/bin/env node
/**
 * Capability names must not be copied into the desktop shell.
 *
 * The shell reaches capabilities through the command envelope, never by naming
 * one: adding a capability must not require a shell change. A string literal in
 * `apps/desktop/src` that equals a real capability name is therefore a shell
 * wiring smell.
 *
 * There is one deliberate exception: the command sample page. It has to name a
 * request/response command and an untracked command to demonstrate the two
 * completion shapes. The exception is per FILE, and every capability-shaped
 * literal in an excepted file is still checked against `capabilities.json`, so
 * the exception cannot hide a misspelling.
 *
 * Exit 0 clean, 1 violations, 2 the gate itself could not run.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = path.join(ROOT, "apps", "desktop", "src");
const CAPABILITIES = path.join(
  ROOT,
  "packages",
  "protocol",
  "src",
  "contract",
  "capabilities.json",
);
const ALLOWLIST = new Map([
  ["apps/desktop/src/renderer/CommandSample.tsx", ["device.info", "terminal.kill"]],
]);
const SOURCE = /\.(ts|tsx)$/;

/** @param dir directory @returns files below it, recursively */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : walk(full);

    return SOURCE.test(entry.name) ? [full] : [];
  });
}

/** @param text source @returns {literal, line} for every quoted literal */
function literals(text) {
  const found = [];
  const pattern = /(["'`])((?:\\.|(?!\1).)*)\1/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const line = text.slice(0, match.index).split(/\r?\n/).length;

    found.push({ literal: match[2], line });
  }

  return found;
}

const table = JSON.parse(readFileSync(CAPABILITIES, "utf8"));
const known = new Set(table.capabilities.map((item) => item.name));
const violations = [];
let allowed = 0;

for (const file of walk(DESKTOP)) {
  const relative = path.relative(ROOT, file).split(path.sep).join("/");
  const text = readFileSync(file, "utf8");
  const expected = ALLOWLIST.get(relative);
  const seen = new Set();

  for (const item of literals(text)) {
    if (expected !== undefined) {
      if (!expected.includes(item.literal)) continue;

      seen.add(item.literal);

      if (!known.has(item.literal)) {
        violations.push(
          `${relative}:${String(item.line)} allowlisted capability "${item.literal}" is not in capabilities.json`,
        );
      } else {
        allowed += 1;
      }

      continue;
    }

    if (!known.has(item.literal)) continue;

    violations.push(
      `${relative}:${String(item.line)} capability name "${item.literal}" belongs in the command layer`,
    );
  }

  if (expected !== undefined) {
    for (const name of expected) {
      if (!seen.has(name)) {
        violations.push(`${relative} allowlists "${name}" but the file no longer names it`);
      }
    }
  }
}

if (allowed === 0) {
  violations.push("the allowlist matched no capability literals; remove a stale exception");
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`FAIL ${violation}`);
  console.error(`FAIL: ${String(violations.length)} violation(s)`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS: ${String(allowed)} capability literals, all in capabilities.json, all in the sample allowlist`,
  );
}
