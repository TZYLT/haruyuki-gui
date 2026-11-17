/**
 * electron-builder configuration for the Windows unpacked package (G1).
 *
 * The package's own `main` stays `src/index.ts` for `pnpm start` during
 * development; only the packaged app.asar points at the built CommonJS bundle
 * through `extraMetadata.main`. Rewriting the source package.json instead would
 * make every dev launch depend on a build.
 *
 * Three layout decisions are deliberate:
 *
 *   `files` is an allowlist. The main and renderer bundles already contain their
 *   dependencies, so `node_modules` does not belong in app.asar; the probe
 *   bundles under `dist/probe` are test-only and stay out.
 *
 *   `runtime-lock.json` is inside app.asar (listed in `files`), while the engine
 *   and watchdog are `extraResources` -- real files, spawnable, and outside the
 *   archive the engine cannot execute from.
 *
 *   `--dir` only. Zip/AppImage/Release publishing belongs to G2; G1's exit is
 *   "a win-unpacked tree that starts".
 */

const path = require("node:path");

/** This package directory (`apps/desktop`). */
const PACKAGE_DIR = __dirname;

/** Repository root, two levels up. */
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.haruyuki.gui",
  productName: "Haruyuki",
  executableName: "Haruyuki",
  electronVersion: "45.3.2",
  electronDist: path.join(REPO_ROOT, "node_modules", "electron", "dist"),
  npmRebuild: false,
  asar: true,
  directories: {
    output: path.join(PACKAGE_DIR, "release"),
    buildResources: path.join(PACKAGE_DIR, "build"),
  },
  files: ["dist/**/*", "!dist/probe/**", "!node_modules/**", "package.json", "runtime-lock.json"],
  extraMetadata: {
    main: "dist/main/main.cjs",
  },
  extraResources: [
    {
      // `from: runtime/engine` loses `node_modules` because electron-builder's
      // filter drops `node_modules` at the root of every `from` directory. Copy
      // the parent (`runtime/`) and select `engine/**`, so the engine's
      // `node_modules` is a child path and survives.
      from: path.join(PACKAGE_DIR, "runtime"),
      to: ".",
      filter: ["engine/**/*"],
    },
    {
      from: path.join(PACKAGE_DIR, "runtime", "watchdog.cjs"),
      to: "runtime/watchdog.cjs",
    },
  ],
  // Artifact names come from here, and `release.mjs` reads the output directory
  // rather than assembling these strings -- but a name that the release
  // checklist and the Release body both quote has to be stable, so it is
  // written down once, in one place.
  // `${name}` expands to the scoped package name (`@haruyuki/desktop`), which
  // is why the first build produced `release/@haruyuki/desktop-...zip` -- a
  // nested directory in the download. `productName` is the name a user sees.
  artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
  win: {
    // `dir` stays in the list: G1's exit is "a tree that starts", and the tree
    // is what the smoke test launches. `zip` is the download.
    target: ["dir", "zip"],
  },
  linux: {
    // AppImage is the single-file Linux download. It needs no maintainer
    // scripts and runs without an install step, which matches "download and
    // start" for a desktop app that has no system integration to set up.
    //
    // `desktopName` is not a key in this schema version -- it was rejected by
    // the validator, and the launch name now lives in `desktop.entry.Name`.
    target: ["AppImage"],
    category: "Development",
    desktop: {
      entry: {
        Name: "Haruyuki",
      },
    },
  },
};
