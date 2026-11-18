/**
 * The about window's two channels: the read-only facts, and the three legal
 * documents.
 *
 * Both handlers answer from the installation itself. Nothing here reaches the
 * network, which is the property the window depends on: it must work with the
 * machine offline, so every fact it shows has to be readable from the package
 * and from the files an earlier launch left under `userData`. The update check
 * is a third channel with its own module, and it is the only one that talks to
 * the network -- on a click, never here.
 *
 * Three rules the handlers keep:
 *
 *   Nothing throws across IPC. A rejected `invoke` arrives in the renderer as an
 *   opaque promise rejection, which is the least useful form of "the button did
 *   nothing"; every failure is therefore a value with a `detail`.
 *
 *   `about.open` opens the files in the package, never a URL. The three
 *   documents are the ones the product ships; sending someone to a web page
 *   would show them a different revision of the licence from the one that
 *   applies to this binary.
 *
 *   `engine.source` describes the bundle this installation uses, read from the
 *   live engine's path when there is one and from the recorded pick otherwise.
 *   The payload has no "is it running" field, so the window must not imply one.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { ABOUT_INFO_CHANNEL, ABOUT_OPEN_CHANNEL } from "../shared/bridge.js";
import type { Logger } from "./log.js";
import { RUNTIME_STATE_FILE } from "./runtime/layout.js";
import { readRuntimeLock } from "./runtime/lock.js";
import { defaultRuntimeState, readRuntimeState, type RuntimeStateRead } from "./runtime/state.js";

/** Where the repository lives. Fixed by the contract, not discovered at runtime. */
export const ABOUT_REPO_URL = "https://github.com/TZYLT/haruyuki-gui";

/** Where a report goes. The issue list is the only entry point that needs no account. */
export const ABOUT_ISSUE_URL = "https://github.com/TZYLT/haruyuki-gui/issues";

/** Where a running engine came from, in the same three words the runtime uses. */
export type AboutEngineSource = "bundled" | "external" | "path";

/**
 * What the last verification concluded, in the five words the window can render.
 *
 * `unknown` is not a fifth verification outcome: it is the absence of one. The
 * persisted state has a fifth member (`external-invalid`) that no writer ever
 * stores, and a hand-edited file is not evidence the window can describe, so
 * both land on `unknown` rather than on a sentence that would be a guess.
 */
export type AboutEngineLastResult =
  "ok" | "entry-mismatch" | "tree-mismatch" | "missing" | "unknown";

/** The read-only view of this installation. Never a live process description. */
export interface AboutInfo {
  readonly appVersion: string;
  readonly engine: {
    readonly version: string;
    readonly source: AboutEngineSource;
    readonly lastResult: AboutEngineLastResult;
  };
  readonly runtime: {
    readonly electron: string;
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
  };
  readonly repoUrl: string;
  readonly issueUrl: string;
}

/** The three documents the product ships, by the name the renderer sends. */
export type AboutDoc = "license" | "notice" | "third-party";

