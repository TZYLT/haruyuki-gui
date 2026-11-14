/**
 * Desktop host-port double: the `HostPort` shape an Electron shell provides.
 *
 * Scope: the nine members of `HostPort` and the unions they return, declared in
 * 4.2 (A3 delivers a test double, D2 delivers the real shell). The nine members
 * This module delivers only the test double; the real Electron shell lives in
 * `apps/desktop`.
 *
 * Shape only, on purpose. This module does not import `electron`, does not
 * touch the OS keychain and never spawns a process: the three things that make
 * a desktop shell special are modelled as data, so the same double runs in a
 * plain `node` process on any platform and the parity suite can compare it with
 * the headless port and the VSCode double.
 *
 * What is modelled from the real shell:
 *
 * - `paths` come from the caller, the way `app.getPath` supplies them.
 * - `getRuntimeSpawnSpec` uses the running binary as `exePath` - in Electron
 *   that is `electron.exe` - and passes `ELECTRON_RUN_AS_NODE=1`, the flag the
 *   desktop shell must set or the child starts a second full Electron app
 *   : "nobody picked item 2b).
 * - `resolveLocalResource` answers a custom-protocol URL, the desktop
 *   counterpart of `asWebviewUri`.
 * - `secure*` is an in-memory `Map` standing in for the OS keychain. A Map
 *   distinguishes an absent key from a stored empty string, which is the
 *   distinction `NOT_FOUND` exists for. `STORAGE_UNAVAILABLE` stays in the
 *   frozen union but is unreachable here: a Map cannot be unavailable, and
 *   answering a code the double cannot produce would invent a shell failure.
 * - `pickPaths` consumes an injected queue; an empty queue is the documented
 *   cancellation, `[]`.
 * - `readDroppedFiles` hands back the paths the drop carried. Electron drops
 *   expose a readable absolute path, so this shell can use the `path` half of
 *   the frozen union instead of base64.
 * - `onShutdown` registers synchronously; `triggerShutdown` is the double's
 *   stand-in for `before-quit`, because a headless process has no OS event to
 *   hang the callbacks on.
 *
 * Deliberately absent: real capability probing, a real dialog, a real
 * notification channel, path containment beyond the lexical rule the contract
 * asks for, and any I/O in `readDroppedFiles`. A double that performed those
 * would stop being runnable in the test process that needs it.
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { EngineSpawnSpec } from "../../engine/types";
import type { HostPort, HostPortStartup } from "../../port/host-port";

/**
 * The desktop answer to the four capability flags.
 *
 * All four are true: a desktop window can raise an OS notification, a native
 * drop carries a path, and both popping a panel out and floating a window are
 * window-manager features. That is the opposite of the headless answer and
 * differs from the VSCode double on the two window flags.
 */
const DESKTOP_CAPABILITIES: HostPortStartup["capabilities"] = Object.freeze({
  canNotify: true,
  canReadDroppedFiles: true,
  canPopout: true,
  canFloatingWindow: true,
});

/**
 * Engine argv before the bundle path (docs/13 section 4.2 / no recursive section
 * 2.2). `--ws-token-file` is the option name; the token path and value are the
 * engine facade's business, never the host's.
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

/**
 * The Electron flag that turns the child back into a plain Node process.
 *
 * Missing it starts a second Electron application : "nobody picked item
 * 2b), which is the failure this double exists to make visible in the spawn
 * spec.
 */
const ELECTRON_RUN_AS_NODE_ENV = "ELECTRON_RUN_AS_NODE";

/** Schemes `openExternal` accepts: a security boundary, not a preference. */
const ACCEPTED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Default custom scheme used by `resolveLocalResource`. */
const DEFAULT_PROTOCOL_SCHEME = "haruyuki-resource";

/**
 * The trace a test can assert without a mock framework.
 *
 * The member names mirror the headless port's trace, so the parity suite can
 * compare "what the core asked for" across the three adapters instead of
 * comparing only return values.
 */
export type DesktopHostPortCalls = {
  openExternal: string[];
  notify: { level: string; message: string }[];
  pickPaths: number;
};

/**
 * Options for {@link createDesktopHostPort}.
 *
 * - `bundlePath`: engine entry point; checked at spawn-spec time, like the real
 *   shell, because the artifact may be unpacked after the port is built.
 * - `paths`: the four `app.getPath` roots. Supplied rather than derived so a
 *   test owns the tree it creates and cleanup stays point-by-point.
 * - `allowedRoots`: whitelist for `resolveLocalResource`; defaults to
 *   `[paths.userData]`.
 * - `pickQueue`: answers a `pickPaths` call returns, in order. An empty queue is
 *   a cancellation.
 * - `secureSeed`: initial keychain contents. Each port owns its own copy.
 * - `protocolScheme`: override for the custom protocol, for a test that wants
 *   to prove the URL is not hardcoded.
 */
