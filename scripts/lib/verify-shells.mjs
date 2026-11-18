/**
 * The VS Code shell's own segments for `verify`.
 *
 * Two of them, because `pnpm typecheck` and `pnpm test` are workspace-wide and
 * print a file path with no owner: a failure there makes the reader work out
 * which package it belongs to. These repeat the work filtered by package name, so
 * the verdict line names the shell.
 *
 * The build segment exists for a reason the typecheck cannot cover: the extension
 * host entry is bundled to CommonJS by `apps/vscode/scripts/build.mjs`, and a
 * bundle that fails to build -- a missing entry, an `import.meta` that only ESM
 * has, a dependency that cannot be inlined -- compiles cleanly and then fails at
 * load time in the editor. Running the build under `verify` is what turns "the
 * shell compiles" into "the shell produces the artifact VS Code loads".
 *
 * Why every segment is derived from the tree rather than always present: the
 * aggregator's own self-tests assemble the segment list against a disposable stub
 * checkout that contains no `apps/` at all. A segment for a package that is not
 * there contributes a required input, which the aggregator refuses before the
 * first segment runs -- so a hardcoded entry would make `scripts/verify.test.ts`
 * red for a reason that has nothing to do with it.
 *
 * The build segment additionally requires the entry it builds: `extension.ts` is
 * the whole point of that step, and a checkout that has the package but not the
 * entry would fail the segment for work that is not its own.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** The shell's directory, package name and bundler entry; all three are asserted by gates. */
const SHELL = {
  dir: "apps/vscode",
  package: "@haruyuki/vscode",
  entry: "apps/vscode/src/extension.ts",
};

/**
 * @param {string} root absolute repository root
 * @param {string} relative repo-relative posix path
 * @returns {boolean} whether the checkout contains it
 */
function present(root, relative) {
  return existsSync(path.join(root, ...relative.split("/")));
}

/**
 * The typecheck segment for this shell, or none when the checkout lacks it.
 *
 * @param {string} root Absolute repository root.
 * @returns {Array<{ label: string, command: () => { command: string, args: string[] } }>}
 */
export function shellTypecheckSegments(root) {
  if (!present(root, path.join(SHELL.dir, "package.json"))) return [];

  return [
    {
      label: "vscode typecheck",
      command: () => ({ command: "pnpm", args: ["--filter", SHELL.package, "typecheck"] }),
    },
  ];
}

/**
 * The bundling segment for this shell, or none when it has no entry yet.
 *
 * The entry is a prerequisite rather than an assumption: without it
 * `scripts/build.mjs` reports a missing target by design, and a segment that
 * always failed would say the shell is broken when the work is simply not there.
 *
 * @param {string} root Absolute repository root.
 * @returns {Array<{ label: string, command: () => { command: string, args: string[] } }>}
 */
export function shellBuildSegments(root) {
  if (!present(root, SHELL.entry)) return [];

  return [
    {
      label: "vscode build",
      command: () => ({ command: "pnpm", args: ["--filter", SHELL.package, "build"] }),
    },
  ];
}
