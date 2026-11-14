/**
 * VSCode host-port double: the `HostPort` shape a webview shell provides.
 *
 * Scope: the nine members of `HostPort` and the unions they return, declared in
 * `packages/core/src/port/host-port.ts`, read on the VSCode side. This module
 * delivers only the test double; the real extension lives in `apps/vscode`.
 * module does not import `vscode`, does not touch `context.secrets` and never
 * opens a dialog, so it runs in a plain `node` process next to the headless port
 * and the desktop double.
 *
 * What is modelled from the real shell:
 *
 * - `paths` derive from `context.globalStorageUri`. The option is a `file:` URI
 *   like that Uri, and the four roots are subdirectories of it - that is the
 *   difference from the desktop shell's `app.getPath` answer.
 * - `getRuntimeSpawnSpec` uses a `node` binary, not `process.execPath`: the
 *   extension host starts the engine as a plain Node child, so the Electron
 *   `ELECTRON_RUN_AS_NODE` flag has no meaning here.
 * - `resolveLocalResource` answers an `asWebviewUri`-shaped URL. The real
 *   `asWebviewUri` is a Webview instance method, so the contract note in
 *   webview and never to a global singleton. The double takes the same shape but
 *   singleton. The double takes the same shape but no real webview.
 * - `secure*` is an in-memory `Map` standing in for `context.secrets`.
 *   `globalState` would be plaintext and must never hold credentials, which is
 *   why the double does not model one. `STORAGE_UNAVAILABLE` stays in the
 *   frozen union but is unreachable here - a Map cannot be unavailable.
 * - `pickPaths` consumes an injected queue; an empty queue is the documented
 *   cancellation, `[]`.
 * - `readDroppedFiles` answers `base64` entries. A webview drop cannot hand a
 *   readable path to the extension, so this shell uses the content half of the
 *   union; `droppedContent` injects the bytes the shell would read.
 * - `onShutdown` registers synchronously; `triggerShutdown` is the double's
 *   stand-in for extension deactivation.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { EngineSpawnSpec } from "../../engine/types";
import type { HostPort, HostPortStartup } from "../../port/host-port";

/**
 * The VSCode answer to the four capability flags.
 *
 * A webview can show a notification and receive a drop, but it cannot pop a
 * panel into its own window or float a window - those are desktop window
 * operations. The double therefore differs from desktop on exactly those two
 * flags, which is what the parity suite asserts.
 */
const VSCODE_CAPABILITIES: HostPortStartup["capabilities"] = Object.freeze({
  canNotify: true,
  canReadDroppedFiles: true,
  canPopout: false,
  canFloatingWindow: false,
});

/**
 * Engine argv before the bundle path. Invoking the engine is engine knowledge,
 * not a shell preference, so every host passes the same prefix.
 */
const ENGINE_ARGV_PREFIX = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
] as const;

/** Environment variable the engine reads to isolate its own state. */
const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/** Schemes `openExternal` accepts: a security boundary, not a preference. */
const ACCEPTED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Authority `asWebviewUri` resolves to on desktop. It is an `https:` URL served
 * by the extension host, not a `file:` URL, which is the whole point of the
 * member: the webview cannot read the file system directly.
 */
const WEBVIEW_URI_ORIGIN = "https://file+.vscode-resource.vscode-cdn.net";

/** Default executable for the engine child when no override is supplied. */
const DEFAULT_NODE_PATH = "node";

/** Subdirectories created under the global storage root, one per contract path. */
const USER_DATA_DIR = "userData";
const LOGS_DIR = "logs";
const CACHE_DIR = "cache";
const TEMP_DIR = "temp";

/**
 * The trace a test can assert without a mock framework. Names mirror the
 * headless port's trace so the parity suite compares "what the core asked for"
 * across the three adapters.
 */
/**
 * A complete child environment, with `undefined` entries dropped.
 *
 * `EngineSpawnSpec.env` is documented as complete - the caller passes it to the
 * spawn without merging `process.env` again - so a double that hands over only
 * its own variable describes a child with no `PATH` and no `TEMP`, which is not
 * a thing a shell can spawn. The real shells fill this from their own
 * environment; the double inherits the test process's.
 */
function completeEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}

export type VscodeHostPortCalls = {
  openExternal: string[];
  notify: { level: string; message: string }[];
  pickPaths: number;
};

