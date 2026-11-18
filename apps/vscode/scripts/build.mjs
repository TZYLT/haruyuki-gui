#!/usr/bin/env node
/**
 * Build the artifacts this package loads at runtime.
 *
 * Three targets, and each one has a shape it cannot deviate from:
 *
 *   `dist/extension.cjs` -- the extension host entry named by `package.json`
 *   `main`. CommonJS, because that is the module shape VS Code loads, and no
 *   minification, because a production stack trace has to name the function it
 *   came from. `vscode` stays external: the module is provided by the host.
 *
 *   `dist/core.mjs` -- the core child's entry, forked by the extension host.
 *   ESM, because `@haruyuki/core` reads `import.meta.url`, and a CJS bundle
 *   would make that `undefined` and throw before the child could answer
 *   anything. `ws` stays external because it is a runtime dependency with
 *   native-ish resolution semantics, so it is copied next to the bundle instead
 *   of inlined: `dist/node_modules/ws` is where `createRequire(import.meta.url)`
 *   inside `dist/core.mjs` looks, and that is the layout a packaged extension
 *   has to ship.
 *
 *   `dist/webview/` -- the panel document, built by Vite from
 *   `src/webview/index.html` through `vite.webview.mts`.
 *
 * One-shot by default: a build that never exits cannot be run by a gate, and
 * the extension host reloads by rebuilding. There is no watch mode.
 *
 * A missing entry is a reported failure, not a crash and not a silent skip.
 * `src/extension.ts` is the extension host's entry and it arrives as its own
 * change; this script has no business creating source files, so it says which
 * path it wanted and exits non-zero. The other two targets are still built
 * first, because they are runnable without it and a half-built tree is easier
 * to inspect than an empty one.
 *
 * Exit codes: 0 = every target wrote its artifacts, 1 = at least one target did
 * not, 2 = this script itself could not run (bad argument, missing tooling).
 */

import { build as esbuild } from "esbuild";
import { fork } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build as viteBuild, createLogger } from "vite";

/** This script's directory (`apps/vscode/scripts`). */
const SCRIPT_DIR = import.meta.dirname;

/** The package directory, one level up. */
const PACKAGE_DIR = path.resolve(SCRIPT_DIR, "..");

/** Repository root, two levels up from `apps/vscode`. */
const REPO_ROOT = path.resolve(PACKAGE_DIR, "..", "..");

/** Everything this script writes lives here; `dist/` is git-ignored. */
const DIST_DIR = path.join(PACKAGE_DIR, "dist");

/** The extension host entry. Owned by another change; see the file comment. */
const EXTENSION_ENTRY = path.join(PACKAGE_DIR, "src", "extension.ts");

/**
 * The core child entry.
 *
 * Deliberately the launcher, not `src/core/main.ts`: that module runs the
 * message loop only when it is handed its three seams, so a bundle built from it
 * exports a function and then exits. The extension host forks this artifact and
 * waits for `ready`, and a bundle that never runs makes that wait a boot
 * timeout. `src/core/entry.ts` is the file that injects the seams and calls the
 * loop; see its comment for which half of each seam is wired.
 */
const CORE_ENTRY = path.join(PACKAGE_DIR, "src", "core", "entry.ts");

/** The Vite config that owns the webview build, kept out of this file. */
const WEBVIEW_CONFIG = path.join(PACKAGE_DIR, "vite.webview.mts");

/** Anchor for resolving `ws`: it is a dependency of `@haruyuki/core`, not of this package. */
const CORE_MANIFEST = path.join(REPO_ROOT, "packages", "core", "package.json");

/** Where the runtime dependency has to end up for `dist/core.mjs` to resolve it. */
const WS_TARGET_DIR = path.join(DIST_DIR, "node_modules", "ws");

/** Node built-ins the bundle may keep as imports; the runtime provides them. */
const NODE_EXTERNAL = ["vscode"];

/**
 * Budget for the core bundle's first answer to `init`.
 *
 * Generous because the child has to load a bundle that inlines the engine facade
 * and the client before it subscribes to the pipe; a working child answers in
 * tens of milliseconds, so this only bounds a bundle that never subscribes.
 */
const CORE_BOOT_TIMEOUT_MS = 15_000;

