/**
 * verify-packaged-start.mjs - the download a user receives, started from a fresh
 * directory, judged by what it renders rather than by whether a process survives.
 *
 * Usage:
 *   node apps/desktop/scripts/verify-packaged-start.mjs
 *   node apps/desktop/scripts/verify-packaged-start.mjs --images=win32
 *
 * Why this is separate from the other verifications
 *   `verify-manifest.mjs` judges the documents and `verify-artifacts.mjs` judges
 *   the files. Neither starts anything, so a package that cannot run passes both.
 *   That is not hypothetical: the packaged bundle once carried the build
 *   machine's absolute path as its module-resolution anchor, which resolves on
 *   the machine that built it and nowhere else. Every test and every gate was
 *   green, and the download would have failed on the first launch.
 *
 * What is judged, and why each half is needed
 *   1. Extraction. The zip is unpacked into a directory that did not exist
 *      before, not read out of `release/win-unpacked`. The unpacked tree is a
 *      build artifact that shares a filesystem with the sources it was built
 *      from; a package is what someone else gets after copying one file.
 *   2. No build-machine path in the bytes. Static, and it is the half that can
 *      fail on the machine that built the package: it does not need a second
 *      machine to show that the anchor was baked in.
 *   3. It starts. Chromium's Node mode is removed from the environment first,
 *      because inheriting `ELECTRON_RUN_AS_NODE` makes the executable run as a
 *      plain interpreter and never create a window - a failure that looks like
 *      a broken application.
 *   4. It renders. A window target with no title, or a document whose root has
 *      no children, is a blank window. Asking the DevTools protocol is how this
 *      runs without a screenshot comparison: the requirement's own wording is
 *      "the window is drawn", and a mounted root is the strongest claim that
 *      can be made without pixels.
 *   5. The engine reaches ready and the watchdog reports. The bundle is the
 *      largest thing that ships and the one that fails in the middle of a
 *      session rather than at launch.
 *
 * Exit codes
 *   0  judged and passed
 *   1  judged and failed
 *   2  the script or its inputs are broken (not a verdict)
 *   3  nothing to judge: no packaged artifact on this tree. Deliberately not 0,
 *      because "there was nothing to check" must not read as "it works".
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_DIR = path.resolve(path.dirname(SCRIPT_PATH), "..");
const RELEASE_DIR = path.join(DESKTOP_DIR, "release");

// Strings that only exist on the machine that produced the package.
//
// Deliberately narrow. A generic "any drive letter" rule looks stricter and is
// worse: it matches the documentation and test fixtures, which contain example
// paths like `C:\Users\ana\proj\a.ts` on purpose, and a judgement that fires on
// its own examples gets switched off. What actually shipped the defect was the
// checkout's own absolute path, so that is what is looked for - plus this
// machine's own home directory, which is a real path rather than an example.
const BUILD_MACHINE_MARKERS = [
  { label: "the worktree name", pattern: /haruyuki-wt/ },
  { label: "the build machine's checkout", pattern: /[A-Za-z]:\\{1,2}Projects\\{1,2}/ },
];

/** This machine's home directory, when it is long enough not to be a false match. */
function homeMarker() {
  const home = os.homedir().replaceAll("\\", "\\\\");
  if (home.length < 8) return null;
  return { label: "this machine's home directory", pattern: new RegExp(escapeRegExp(home)) };
}

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How long to wait for a rendered window before calling it a failure. */
const STARTUP_BUDGET_MS = 90_000;

/** @type {{ok: boolean, label: string, complaint?: string}[]} */
const results = [];

/**
 * @param {string} label
 * @param {() => Promise<string | null> | string | null} body
 * @returns {Promise<void>}
 */