/**
 * Options for {@link createVscodeHostPort}.
 *
 * - `bundlePath`: engine entry point; checked at spawn-spec time, because the
 *   extension may unpack its bundle after activation.
 * - `globalStorageUri`: the `context.globalStorageUri` value as a `file:` URI.
 *   The four contract paths are subdirectories of it.
 * - `allowedRoots`: whitelist for `resolveLocalResource`; defaults to
 *   `[paths.userData]`.
 * - `pickQueue`: answers a `pickPaths` call returns, in order; empty means the
 *   user cancelled.
 * - `secureSeed`: initial `context.secrets` contents, private to this instance.
 * - `nodePath`: engine interpreter. Defaults to `node`; a test can pin it.
 * - `droppedContent`: UTF-8 text per dropped file name. The shell reads the
 *   bytes; the double takes them as data so the test never depends on the file
 *   system state of a drop.
 */
export type VscodeHostPortOptions = {
  bundlePath: string;
  globalStorageUri: string;
  allowedRoots?: string[];
  pickQueue?: string[];
  secureSeed?: Record<string, string>;
  nodePath?: string;
  droppedContent?: Record<string, string>;
};

/**
 * The VSCode port plus the two double-only additions: a trace and a shutdown
 * trigger. Neither is part of `HostPort`.
 */
export type VscodeHostPort = HostPort & {
  readonly calls: VscodeHostPortCalls;
  /** Model extension deactivation: run the registered callbacks once. */
  triggerShutdown(): void;
};

/**
 * Build a VSCode {@link VscodeHostPort}.
 *
 * Asynchronous to match the real extension host, which resolves its storage
 * roots during activation. The factory creates the four directories so a caller
 * can resolve resources inside them immediately.
 */