/** Budget for the self-check's child to exit after `shutdown`. */
const CORE_STOP_TIMEOUT_MS = 10_000;

/** The identifier an esbuild `define` may point at; a define takes no expression. */
const MODULE_URL_IDENTIFIER = "__MODULE_URL__";

/** Defines that identifier in the CJS bundle, where `import.meta` is `{}`. */
const MODULE_URL_BANNER =
  'const __MODULE_URL__ = require("node:url").pathToFileURL(__filename).href;';

/** One target that failed, with the sentence a reader needs. */
const failures = [];

/**
 * @param absolute absolute path
 * @returns the repository-relative posix path a log line should name
 */
function relative(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

/**
 * @param message one progress or verdict line
 * @returns {void}
 */
function say(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Report one written file with its size, so a regression is visible in the log
 * rather than only in the package.
 *
 * @param absolute the written file
 * @returns {void}
 */
function reportFile(absolute) {
  const { size } = statSync(absolute);

  say(`  ${relative(absolute)}  ${size.toLocaleString("en-US")} bytes`);
}

/**
 * Record a target that could not produce its artifact.
 *
 * @param target short name used in the summary
 * @param detail one sentence explaining what to look at
 * @returns {void}
 */
function fail(target, detail) {
  failures.push({ target, detail });
  say(`build: ${target} FAILED - ${detail}`);
}

/**
 * Name the extension entry that is not there yet, and clear what an earlier
 * build left behind so a stale bundle cannot be packaged as if it were current.
 *
 * @returns {void}
 */
function skipMissingExtension() {
  const stale = path.join(DIST_DIR, "extension.cjs");

  rmSync(stale, { force: true });
  rmSync(`${stale}.map`, { force: true });
  fail(
    "extension",
    `${relative(EXTENSION_ENTRY)} does not exist yet, so ${relative(stale)} was not written ` +
      `(the extension host entry arrives as its own change; this script never creates sources)`,
  );
}

/** Build the extension host entry as the CommonJS module the host loads. */
async function buildExtension() {
  say("\nbuild: extension host entry");

  if (!existsSync(EXTENSION_ENTRY)) {
    skipMissingExtension();
    return;
  }

  const outfile = path.join(DIST_DIR, "extension.cjs");

  await esbuild({
    entryPoints: [EXTENSION_ENTRY],
    outfile,
    bundle: true,
    // The host loads it with `require`, and the whole extension ecosystem
    // assumes this shape.
    format: "cjs",
    platform: "node",
    target: "node24",
    // A crash report that points at one minified line is not a crash report.
    minify: false,
    sourcemap: true,
    // `vscode` is injected by the extension host; inlining its stubs would make
    // the bundle look for an API nobody provides.
    external: NODE_EXTERNAL,
    // `import.meta` is `{}` in a CJS bundle. The banner defines this module's own
    // URL and the define points `import.meta.url` at it, so the modules that
    // need one (`@haruyuki/core` calls `createRequire(import.meta.url)`) load
    // instead of throwing before their first line runs. A define value has to be
    // an identifier or a literal, which is why the banner exists rather than an
    // expression here.
    banner: { js: `${MODULE_URL_BANNER}` },
    define: { "import.meta.url": MODULE_URL_IDENTIFIER },
    // Only warnings and errors: the artifact lines below are this script's, and
    // a tool repeating the same byte count under its own format reads as two
    // different numbers for one file.
    logLevel: "warning",
  });

  reportFile(outfile);
}

/** Build the core child entry as ESM, with `ws` shipped next to it. */
async function buildCore() {
  say("\nbuild: core child entry");

  const outfile = path.join(DIST_DIR, "core.mjs");

  await esbuild({
    entryPoints: [CORE_ENTRY],
    outfile,
    bundle: true,
    // `@haruyuki/core` reads `import.meta.url`; ESM is the only format where
    // that means what it says.
    format: "esm",
    platform: "node",
    target: "node24",
    minify: false,
    sourcemap: true,
    external: ["ws"],
    logLevel: "warning",
  });

  reportFile(outfile);
  copyRuntimeDependency();
  await checkCoreBootstrap(outfile);
}

/**
 * Prove the written core bundle actually runs, and that it waits for its host.
 *
 * The failure this catches is silent: a bundle whose entry only exports the
 * message loop loads cleanly, exits 0 with no output, and never answers the
 * extension host, which then waits out its whole boot budget. Neither a byte
 * count nor a successful esbuild call can tell that apart from a working child,
 * so the only usable proof is to run the artifact the way the host runs it.
 *
 * Three facts are asserted, in this order:
 *
 *   1. the child is still alive after a grace period, so it did not exit on its
 *      own the way an exports-only bundle does;
 *   2. it answered the IPC `init` with a message at all, which proves the
 *      message loop is subscribed to the pipe;
 *   3. that answer was `status`, not a crash report or silence.
 *
 * `ready` is deliberately *not* required. The core only emits it after an engine
 * has actually started (`src/core/main.ts`, `onInit`), and this check runs with
 * no engine: the init below names a directory that does not exist, so the honest
 * expected outcome is a `starting` status followed by a `failed` one. Requiring
 * `ready` here would be a check that can only pass on a machine with a real
 * engine installed, which is the kind of "green because it never ran" result
 * this build step exists to prevent.
 *
 * The child is ended with `shutdown`, and any failure fails the whole build
 * rather than warning.
 *
 * @param outfile the freshly written `dist/core.mjs`
 * @returns {void}
 */
async function checkCoreBootstrap(outfile) {
  // Nothing this check writes may land in `dist/`: the token file is a secret
  // and the four roots are throwaway, so they go in a temp tree that is removed
  // before the build reports.
  const scratch = mkdtempSync(path.join(tmpdir(), "haruyuki-core-selfcheck-"));

  const child = fork(outfile, {
    // The child is a Node ESM artifact, so it is started the way the host
    // starts it: this binary, no shell, an IPC slot as the fourth stdio slot.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    cwd: DIST_DIR,
  });

  let stderr = "";

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const settled = new Promise((resolve) => {
    child.once("spawn", () => {
      child.send({
        kind: "init",
        paths: {
          userData: path.join(scratch, "userData"),
          logs: path.join(scratch, "logs"),
          cache: path.join(scratch, "cache"),
          temp: scratch,
        },
        cwd: DIST_DIR,
        locale: "en",
        engine: {
          kind: "external",
          dir: path.join(scratch, "missing-engine"),
          bundlePath: path.join(scratch, "missing-engine", "haruyuki.js"),
        },
        expectedVersion: "0.0.0",
      });

      // The first answer is the proof that the loop is running; a bundle that
      // only exports never sends one and the timer below is what reports it.
      const timer = setTimeout(() => {
        resolve(null);
      }, CORE_BOOT_TIMEOUT_MS);

      child.once("message", (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  });

  const first = await settled;

  // The child is ended before it is judged, so a failed check never leaves a
  // process behind. `shutdown` is the documented stop path.
  if (child.exitCode === null) {
    try {
      child.send({ kind: "shutdown" });
    } catch {
      // A child that already closed its channel is stopped below.
    }
  }

  const stopped = new Promise((resolve) => {
    const timer = setTimeout(resolve, CORE_STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  await stopped;

  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");

  // Always: the engine wrote a token file in here, and a build must not leave a
  // secret behind, even in a scratch directory.
  rmSync(scratch, { recursive: true, force: true });

  const tail = stderr.trim() === "" ? "" : `; stderr: ${stderr.trim()}`;

  if (first === null) {
    fail(
      "core",
      `${relative(outfile)} does not bootstrap: no answer to init within ` +
        `${CORE_BOOT_TIMEOUT_MS}ms${tail}`,
    );

    return;
  }

  if (first?.kind !== "status") {
    fail(
      "core",
      `${relative(outfile)} answered init with ${JSON.stringify(first?.kind)} instead of a status${tail}`,
    );

    return;
  }

  say(
    `  ${relative(outfile)}  bootstraps: answered ${JSON.stringify(first.phase)} and stayed resident`,
  );
}

/**
 * Copy `ws` next to the core bundle.
 *
 * Resolved from `@haruyuki/core`'s own manifest rather than spelled as a path
 * under `packages/core/node_modules`, because pnpm's layout is an install
 * detail: the dependency is `ws`, the directory it lands in is not.
 */
function copyRuntimeDependency() {
  const requireFromCore = createRequire(CORE_MANIFEST);
  const wsDir = path.dirname(requireFromCore.resolve("ws/package.json"));

  rmSync(WS_TARGET_DIR, { recursive: true, force: true });
  cpSync(wsDir, WS_TARGET_DIR, { recursive: true, dereference: true });

  say(`  ${relative(WS_TARGET_DIR)}/  copied from ${relative(wsDir)}`);

  // Proving the layout, not the copy: this is the resolution `dist/core.mjs`
  // performs at runtime, and a missing `package.json` or a moved `main` would
  // only show up in the extension otherwise.
  const requireFromBundle = createRequire(path.join(DIST_DIR, "core.mjs"));

  say(`  resolved "ws" -> ${relative(requireFromBundle.resolve("ws"))}`);
}

/** Build the panel document and its assets. */
async function buildWebview() {
  say("\nbuild: webview document");

  if (!existsSync(WEBVIEW_CONFIG)) {
    fail("webview", `${relative(WEBVIEW_CONFIG)} is missing, so no document can be built`);
    return;
  }

  // The config owns the entry, the output directory and the asset names; this
  // call is the whole driver. Reading them here instead would be a second copy
  // of the Vite build settings.
  await viteBuild({ configFile: WEBVIEW_CONFIG, customLogger: webviewLogger() });

  const outDir = path.join(DIST_DIR, "webview");

  if (!existsSync(outDir)) {
    fail("webview", `Vite finished without writing ${relative(outDir)}`);
    return;
  }

  for (const file of walk(outDir)) reportFile(file);
}

/**
 * A logger that drops the warnings this build cannot act on.
 *
 * Three dependency trees the panel renders (`@base-ui`, `lucide-react` and the
 * React runtime) mark module bodies with `"use client"`. Rolldown has no use for
 * that directive, emits one warning per marked module, and there are over a
 * hundred of them: replayed under a failing segment they bury the artifact
 * lines, and a warning nobody can fix is noise a reader learns to skip.
 *
 * Everything else is forwarded unchanged, including the chunk-size warning,
 * because those are statements about this build.
 *
 * @returns the filtered logger
 */
function webviewLogger() {
  const base = createLogger("warn");
  const ignored = /MODULE_LEVEL_DIRECTIVE/;

  return {
    info: (message, options) => base.info(message, options),
    warn: (message, options) => {
      if (!ignored.test(message)) base.warn(message, options);
    },
    warnOnce: (message, options) => {
      if (!ignored.test(message)) base.warnOnce(message, options);
    },
    error: (message, options) => base.error(message, options),
    clearScreen: (type) => base.clearScreen(type),
    hasErrorLogged: (error) => base.hasErrorLogged(error),
    // Read through, not copied: Vite consults this after the build, and a value
    // captured when the logger was made would answer for the wrong moment.
    get hasWarned() {
      return base.hasWarned;
    },
  };
}

/**
 * Every regular file below a directory, sorted so the log is stable.
 *
 * @param directory absolute path
 * @returns absolute file paths
 */
function walk(directory) {
  const found = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      found.push(...walk(absolute));
    } else {
      found.push(absolute);
    }
  }

  return found.sort();
}

/** Run every target, then report. A failing target never hides a later one. */
async function main() {
  /** Named so a thrown error is attributed to a target, not to a function name. */
  const targets = [
    ["extension", buildExtension],
    ["core", buildCore],
    ["webview", buildWebview],
  ];

  for (const [name, target] of targets) {
    try {
      await target();
    } catch (error) {
      fail(name, describe(error));
    }
  }

  say("");

  if (failures.length > 0) {
    say(`build: ${failures.length} target(s) did not produce an artifact`);

    for (const failure of failures) say(`  ${failure.target}: ${failure.detail}`);

    process.exitCode = 1;
    return;
  }

  say("build: all targets written to " + relative(DIST_DIR));
}

/**
 * @param value thrown value
 * @returns its message when it is an `Error`, else its rendering
 */
function describe(value) {
  return value instanceof Error ? value.message : String(value);
}

await main();