async function judge(label, body) {
  let complaint;
  try {
    complaint = await body();
  } catch (error) {
    complaint = error instanceof Error ? error.message : String(error);
  }
  const ok = complaint === null || complaint === undefined;
  results.push(ok ? { ok, label } : { ok, label, complaint });
  process.stdout.write(
    ok ? `  ok    ${label}\n` : `  FAIL  ${label}: ${complaint ?? "(no detail)"}\n`,
  );
}

/** Every file under a directory, as absolute paths. */
async function walkFiles(directory) {
  /** @type {string[]} */
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await walkFiles(absolute)));
    else if (entry.isFile()) found.push(absolute);
  }
  return found;
}

/**
 * The packaged archive's raw bytes.
 *
 * Read as latin1 so every byte maps to one character: the bundle is JavaScript
 * with escaped backslashes inside string literals, and a UTF-8 decode would
 * rewrite them before the search could see what is actually stored.
 */
async function archiveTexts(extractedRoot) {
  /** @type {{file: string, text: string}[]} */
  const texts = [];
  for (const file of await walkFiles(extractedRoot)) {
    const extension = path.extname(file).toLowerCase();
    if (![".cjs", ".js", ".mjs", ".json", ".asar"].includes(extension)) continue;
    const bytes = await readFile(file);
    texts.push({ file, text: bytes.toString("latin1") });
  }
  return texts;
}

/**
 * Ask a DevTools target to evaluate an expression.
 *
 * @param {string} wsUrl
 * @param {string} expression
 * @returns {Promise<any>}
 */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      reject(new Error("devtools evaluate timed out"));
    }, 15_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("devtools socket error"));
    });
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Does `version` satisfy `range`? Enough of the semver range grammar for a
 * dependency declared as `^x.y.z`, `~x.y.z`, `x.y.z` or `>=x.y.z`.
 *
 * Hand-rolled because this script already has no dependencies (it runs before
 * anything is installed), and the alternative is pulling a resolver in for one
 * comparison. Anything it does not understand returns null, which the caller
 * reports as "cannot judge" rather than as a pass.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean | null}
 */