export async function createVscodeHostPort(
  options: VscodeHostPortOptions,
): Promise<VscodeHostPort> {
  const storageRoot = resolve(fileURLToPath(options.globalStorageUri));
  const nodePath = options.nodePath ?? DEFAULT_NODE_PATH;

  const paths: HostPortStartup["paths"] = {
    userData: join(storageRoot, USER_DATA_DIR),
    logs: join(storageRoot, LOGS_DIR),
    cache: join(storageRoot, CACHE_DIR),
    temp: join(storageRoot, TEMP_DIR),
  };

  await Promise.all(
    [paths.userData, paths.logs, paths.cache, paths.temp].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );

  // `context.secrets` stand-in: memory only, seeded from the options, private to
  // this port. A Map (not an object) so a key such as "__proto__" stays a plain
  // key, and so an absent key is distinguishable from a stored empty string.
  const secrets = new Map<string, string>(Object.entries(options.secureSeed ?? {}));

  // Dialog answers, consumed one per call, copied so the caller's array is not
  // mutated by the port.
  const pickQueue = [...(options.pickQueue ?? [])];

  const allowedRoots = (options.allowedRoots ?? [paths.userData]).map((root) => resolve(root));

  const droppedContent = options.droppedContent ?? {};

  const shutdownCallbacks: (() => void)[] = [];

  const calls: VscodeHostPortCalls = {
    openExternal: [],
    notify: [],
    pickPaths: 0,
  };

  let shutdown = false;

  return {
    capabilities: VSCODE_CAPABILITIES,
    paths,
    calls,

    async getRuntimeSpawnSpec() {
      // Same two refusal modes as the other hosts: a relative bundle would
      // resolve against a different cwd at spawn time, and a missing bundle has
      // no spec to describe.
      if (!isAbsolute(options.bundlePath)) {
        return {
          ok: false,
          reason: `engine bundle path must be absolute: ${options.bundlePath}`,
        };
      }

      if (!existsSync(options.bundlePath)) {
        return { ok: false, reason: `engine bundle not found: ${options.bundlePath}` };
      }

      const spec: EngineSpawnSpec = {
        // A plain Node child. The VSCode extension host is not Electron's main
        // process, so `process.execPath` plus `ELECTRON_RUN_AS_NODE` is not the
        // VSCode answer.
        exePath: nodePath,
        env: {
          // Complete, as `EngineSpawnSpec.env` requires: the caller spawns with
          // this object and never merges `process.env` again.
          ...completeEnvironment(),
          // The isolation root is the user-data directory, the path a shell has
          // on every platform (`context.globalStorageUri` on VSCode).
          [ENGINE_HOME_ENV]: paths.userData,
        },
        argvPrefix: [...ENGINE_ARGV_PREFIX],
        bundlePath: options.bundlePath,
        // The engine writes its default file tree under cwd, so cwd is the
        // isolated userData root.
        cwd: paths.userData,
        stdio: "pipe",
        windowsHide: true,
        // POSIX gets its own process group so the stop path can signal the whole
        // group; Windows has no equivalent and uses `taskkill /T /F`.
        detached: process.platform !== "win32",
      };

      return { ok: true, spec };
    },

    async secureGet(key) {
      // Same absent-versus-empty distinction as the headless port: only
      // `undefined` means NOT_FOUND.
      const value = secrets.get(key);

      if (value === undefined) {
        return { ok: false, code: "NOT_FOUND" };
      }

      return { ok: true, value };
    },

    async secureSet(key, value) {
      // Overwriting is the token-refresh path and is not an error.
      secrets.set(key, value);

      return { ok: true };
    },

    async secureDelete(key) {
      // Idempotent: deleting an absent key is still a success.
      secrets.delete(key);

      return { ok: true };
    },

    async openExternal(url) {
      // Only accepted URLs are traced: the trace answers what the shell was
      // actually asked to open.
      if (!isAcceptedExternalUrl(url)) {
        return { ok: false, code: "REJECTED_SCHEME" };
      }

      calls.openExternal.push(url);

      return { ok: true };
    },

    async pickPaths(_opts) {
      // Every call counts, including a cancelled one: the counter records how
      // many dialogs the core opened, which is what a test asserts about
      // behaviour, while the return value records the outcome.
      calls.pickPaths += 1;

      // One queued answer per call, whatever `kind`/`multiple` say. This host
      // answers a multi-select call with at most one path, which the replay engine
      // 3.4.1.1 S-3 freezes for this version: the queue is the whole
      // deterministic answer of a host, and no consumer asks for several yet. An
      // empty queue is the documented cancellation, which is `[]` and not an
      // error .
      const picked = pickQueue.shift();

      return picked === undefined ? [] : [picked];
    },

    async resolveLocalResource(absPath) {
      // Purely lexical containment: nothing is read or stat'ed, so the member
      // answers for a path that does not exist yet.
      if (!isAbsolute(absPath)) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      const candidate = resolve(absPath);

      if (!allowedRoots.some((root) => isInsideRoot(root, candidate))) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      return { ok: true, url: asWebviewLikeUri(candidate) };
    },

    onShutdown(cb) {
      // Synchronous registration, by contract.
      shutdownCallbacks.push(cb);
    },

    async notify(level, message) {
      // The double records the attempt and resolves; a real extension would call
      // `window.showInformationMessage` and friends here.
      calls.notify.push({ level, message });
    },

    async readDroppedFiles(files) {
      // A webview drop cannot expose a readable path, so this shell uses the
      // content half of the frozen union. The injected content stands in for the
      // bytes the extension host would read; a missing entry is an empty file,
      // not an error.
      return {
        ok: true,
        entries: files.map((file) => ({
          name: file.name,
          base64: Buffer.from(droppedContent[file.name] ?? "", "utf8").toString("base64"),
        })),
      };
    },

    triggerShutdown() {
      // Idempotent: a second deactivate event must not re-run callbacks.
      if (shutdown) {
        return;
      }

      shutdown = true;

      const pending = shutdownCallbacks.splice(0, shutdownCallbacks.length);

      for (const callback of pending) {
        callback();
      }
    },
  };
}

/**
 * Turn an absolute path into an `asWebviewUri`-shaped URL.
 *
 * The real member returns an `https:` URL under the webview's resource
 * authority; this double fixes that shape so the parity suite can compare a
 * URL's provenance without a webview. Segments are percent-encoded separately
 * so spaces and the Windows drive colon survive a round trip.
 */
function asWebviewLikeUri(absPath: string): string {
  const encoded = absPath
    .split(sep)
    .join("/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
    .replace(/^\/+/, "");

  return `${WEBVIEW_URI_ORIGIN}/${encoded}`;
}

/**
 * True when `candidate` is `root` itself or a descendant of it.
 *
 * Both arguments are already absolute and resolved. The comparison is lexical:
 * a symlink inside the root that points outside is still reported as inside,
 * because detecting that would need I/O the contract does not ask for.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);

  if (fromRoot === "") {
    return true;
  }

  // Another drive or UNC share: `relative` answers an absolute path.
  if (isAbsolute(fromRoot)) {
    return false;
  }

  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

/**
 * True when `raw` parses as a URL whose scheme is on the frozen allow-list.
 *
 * `new URL` is the parser on purpose: it rejects relative and unparsable input
 * with a `TypeError`, which is the "unparsable" case the contract maps to
 * `REJECTED_SCHEME`.
 */
function isAcceptedExternalUrl(raw: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  return ACCEPTED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
}