export type DesktopHostPortOptions = {
  bundlePath: string;
  paths: HostPortStartup["paths"];
  allowedRoots?: string[];
  pickQueue?: string[];
  secureSeed?: Record<string, string>;
  protocolScheme?: string;
};

/**
 * The desktop port plus the two double-only additions: a trace and a shutdown
 * trigger. Neither is part of `HostPort`; a consumer that only knows the
 * contract cannot see them.
 */
export type DesktopHostPort = HostPort & {
  readonly calls: DesktopHostPortCalls;
  /** Model `before-quit`: run the registered callbacks once. */
  triggerShutdown(): void;
};

/**
 * Build a desktop {@link DesktopHostPort}.
 *
 * Asynchronous to match the real shell, which resolves `app.getPath` roots
 * after `app.whenReady()` and may unpack its bundle first. The factory creates
 * the four directories so a caller can resolve resources inside them
 * immediately.
 */
export async function createDesktopHostPort(
  options: DesktopHostPortOptions,
): Promise<DesktopHostPort> {
  const paths = options.paths;
  const scheme = options.protocolScheme ?? DEFAULT_PROTOCOL_SCHEME;

  await Promise.all(
    [paths.userData, paths.logs, paths.cache, paths.temp].map((dir) =>
      mkdir(dir, { recursive: true }),
    ),
  );

  // Secure store: memory only, seeded from the options, private to this port.
  // A Map (not an object) so a key such as "__proto__" is a plain key.
  const secrets = new Map<string, string>(Object.entries(options.secureSeed ?? {}));

  // Dialog answers, consumed one per call, copied so the caller's array is not
  // mutated by the port.
  const pickQueue = [...(options.pickQueue ?? [])];

  const allowedRoots = (options.allowedRoots ?? [paths.userData]).map((root) => resolve(root));

  const shutdownCallbacks: (() => void)[] = [];

  const calls: DesktopHostPortCalls = {
    openExternal: [],
    notify: [],
    pickPaths: 0,
  };

  let shutdown = false;

  return {
    capabilities: DESKTOP_CAPABILITIES,
    // A copy, so a caller mutating the options object cannot change the roots a
    // later call resolves against.
    paths: { ...paths },
    calls,

    async getRuntimeSpawnSpec() {
      // Same two refusal modes as the headless port: a relative bundle would
      // resolve against the parent's cwd at spawn time while the host checked
      // it against its own, and a missing bundle has no spec to describe.
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
        // Electron's `process.execPath` is the app binary, so the child needs
        // the flag below to behave as Node instead of as a second app.
        exePath: process.execPath,
        env: {
          // A complete environment is the caller's job in the real shell; the
          // double carries only the two variables that are contractual, so a
          // test does not inherit the machine's env.
          [ELECTRON_RUN_AS_NODE_ENV]: "1",
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
      // `Map.get` distinguishes an absent key from a stored empty string. An
      // empty secret is still a secret the caller stored; only `undefined`
      // means absent.
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
      // Every call counts, including a cancelled one.
      calls.pickPaths += 1;

      const picked = pickQueue.shift();

      return picked === undefined ? [] : [picked];
    },

    async resolveLocalResource(absPath) {
      // Purely lexical containment, like the headless port: nothing is read or
      // stat'ed, so the member answers for a path that does not exist yet.
      if (!isAbsolute(absPath)) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      const candidate = resolve(absPath);

      if (!allowedRoots.some((root) => isInsideRoot(root, candidate))) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      return { ok: true, url: customProtocolUrl(scheme, candidate) };
    },

    onShutdown(cb) {
      // Synchronous registration, by contract.
      shutdownCallbacks.push(cb);
    },

    async notify(level, message) {
      // The double records the attempt and resolves; a real shell would show
      // the OS notification here.
      calls.notify.push({ level, message });
    },

    async readDroppedFiles(files) {
      // Electron drops expose readable absolute paths, so the `path` half of
      // the union is used. An entry that carries no path cannot be turned into
      // one, and inventing a base64 payload would misdescribe the shell.
      return {
        ok: true,
        entries: files.map((file) =>
          file.path === undefined ? { name: file.name } : { name: file.name, path: file.path },
        ),
      };
    },

    triggerShutdown() {
      // Idempotent: a second quit event must not re-run callbacks that stop
      // child processes.
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
 * Turn an absolute path into a custom-protocol URL the renderer can load.
 *
 * The real shell registers the scheme with `protocol.handle` and maps the URL
 * back to the file; this double only fixes the shape, which is what the parity
 * suite compares. Segments are percent-encoded separately so spaces and the
 * Windows drive colon survive a round trip.
 */
function customProtocolUrl(scheme: string, absPath: string): string {
  const encoded = absPath
    .split(sep)
    .join("/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
    .replace(/^\/+/, "");

  return `${scheme}://local/${encoded}`;
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
