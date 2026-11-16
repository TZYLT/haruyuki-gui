/**
 * Build the main process and the preload, one entry per Vite invocation.
 *
 * Two invocations rather than one, because a single build with two inputs shares
 * `bridge.ts` into `chunks/`, and a chunked preload does not load under `sandbox: true` --
 * see the comment in `vite.main.mts` for the failure that produced.
 *
 * A script rather than `&&` in `package.json` with `cross-env`, because setting an
 * environment variable portably is not worth adding a dependency for, and `&&` chains in a
 * script field are where build steps go to be unreadable.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

/** This script's directory (`apps/desktop/scripts`). */
const SCRIPT_DIR = import.meta.dirname;

/** The package directory, one level up. */
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");

/** The two entries, in order: `main` clears the output directory, `preload` fills it. */
const ENTRIES = ["main", "preload"];

for (const entry of ENTRIES) {
  process.stdout.write(`\n=== building ${entry} ===\n`);

  const result = spawnSync(
    process.execPath,
    // Resolved from the repository root: pnpm keeps `vite` there, not under
    // `apps/desktop/node_modules`. `PACKAGE_DIR` is `apps/desktop`, so two levels up.
    [
      path.join(PACKAGE_DIR, "..", "..", "node_modules", "vite", "bin", "vite.js"),
      "build",
      "--config",
      "vite.main.mts",
    ],
    {
      cwd: PACKAGE_DIR,
      // The one thing that differs between the two passes. Everything else is in the
      // config file, where it cannot drift.
      env: { ...process.env, HARUYUKI_BUILD_ENTRY: entry },
      stdio: "inherit",
      // `.cmd` shims need a shell on Windows; `process.execPath` with a `.js` path does
      // not, which is why vite is invoked through node rather than through `vite`.
      shell: false,
    },
  );

  if (result.status !== 0) {
    process.stderr.write(`\nbuild failed for ${entry}\n`);
    process.exit(result.status ?? 1);
  }
}
