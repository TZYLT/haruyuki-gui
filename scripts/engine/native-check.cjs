#!/usr/bin/env node
/**
 * native-check.cjs - load the engine's native modules from a packaged tree.
 *
 * The package ships the engine as real files under `resources/engine`, with its
 * own `node_modules`. That copy is what runs on a user machine, so it is the
 * copy the ABI assertion has to touch. Requiring from the repository instead
 * would pass on the build machine and fail on the target, which is the exact
 * failure this check exists to catch.
 *
 * Two details are load-bearing:
 *
 *   The require is anchored at `<engine>/package.json`, not at this script.
 *   That makes resolution start inside the packaged engine, where the shipped
 *   `node_modules` lives.
 *
 *   Resolution is asserted to stay inside the engine directory. On a build
 *   machine `win-unpacked` sits under the repository, so Node's upward walk
 *   could otherwise find a repository copy of `node-pty`/`sharp` and report a
 *   pass for modules that are not in the package. Escaping is a failure, even
 *   when the module loads.
 *
 * Run it with the packaged Electron binary, not the system Node:
 *
 *   ELECTRON_RUN_AS_NODE=1 Haruyuki.exe scripts/engine/native-check.cjs \
 *     "<pkg>/resources/engine"
 *
 * The exit code is 0 only when the runtime is the documented ABI (`modules`
 * 150), both modules load, the 2x2 PNG encodes, and both resolved paths are
 * inside the packaged engine.
 */

"use strict";

const { existsSync, realpathSync, statSync } = require("node:fs");
const { createRequire } = require("node:module");
const path = require("node:path");

/** The Electron 45 / Node 24 ABI the lock records. */
const EXPECTED_MODULES = "150";

/**
 * Whether one resolved path lives below a directory.
 *
 * @param {string} child absolute path to a resolved module entry
 * @param {string} parent absolute directory
 * @returns {boolean}
 */
function isInside(child, parent) {
  let realChild;
  let realParent;

  try {
    realChild = realpathSync.native(child);
    realParent = realpathSync.native(parent);
  } catch {
    return false;
  }

  const relative = path.relative(realParent, realChild);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Turn any thrown value into a short reportable string.
 *
 * The stack is deliberately omitted: this runs inside a machine-readable
 * report, and a module-not-found stack is 20 lines of loader frames that say
 * nothing the first line does not.
 *
 * @param {unknown} error
 * @returns {string}
 */
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main() {
  const engineArgument = process.argv[2] ?? process.env["HARUYUKI_NATIVE_ENGINE"];

  if (typeof engineArgument !== "string" || engineArgument.length === 0) {
    console.log(
      JSON.stringify({
        ok: false,
        error: "usage: native-check.cjs <packaged resources/engine directory>",
      }),
    );
    process.exitCode = 2;
    return;
  }

  const engine = path.resolve(engineArgument);
  const packageJson = path.join(engine, "package.json");
  const result = {
    engine,
    node: process.version,
    electron: process.versions.electron ?? null,
    modules: process.versions.modules,
    expectedModules: EXPECTED_MODULES,
    nodeModules: existsSync(path.join(engine, "node_modules")),
    nodePty: { loaded: false },
    sharp: { loaded: false },
    ok: false,
  };

  let ok = result.modules === EXPECTED_MODULES;

  try {
    statSync(packageJson);
  } catch {
    result.error = `engine package.json is missing: ${packageJson}`;
    console.log(JSON.stringify(result));
    process.exitCode = 1;
    return;
  }

  const requireFromEngine = createRequire(packageJson);

  try {
    const nodePty = requireFromEngine("node-pty");
    const resolved = requireFromEngine.resolve("node-pty");
    const inside = isInside(resolved, engine);

    result.nodePty = {
      loaded: true,
      resolved,
      insideEngine: inside,
      keys: Object.keys(nodePty).slice(0, 8),
    };
    ok = ok && inside;
  } catch (error) {
    result.nodePty = { loaded: false, error: describe(error) };
    ok = false;
  }

  try {
    const sharp = requireFromEngine("sharp");
    const resolved = requireFromEngine.resolve("sharp");
    const inside = isInside(resolved, engine);
    const encoded = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 1, g: 2, b: 3, alpha: 1 },
      },
    })
      .png()
      .toBuffer();

    result.sharp = {
      loaded: true,
      resolved,
      insideEngine: inside,
      version: sharp.versions?.sharp ?? null,
      encodedBytes: encoded.length,
    };
    ok = ok && inside && encoded.length > 0;
  } catch (error) {
    result.sharp = { loaded: false, error: describe(error) };
    ok = false;
  }

  result.ok = ok;
  console.log(JSON.stringify(result));
  process.exitCode = ok ? 0 : 1;
}

void main();