/** What `about.open` answers. A failure is a value, never a rejection. */
export type AboutOpenResult =
  { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * The file each name means.
 *
 * A table rather than a string built from the name: the third document is called
 * `THIRD-PARTY`, so a rule like "uppercase the name" would look for
 * `THIRD-THIRD-PARTY` in one direction and `THIRD` in the other.
 */
export const ABOUT_DOC_FILES: Readonly<Record<AboutDoc, string>> = Object.freeze({
  license: "LICENSE",
  notice: "NOTICE",
  "third-party": "THIRD-PARTY",
});

/** The Electron facts a handler cannot read for itself without Electron. */
export interface AboutPathFacts {
  readonly isPackaged: boolean;
  /** `path.dirname(app.getPath("exe"))`: the directory the user unzipped into. */
  readonly exeDir: string;
  /** `process.resourcesPath`. */
  readonly resourcesPath: string;
  /** `app.getAppPath()`: the package directory in development, the asar when packaged. */
  readonly appPath: string;
  /** The checkout root, derived from the main bundle's directory; dev only. */
  readonly devRoot: string;
}

/** `process.versions` and `process.platform`, read in the composition root. */
export interface AboutProcessVersions {
  readonly electron: string;
  readonly node: string;
  readonly platform: string;
  readonly arch: string;
}

/** The slice of `ipcMain` these handlers need; fakeable in a test. */
export interface AboutIpcMain {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
  removeHandler?(channel: string): void;
}

/** Everything the two handlers read. */
export interface AboutIpcDeps {
  readonly ipc: AboutIpcMain;
  /** The running app's version, read per request rather than at wiring time. */
  readonly appVersion: () => string;
  /** `app.getPath("userData")`: where `runtime-state.json` lives. */
  readonly userData: string;
  /** The bundled engine's directory; one of the three sources. */
  readonly engineDir: string;
  /** `runtime-lock.json`, the only authority on the bundled engine's version. */
  readonly lockPath: string;
  readonly paths: AboutPathFacts;
  readonly versions: AboutProcessVersions;
  /** Hand a local file to the operating system. */
  readonly openPath: (target: string) => Promise<string>;
  /** Test seam: the containment/existence check for the three documents. */
  readonly exists?: (target: string) => boolean;
  /** The bundle the engine is running now, or `null` when none is running. */
  readonly liveBundlePath?: () => string | null;
  readonly logger?: Logger;
}

/** One `ipcMain` per process in production; the set makes re-entry a no-op. */
const registered = new WeakSet<object>();

/**
 * Read the directory that may hold the three legal documents.
 *
 * Packaged, they belong next to the executable the user unzipped (and, for a
 * build that puts them under `resources/`, there too). Development has no
 * package root, so the repository root -- the same three files, the same
 * contents -- is the only honest answer.
 *
 * Both packaged candidates are listed because which one receives the files is a
 * packaging decision, not this module's: `extraFiles` lands in the first,
 * `extraResources` in the second, and a window that looked in one place would
 * report a shipped document as missing.
 *
 * @param facts what the composition root read from Electron
 * @returns the directories to try, most specific first
 */
export function legalDocRoots(facts: AboutPathFacts): readonly string[] {
  if (facts.isPackaged) {
    return [facts.exeDir, facts.resourcesPath, facts.appPath];
  }

  // A development tree has no package root, so the three documents are the
  // repository's own. The path is derived from the bundle's location rather than
  // from `app.getAppPath()`, which is the package directory in development and
  // the archive when packaged -- two different distances from the root.
  return [facts.devRoot];
}

/**
 * Resolve one document name to a local file that is actually there.
 *
 * @param doc the name the renderer sent, already validated
 * @param roots directories to try, in order
 * @param exists existence check, injected so a test needs no package
 * @returns the absolute path, or the reason none of the candidates is a file
 */
export function resolveLegalDoc(
  doc: AboutDoc,
  roots: readonly string[],
  exists: (target: string) => boolean,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly detail: string } {
  const tried = roots.map((root) => path.join(root, ABOUT_DOC_FILES[doc]));
  const found = tried.find((candidate) => exists(candidate));

  if (found === undefined) {
    return {
      ok: false,
      detail: `${ABOUT_DOC_FILES[doc]} is not in the package; tried ${tried.join(", ")}`,
    };
  }

  return { ok: true, path: found };
}

/**
 * Narrow a document name that arrived over IPC.
 *
 * @param value the untrusted payload field
 * @returns the name, or `null` when it is not one of the three
 */
function asAboutDoc(value: unknown): AboutDoc | null {
  return value === "license" || value === "notice" || value === "third-party" ? value : null;
}

/**
 * Describe the last verification in the window's five words.
 *
 * `lastVerifiedAt` is the marker that separates "the state file says the entry
 * was missing" from "there is no state file": the recovered default carries
 * `lastResult: "missing"` as well, and rendering that as a failed check would
 * report a first launch as a defect.
 *
 * @param read the state as the runtime layer read it
 */
function lastResultOf(read: RuntimeStateRead): AboutEngineLastResult {
  if (read.recovered || read.state.lastVerifiedAt === "") return "unknown";

  switch (read.state.lastResult) {
    case "ok":
    case "entry-mismatch":
    case "tree-mismatch":
    case "missing":
      return read.state.lastResult;
    // `external-invalid` is in the persisted union but no writer stores it; a
    // file that contains it is not describing one of the four outcomes.
    default:
      return "unknown";
  }
}

/**
 * Decide where the engine this installation uses came from.
 *
 * A running engine's bundle path is the only observation of the present, so it
 * wins. With no live engine the recorded pick is the remaining evidence: an
 * external directory that was chosen is what the next start will try first,
 * and the bundled engine is what any start falls back to.
 *
 * @param liveBundlePath the running bundle, or `null`
 * @param bundledDir the bundled engine's directory
 * @param externalDir the recorded external pick, if any
 */
function sourceOf(
  liveBundlePath: string | null,
  bundledDir: string,
  externalDir: string | undefined,
): AboutEngineSource {
  if (liveBundlePath !== null) {
    const target = path.resolve(liveBundlePath);
    const bundled = path.resolve(bundledDir);

    if (target === path.resolve(bundled, "haruyuki.js")) return "bundled";
    if (externalDir !== undefined && externalDir !== "") {
      if (target.startsWith(path.resolve(externalDir) + path.sep)) return "external";
    }

    // Neither the bundled path nor the recorded pick: the bundle was found on
    // PATH, which is the only third way a start obtains one.
    return "path";
  }

  return externalDir === undefined || externalDir === "" ? "bundled" : "external";
}

/**
 * Read the bundled engine's version out of the lock.
 *
 * The lock is the authority -- the engine directory could be half-written, and
 * its `package.json` would then describe a version that is not the one the
 * packaged tree contains.
 *
 * @param lockPath absolute `runtime-lock.json`
 * @returns the version, or an empty string when the lock is absent or invalid
 */
async function bundledEngineVersion(lockPath: string): Promise<string> {
  try {
    const read = await readRuntimeLock(lockPath);

    return read.ok ? read.lock.engineVersion : "";
  } catch {
    return "";
  }
}

/**
 * Build the payload the window shows.
 *
 * Every read degrades instead of failing: a corrupt state file or a lock that
 * did not ship is a fact about the installation, and the window's job is to
 * report it, not to disappear.
 *
 * @param deps the composition root's facts
 */
async function readAboutInfo(deps: AboutIpcDeps): Promise<AboutInfo> {
  let read: RuntimeStateRead;

  try {
    read = await readRuntimeState(path.join(deps.userData, RUNTIME_STATE_FILE));
  } catch {
    read = { state: defaultRuntimeState(), recovered: true };
  }

  const externalDir = read.state.externalEngineDir;
  const live = deps.liveBundlePath === undefined ? null : deps.liveBundlePath();
  const source = sourceOf(live, deps.engineDir, externalDir);

  const version =
    source === "bundled"
      ? await bundledEngineVersion(deps.lockPath)
      : (read.state.externalEngineVersion ?? "");

  return {
    appVersion: deps.appVersion(),
    engine: { version, source, lastResult: lastResultOf(read) },
    runtime: {
      electron: deps.versions.electron,
      node: deps.versions.node,
      platform: deps.versions.platform,
      arch: deps.versions.arch,
    },
    repoUrl: ABOUT_REPO_URL,
    issueUrl: ABOUT_ISSUE_URL,
  };
}

/**
 * Open one of the three shipped documents.
 *
 * `shell.openPath` answers `""` on success and a message on failure, so the
 * result is checked rather than assumed: a window that said "opened" while the
 * file had no handler would be lying about the only thing the button does.
 *
 * @param deps the composition root's facts
 * @param doc the requested document
 */
async function openLegalDoc(deps: AboutIpcDeps, doc: AboutDoc): Promise<AboutOpenResult> {
  const resolved = resolveLegalDoc(doc, legalDocRoots(deps.paths), deps.exists ?? existsSync);

  if (!resolved.ok) {
    deps.logger?.warn("about.open.missing", { doc, detail: resolved.detail });

    return { ok: false, detail: resolved.detail };
  }

  try {
    const failure = await deps.openPath(resolved.path);

    if (failure !== "") {
      deps.logger?.warn("about.open.failed", { doc, path: resolved.path, detail: failure });

      return { ok: false, detail: failure };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    deps.logger?.warn("about.open.failed", { doc, path: resolved.path, detail });

    return { ok: false, detail };
  }

  // The path is logged because it is the evidence that a *local file* was
  // opened: the window claims nothing else, and a report that only said "ok"
  // could not be told apart from one that opened a page.
  deps.logger?.info("about.open", { doc, path: resolved.path });

  return { ok: true };
}

/**
 * Register the two channels, at most once per `ipcMain`.
 *
 * A second registration would throw inside Electron and a reload of the window
 * is a normal thing to happen, so the second call is a no-op. The disposer is
 * idempotent for the other half of the same reason: a teardown may run twice.
 *
 * @param deps the composition root's facts and the document opener
 * @returns a disposer that removes both handlers, at most once
 */
export function registerAboutIpc(deps: AboutIpcDeps): () => void {
  if (registered.has(deps.ipc as object)) return () => undefined;

  registered.add(deps.ipc as object);

  deps.ipc.handle(ABOUT_INFO_CHANNEL, async () => {
    try {
      return await readAboutInfo(deps);
    } catch (error) {
      // Unreachable in practice: every read above degrades. Kept because a
      // rejection here would leave the window with no facts at all, and an
      // empty window is indistinguishable from a broken one.
      deps.logger?.warn("about.info.failed", {
        detail: error instanceof Error ? error.message : String(error),
      });

      return {
        appVersion: "",
        engine: { version: "", source: "bundled", lastResult: "unknown" },
        runtime: deps.versions,
        repoUrl: ABOUT_REPO_URL,
        issueUrl: ABOUT_ISSUE_URL,
      } satisfies AboutInfo;
    }
  });

  deps.ipc.handle(ABOUT_OPEN_CHANNEL, async (_event, payload) => {
    const doc = asAboutDoc(
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)["doc"]
        : undefined,
    );

    if (doc === null) return { ok: false, detail: "doc must be license, notice or third-party" };

    return openLegalDoc(deps, doc);
  });

  let disposed = false;

  return () => {
    if (disposed) return;

    disposed = true;
    deps.ipc.removeHandler?.(ABOUT_INFO_CHANNEL);
    deps.ipc.removeHandler?.(ABOUT_OPEN_CHANNEL);
  };
}
