/**
 * The VS Code shell's own typecheck segment for `verify`.
 *
 * `pnpm typecheck` runs the root script, which is `pnpm -r typecheck`: that
 * already compiles this shell. The segment repeats it filtered, because a failure
 * in the workspace-wide run prints a file path and nothing else, and the reader
 * then has to work out which package owns it. This one puts the shell's name on
 * the verdict line.
 *
 * Why it is derived from the tree rather than always present: the aggregator's
 * own self-tests assemble the segment list against a disposable stub checkout
 * that contains no `apps/` at all. A segment for a package that is not there
 * contributes a required input, which the aggregator refuses before the first
 * segment runs -- so a hardcoded entry would make `scripts/verify.test.ts` red
 * for a reason that has nothing to do with it.
 *
 * Why there is no build segment here: the extension host entry
 * `apps/vscode/src/extension.ts` does not exist yet, and a segment that fails on
 * a missing source file would turn verify red for work that has not been done
 * rather than for something broken. `pnpm vscode:build` is the by-hand route, and
 * a build segment belongs here once that entry lands and builds its two bundles.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** The shell's directory and its package name; `pnpm --filter` matches the name. */
const SHELL = { dir: "apps/vscode", package: "@haruyuki/vscode" };

/**
 * The typecheck segment for this shell, or none when the checkout lacks it.
 *
 * @param {string} root Absolute repository root.
 * @returns {Array<{ label: string, command: () => { command: string, args: string[] } }>}
 */
export function shellTypecheckSegments(root) {
  if (!existsSync(path.join(root, SHELL.dir, "package.json"))) return [];

  return [
    {
      label: "vscode typecheck",
      command: () => ({ command: "pnpm", args: ["--filter", SHELL.package, "typecheck"] }),
    },
  ];
}
