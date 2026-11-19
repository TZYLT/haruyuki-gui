/**
 * Reading the facts a failure page shows out of the resolver's answer.
 *
 * The resolver speaks in sentences because a log line is read by a person; the
 * page shows lists because a list is what a user can act on. This module is the
 * one place those two forms meet, so no rendering code ever parses prose and no
 * sentence is reworded without the lists following it.
 *
 * It was carved out of the controller when that file reached its line budget.
 * The split is by responsibility and not by size: everything here is pure, takes
 * data in and returns data out, and has no idea that a process or a panel
 * exists.
 */

import type { RuntimeFailureKind } from "../core/ipc.js";

/**
 * How a refusal from `./engine-source.ts` is reported in the runtime's words.
 *
 * The resolver answers in the terms of its search; the panel's failure kinds are
 * the runtime's. This table is the whole translation, so the two vocabularies
 * meet in exactly one place.
 *
 * `version-unknown` keeps its own kind rather than folding into `missing-engine`:
 * a folder that is there and cannot say what version it is would otherwise be
 * reported as a folder that does not exist, which names the wrong problem and
 * hides the one fact that explains it.
 */
const FAILURE_FOR_REASON: Readonly<Record<string, RuntimeFailureKind>> = {
  missing: "missing-engine",
  "invalid-dir": "invalid-dir",
  "version-unknown": "version-unknown",
};

/**
 * The failure kind one resolver reason maps to.
 *
 * An unrecognised reason is a discovery failure by default: a page that says
 * "not found" is wrong but harmless, where a page that throws during a failure
 * is the worst possible moment for it.
 *
 * @param reason a reason from the resolver
 * @returns the runtime failure kind
 */
export function failureKindFor(reason: string): RuntimeFailureKind {
  return FAILURE_FOR_REASON[reason] ?? "missing-engine";
}

/**
 * Split one failure sentence back into the entries it named.
 *
 * The resolver builds its sentence as `<dir>: <entry> is missing, <entry> is not
 * a directory`, and that list is exactly the repair list a user needs. It is
 * read here -- once, at the boundary -- rather than in the page, so no rendering
 * code parses prose. A sentence that does not have the shape yields nothing
 * instead of guessing.
 *
 * @param detail the resolver's sentence, when there is one
 * @returns the entries, without the `is missing` / `is not a ...` tails
 */
export function missingEntriesOf(detail: string | undefined): {
  missingEntries?: readonly string[];
} {
  if (detail === undefined) return {};

  const entries = new Set<string>();

  for (const match of detail.matchAll(/\b([\w.-]+) is (?:missing|not a [a-z]+)\b/g)) {
    if (match[1] !== undefined && match[1].length > 0) entries.add(match[1]);
  }

  return entries.size === 0 ? {} : { missingEntries: [...entries] };
}

/**
 * The places worth showing a user who has to go and find the engine.
 *
 * Deliberately NOT every directory the resolver walks. `PATH` on a real machine
 * holds dozens of directories that have nothing to do with engines -- `system32`,
 * a CUDA toolkit, a Java install -- and the resolver only looks for an engine
 * package *inside* each one. Listing those inputs would tell the user the shell
 * read an environment variable, which is not something they can act on, and would
 * bury the one entry they chose themselves under that noise.
 *
 * What is left is exactly what a user can act on:
 *
 * 1. the `enginePath` value they set -- the one line they own, so it leads;
 * 2. every directory that was actually opened and refused, which is the folder
 *    to go and repair.
 *
 * Both arrive as data. The refused directories used to be read back out of the
 * resolver's sentence with a line-anchored pattern, which could never match:
 * every note begins with prose ("the picked directory does not name a usable
 * engine: ..."), never with a path. The list was therefore always just the
 * configured value, and the one useful entry never appeared.
 *
 * @param configured the `enginePath` value the shell read, when one is set
 * @param inspected the directories the resolver opened and refused
 * @returns the paths to show, or nothing when there are none worth showing
 */
export function searchedPathsOf(
  configured: string | undefined,
  inspected: readonly string[] | undefined,
): { searchedPaths?: readonly string[] } {
  const paths: string[] = [];

  if (configured !== undefined && configured.trim() !== "") paths.push(configured.trim());

  for (const dir of inspected ?? []) paths.push(dir);

  const unique = [...new Set(paths.filter((path) => path !== ""))];

  return unique.length === 0 ? {} : { searchedPaths: unique };
}