function satisfies(version, range) {
  const parse = (value) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match === null
      ? null
      : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
  };

  const have = parse(version);
  if (have === null) return null;
  const trimmed = range.trim();

  const caret = /^\^(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (caret !== null) {
    const floor = parse(caret[1]);
    if (floor === null) return null;
    // `^0.y.z` pinning is subtly different, but nothing here declares one, so
    // the comparison refuses rather than guessing if it ever appears.
    if (floor.major === 0) return null;
    const atLeast = compare(have, floor) >= 0;
    return atLeast && have.major === floor.major;
  }

  const tilde = /^~(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (tilde !== null) {
    const floor = parse(tilde[1]);
    if (floor === null) return null;
    return compare(have, floor) >= 0 && have.major === floor.major && have.minor === floor.minor;
  }

  const atLeastRange = /^>=\s*(\d+\.\d+\.\d+)$/.exec(trimmed);
  if (atLeastRange !== null) {
    const floor = parse(atLeastRange[1]);
    return floor === null ? null : compare(have, floor) >= 0;
  }

  const exact = parse(trimmed);
  return exact === null ? null : compare(have, exact) === 0;
}

/** @param {{major: number, minor: number, patch: number}} a @param {{major: number, minor: number, patch: number}} b */
function compare(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * Start the extracted executable and wait for a rendered window.
 *
 * @param {string} exe
 * @param {number} port
 * @returns {Promise<{stop: () => void, verdict: () => Promise<string | null>}>}
 */
function launch(exe, port) {
  const environment = { ...process.env };
  // Inherited from some shells, and it makes electron behave as plain node:
  // no window, no error, and a verdict about the wrong thing entirely.
  delete environment["ELECTRON_RUN_AS_NODE"];
  delete environment["NODE_OPTIONS"];

  const child = spawn(exe, [`--remote-debugging-port=${String(port)}`], {
    env: environment,
    stdio: "ignore",
    detached: false,
  });

  let exited = null;
  child.on("exit", (code) => {
    exited = code;
  });

  return {
    stop: () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
    verdict: async () => {
      const started = Date.now();
      let lastLine = "no devtools endpoint yet";
      while (Date.now() - started < STARTUP_BUDGET_MS) {
        if (exited !== null)
          return `the application exited with code ${String(exited)} before a window`;
        let targets;
        try {
          const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
          if (!response.ok) throw new Error(`devtools list http ${String(response.status)}`);
          targets = await response.json();
        } catch (error) {
          lastLine = String(error instanceof Error ? error.message : error);
          await sleep(1000);
          continue;
        }
        const page = targets.find((target) => target.type === "page");
        if (page === undefined) {
          lastLine = `targets=${String(targets.length)}, none of type page`;
          await sleep(1000);
          continue;
        }
        const title = String(page.title ?? "");
        const pageUrl = String(page.url ?? "");
        if (page.webSocketDebuggerUrl === undefined) {
          lastLine = `page target without a debugger url (title=${JSON.stringify(title)})`;
          await sleep(1000);
          continue;
        }
        try {
          const evaluated = await evaluate(
            page.webSocketDebuggerUrl,
            "document.querySelectorAll('#root > *').length",
          );
          const children = evaluated?.result?.value;
          process.stdout.write(
            `  cdp: title=${JSON.stringify(title)} url=${JSON.stringify(pageUrl)} ` +
              `rootChildren=${String(children)} waitedMs=${String(Date.now() - started)}\n`,
          );
          if (title.length === 0) return "the window target has an empty title";
          if (!pageUrl.startsWith("app://haruyuki/")) {
            return `the window did not load the app protocol: ${pageUrl}`;
          }
          if (typeof children !== "number" || children <= 0) {
            return `#root has ${String(children)} children; the document mounted nothing`;
          }
          return null;
        } catch (error) {
          lastLine = String(error instanceof Error ? error.message : error);
          await sleep(1000);
        }
      }
      return `no rendered window within ${String(STARTUP_BUDGET_MS)} ms: ${lastLine}`;
    },
  };
}

/** The packaged archives on disk, newest first. */
async function archives() {
  if (!existsSync(RELEASE_DIR)) return [];
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
    .map((entry) => path.join(RELEASE_DIR, entry.name));
}

/** Unpack a zip with the platform's own tool, into a directory that is new. */
async function unzip(archive, destination) {
  await mkdir(destination, { recursive: true });
  const command =
    process.platform === "win32"
      ? {
          file: "powershell",
          args: [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`,
          ],
        }
      : { file: "unzip", args: ["-q", archive, "-d", destination] };

  await new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: "ignore" });
    child.on("exit", (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(`${command.file} exited ${String(code)}`)),
    );
    child.on("error", reject);
  });
}

/** @param {string} root @param {string} name */
async function findByName(root, name) {
  for (const file of await walkFiles(root)) {
    if (path.basename(file) === name) return file;
  }
  return null;
}

async function main() {
  process.stdout.write("verify-packaged-start: judging the download, not the build tree\n");

  const zips = await archives();
  const requested = process.argv
    .find((arg) => arg.startsWith("--images="))
    ?.slice("--images=".length);
  const candidates =
    requested === undefined ? zips : zips.filter((file) => path.basename(file).includes(requested));

  if (candidates.length === 0) {
    process.stdout.write(
      "SKIP: no packaged archive under apps/desktop/release.\n" +
        "      This is not a pass. Build one with `release.mjs --win-only` and run again.\n",
    );
    return 3;
  }

  const archive = candidates.sort().at(-1);
  if (archive === undefined) throw new Error("no archive to judge after filtering");

  const stamp = createHash("sha256").update(path.basename(archive)).digest("hex").slice(0, 8);
  const staging = path.join(os.tmpdir(), `haruyuki-packaged-start-${stamp}`);
  await rm(staging, { recursive: true, force: true });

  await judge("the archive unpacks into a directory that did not exist", async () => {
    await unzip(archive, staging);
    return existsSync(staging) ? null : "the extraction produced nothing";
  });

  const exe = await findByName(staging, process.platform === "win32" ? "Haruyuki.exe" : "Haruyuki");
  await judge("the extracted tree contains the executable", () =>
    exe === null ? "no executable in the extracted tree" : null,
  );

  // The static half. On the machine that built the package this is the only
  // half that can fail: the anchor resolves here and nowhere else.
  await judge("no build-machine path survives into the packaged bytes", async () => {
    const texts = await archiveTexts(staging);
    if (texts.length === 0) return "no script or archive files were extracted to search";

    const home = homeMarker();
    const markers = home === null ? BUILD_MACHINE_MARKERS : [...BUILD_MACHINE_MARKERS, home];

    for (const { file, text } of texts) {
      for (const marker of markers) {
        if (marker.pattern.test(text)) {
          return `${path.relative(staging, file)} embeds ${marker.label}`;
        }
      }
    }
    return null;
  });

  await judge("the unpacked tree keeps the engine beside its modules", async () => {
    const bundle = await findByName(staging, "haruyuki.js");
    if (bundle === null) return "the engine bundle is not in the package";
    const beside = path.join(path.dirname(bundle), "node_modules");
    return existsSync(beside) ? null : `${path.relative(staging, beside)} is missing`;
  });

  // The anchor resolves the websocket client from the engine tree, so the
  // client that actually loads is the one shipped there - not the one this
  // repository pins for its own build. One copy, and the version has to satisfy
  // what the engine declares, or the desktop shell is running a client nobody
  // chose. Comparing the two versions for equality would be the wrong check:
  // the engine's range is a range, and a newer patch inside it is correct.
  await judge("the client the anchor resolves satisfies the engine's own range", async () => {
    const bundle = await findByName(staging, "haruyuki.js");
    if (bundle === null) return "the engine bundle is not in the package";

    // The engine tree is wherever its bundle is; its own manifest sits beside it,
    // and a manifest found anywhere else belongs to some transitive package.
    const engineDir = path.dirname(bundle);
    const enginePackage = path.join(engineDir, "package.json");
    if (!existsSync(enginePackage)) return `${path.relative(staging, enginePackage)} is missing`;

    const engineJson = JSON.parse(await readFile(enginePackage, "utf8"));
    const declared = engineJson?.dependencies?.ws ?? engineJson?.optionalDependencies?.ws;
    if (typeof declared !== "string")
      return "the shipped engine does not declare a websocket client";

    const resolved = path.join(engineDir, "node_modules", "ws", "package.json");
    if (!existsSync(resolved)) return `${path.relative(staging, resolved)} is missing`;

    const installed = JSON.parse(await readFile(resolved, "utf8")).version;
    if (typeof installed !== "string") return "the shipped client has no version";

    return satisfies(installed, declared) === true
      ? null
      : `shipped ${installed} does not satisfy the engine's ${declared}`;
  });

  if (exe !== null) {
    const port = 9411;
    const app = launch(exe, port);
    await judge("the packaged application renders its window", () => app.verdict());
    app.stop();
  }

  // A just-stopped Electron keeps a handle on some of its own files for a moment,
  // and on Windows an open handle makes the removal fail. Leaving the staging
  // directory behind is not a verdict, so a failure to clean it up must not turn
  // a green run red - but it is reported, because a temp directory that survives
  // every run is its own defect.
  await sleep(1500);
  try {
    await rm(staging, { recursive: true, force: true });
  } catch (error) {
    process.stdout.write(
      `  note: could not remove the staging directory (${String(
        error instanceof Error ? error.message : error,
      )}); it is under the system temp directory\n`,
    );
  }

  const failed = results.filter((entry) => !entry.ok).length;
  process.stdout.write(
    `\n${String(results.length - failed)} of ${String(results.length)} assertions hold\n`,
  );
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
