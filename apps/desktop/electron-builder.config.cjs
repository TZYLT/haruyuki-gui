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

/**
 * Icon files, resolved through `buildResources` (`build/`).
 *
 * These are PLACEHOLDERS, drawn by `scripts/make-placeholder-icons.mjs`: a
 * neutral rounded square with a dashed frame and a capital H. They are not a
 * brand mark, and they are deliberately not the Electron default icon either --
 * the whole point of having them is that the package no longer ships the stock
 * Electron icon, and that "which icon did we ship" can be answered from source.
 *
 * When real artwork arrives, replace `build/icon.png`, `build/icon.ico` and
 * `build/icon.icns` with the same file names. Nothing in this file needs to
 * change, because these paths point at the files, not at the generator.
 * Regenerating the placeholders is one command and is byte-reproducible, so the
 * generator is safe to delete once real artwork is in place.
 */
const ICON_PNG = path.join(PACKAGE_DIR, "build", "icon.png");
const ICON_ICO = path.join(PACKAGE_DIR, "build", "icon.ico");
const ICON_ICNS = path.join(PACKAGE_DIR, "build", "icon.icns");

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
  // `icon` is set per platform rather than at the top level: the formats are not
  // interchangeable, and a single value would be converted for the other
  // platforms at build time -- silently, and with whatever sizes the converter
  // decides are enough.
  files: ["dist/**/*", "!dist/probe/**", "!node_modules/**", "package.json", "runtime-lock.json"],
  extraMetadata: {
    main: "dist/main/main.cjs",
  },
  // The three legal documents at the repository root, copied to the package
  // root -- the directory the user unzipped, which is where the about window
  // opens them from when packaged.
  //
  // `extraFiles`, not `files`: `files` is relative to this package directory
  // and everything it selects is packed *into* `app.asar`, whose root is
  // `resources/app`. Reaching the repository root from there is impossible --
  // the walk starts at `apps/desktop` and never leaves it, and a destination
  // inside the archive is not the package root. `extraFiles` copies to the
  // app's content directory (`win-unpacked/` on Windows), which is exactly the
  // directory the three documents have to be in.
  extraFiles: [
    {
      from: REPO_ROOT,
      to: ".",
      filter: ["LICENSE", "NOTICE", "THIRD-PARTY"],
    },
  ],
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
    // The multi-size `.ico` is what Windows reads: the executable's icon
    // resource is replaced wholesale, and the shell picks the closest size for
    // the task bar, Alt-Tab and Explorer. `.png` here would be converted, and
    // the conversion would have to guess which sizes to keep.
    icon: ICON_ICO,
    // `dir` stays in the list: G1's exit is "a tree that starts", and the tree
    // is what the smoke test launches. `zip` is the download.
    target: ["dir", "zip"],
  },
  linux: {
    // AppImage wants a PNG; 512x512 is enough for the `.desktop` entry and the
    // window icon, and the AppImage builder re-encodes it into the icon theme
    // sizes it needs.
    icon: ICON_PNG,
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
  // macOS is not a target today, but the icon exists because the resource
  // directory is format-complete: leaving `.icns` out would make "the icons are
  // placeholders" true only on the platforms we happen to build.
  mac: {
    icon: ICON_ICNS,
  },
};
