/**
 * Headless host port: `nine-item contract` (nine items) for a plain `node` process.
 *
 * `host-port.ts` owns the shape: `HostPortStartup` for the three startup items
 * file), 3.3(a) (HostPortStartup) and 5.1 (isolation rules) for the startup
 * every member - the semantics that apply to any shell, plus the headless
 * answers - and `host-port-contract.test.ts` and `headless-host-port.test.ts`
 * pin that reading case by case.
 *
 * This is the second implementation of the host port contract: the desktop
 * shell (D2) will answer `true` to some capabilities, while this one answers
 * `false` to all four and roots every path in a disposable directory. That makes
 * it the evidence for INIME safety ("every port method must be implementable
 * headlessly") and the reason docs/17-A3 section 4.2 calls this "the only real
 * implementation and the contract evidence for `HostPortStartup`".
 *
 * Deliberately out of scope: no state machine, no WebSocket, no stdout parsing
 * and no token content. Those belong to the log / snapshot assembly / `transport.ts` / . This module
 * only answers what the shell provides - "where may the engine write" (paths),
 * "how is it started" (the spawn spec) and the six host capabilities. One thing
 * it does own is the watchdog INJECTION string (decision D-02):
 * `runtime/watchdog.cjs` itself is the watchdog file, but composing `NODE_OPTIONS` is
 * part of building the spawn spec, so it lives here.
 *
 * The watchdog path is derived from `import.meta.url` and never imported. Two
 * reasons: the script is CommonJS meant to be preloaded into a different
 * process, and the bridge writes it concurrently, so a static import would couple our
 * build (and our test collection) to a file this package does not own.
 *
 * The six new items are all "record instead of perform" by construction: a
 * headless process has no browser to open, no dialog to show and no OS
 * notification channel. Each one therefore keeps a visible, inspectable trace
 * (`calls`) plus the exact frozen answer a real shell would give, so a test can
 * assert what the core asked for without a desktop shell and without a mock
 * framework.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EngineSpawnSpec } from "../engine/types";
import type { HostPort, HostPortStartup } from "./host-port";

/**
 * The four capabilities a headless host cannot provide.
 *
 * Frozen and shared: all four are constants of the implementation, and freezing
 * keeps a caller from mutating one instance's answer into another's. The
 * contract is `HostPortStartup["capabilities"]`, so this object is checked
 * against the frozen shape instead of being a second definition of it.
 */
const HEADLESS_CAPABILITIES: HostPortStartup["capabilities"] = Object.freeze({
  canNotify: false,
  canReadDroppedFiles: false,
  canPopout: false,
  canFloatingWindow: false,
});

/**
 * Engine argv before the bundle path: engine knowledge, not a host preference.
 *
 * `--ws-token-file` is the option NAME only: the token file path is appended by
 * `Engine.start` (it owns `tokenDir`), and the token value itself must never
 * appear in argv.
 */
const ENGINE_ARGV_PREFIX = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
] as const;

/** Where the watchdog script sits relative to this source file. */
const WATCHDOG_RELATIVE_PATH = "../runtime/watchdog.cjs";

/** Environment variable the engine reads to isolate its own state. */
const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/** Subdirectory names created under `engineHome`. */
const USER_DATA_DIR = "userData";
const LOGS_DIR = "logs";
const CACHE_DIR = "cache";
const TEMP_DIR = "temp";

/** Prefix of the disposable engine home created when the caller omits one. */
const TEMP_ENGINE_HOME_PREFIX = "haruyuki-headless-";

/**
 * The schemes `openExternal` accepts: `http:` and `https:` only.
 *
 * Authority: docs/01-3 section 2.2 item 4 ("only http:/https:, reject the
 * rest") and docs/17-A3 section 4.1 row 4 with the `A3-Q09` adjudication.
 * `mailto:` is deliberately absent - it is not a browser URL and the frozen
 * requirement rejects it with everything else.
 *
 * An allow-list, not a deny-list: `file:` would hand the renderer a way to open
 * local files in a system application and `javascript:` would execute inside
 * whatever the OS associates with the scheme, so the set of things we do not
 * know about has to be rejected by default.
 */
const ACCEPTED_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Options for {@link createHeadlessHostPort}.
 *
 * - `bundlePath`: engine entry point, and it must be absolute. It is stored
 *   verbatim and checked at spawn-spec time, because the bundle may be unpacked
 *   after the host is constructed.
 * - `engineHome`: root of all four directories. Omitted means a fresh
 *   `mkdtemp` directory, which is what tests and short-lived probes want.
 * - `tokenDir`: directory for the capability token file. The contract has no
 *   token field, and `paths.temp` is defined as "where short-lived isolates
 *   (token files, scratch state) must be created" (host-port.ts), so an explicit
 *   `tokenDir` becomes `paths.temp`. A relative value resolves against
 *   `engineHome`; a value outside `engineHome` is rejected instead of silently
 *   escaping the isolated root.
 * - `pickQueue`: the answers a `pickPaths` call will return, in order. One entry
 *   is consumed per call; an empty queue means the user cancelled . The rule is-A3
 *   section 4.1 row 5: "an injected queue gives a deterministic answer; an empty
 *   queue is a cancellation").
 * - `allowedRoots`: the whitelist for `resolveLocalResource`. Omitted means
 *   `[engineHome]` when `engineHome` was supplied and no root at all otherwise
 *   Relative entries are resolved against the host's cwd, once, at
 *   resolved against the host's cwd, once, at construction.
 * - `secureSeed`: initial contents of the in-memory secure store. Each port owns
 *   its own copy, so two ports never share a secret: persistence is in-process,
 *   row 3: "in-process persistence, not shared across instances").
 */
export type HeadlessHostPortOptions = {
  bundlePath: string;
  engineHome?: string;
  tokenDir?: string;
  pickQueue?: string[];
  allowedRoots?: string[];
  secureSeed?: Record<string, string>;
};

/**
 * The headless port plus its two implementation-specific additions. They are
 * this implementation. They are test-facing, but they are part of the exported
 * type because `@haruyuki/core` re-exports this module: a test that reaches for
 * `dispose` must not need a deep import.
 *
 * `dispose` exists because a plain node process has no OS shutdown event to hang
 * `onShutdown` callbacks on: the test or probe that built the port is the thing
 * that decides the host is going away. `calls` is the observable trace that
 * makes "the core asked for X" assertable without a desktop shell - it is the
 * headless reading of "openExternal only records the call" and friends.
 *
 * Both are additive. The nine contract members keep exactly the frozen shapes,
 * so a consumer that only knows `HostPort` cannot tell this implementation from
 * the desktop one.
 */
export type HeadlessHostPort = HostPort & {
  dispose(): Promise<void>;
  readonly calls: {
    openExternal: string[];
    notify: { level: string; message: string }[];
    pickPaths: number;
  };
};

/**
 * Build a headless {@link HeadlessHostPort}.
 *
 * Asynchronous on purpose: the factory performs real I/O (it creates four
 * directories, and may create the engine home itself), so it is a promise
 * rather than a synchronous constructor. A failure to create a directory
 * rejects here, where a bootstrap can classify it once, instead of surfacing
 * much later as a confusing ENOENT from the engine. Keeping the factory async
 * also matches the desktop shell, which resolves the same roots from
 * `app.whenReady()`.
 *
 * `paths` and `capabilities` are resolved once and returned as data, and the
 * watchdog location is fixed at construction; only the bundle existence check is
 * deferred to `getRuntimeSpawnSpec`, because the artifact may be unpacked after
 * the host is built.
 */
export async function createHeadlessHostPort(
  options: HeadlessHostPortOptions,
): Promise<HeadlessHostPort> {
  const createdHome = options.engineHome === undefined;
  const engineHome = await resolveEngineHome(options.engineHome);
  let paths: HostPortStartup["paths"];

  try {
    const tempDir = resolveTokenDir(engineHome, options.tokenDir);

    paths = {
      userData: join(engineHome, USER_DATA_DIR),
      logs: join(engineHome, LOGS_DIR),
      cache: join(engineHome, CACHE_DIR),
      temp: tempDir,
    };

    await Promise.all(
      [paths.userData, paths.logs, paths.cache, paths.temp].map((dir) =>
        mkdir(dir, { recursive: true }),
      ),
    );
  } catch (error) {
    // A home this factory created has no owner once construction fails, and the
    // caller never learns its path from a rejection, so it can never clean up.
    if (createdHome) {
      await rm(engineHome, { recursive: true, force: true }).catch(() => undefined);
    }

    throw error;
  }

  const watchdogPath = watchdogPathForNodeOptions();

  // Secure store: memory only, seeded from the options, private to this port.
  // A Map (not an object) so a key such as "__proto__" is a plain key.
  const secrets = new Map<string, string>(Object.entries(options.secureSeed ?? {}));

  // Dialog answers, consumed one per call. Copied so the caller's array is not
  // mutated by the port - a test that reuses one queue for two ports would
  // otherwise see the second port start half-consumed.
  const pickQueue = [...(options.pickQueue ?? [])];

  const allowedRoots = resolveAllowedRoots(
    options.allowedRoots,
    engineHome,
    options.engineHome !== undefined,
  );

  const shutdownCallbacks: (() => void)[] = [];

  const calls: HeadlessHostPort["calls"] = {
    openExternal: [],
    notify: [],
    pickPaths: 0,
  };

  let disposed = false;

  return {
    capabilities: HEADLESS_CAPABILITIES,
    paths,
    // The trace is exposed as data, not as a getter: a test that holds the port
    // keeps seeing the same array it can assert on.
    calls,

    async getRuntimeSpawnSpec() {
      // Existence is re-checked on every call: callers construct the port
      // before the engine artifact is unpacked, so a construction-time check
      // would refuse a bundle that appears moments later.
      //
      // The path must be absolute: the contract fixes an absolute engine JS
      // engine JS bundle path). A relative one would resolve against the host's
      // cwd here but against `paths.userData` in the child, so it would look
      // valid and then fail at spawn time with an ENOENT nobody can explain.
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
        // In the headless the interpreter is the current Node binary; the
        // Electron shell will pass electron.exe plus ELECTRON_RUN_AS_NODE.
        exePath: process.execPath,
        // A complete environment: callers must not merge process.env again.
        // An inherited NODE_OPTIONS is intentionally replaced, not appended,
        // so the engine child is preloaded with the watchdog and nothing else.
        env: {
          ...environmentWithoutUndefined(),
          [ENGINE_HOME_ENV]: engineHome,
          NODE_OPTIONS: `--require "${watchdogPath}"`,
        },
        argvPrefix: [...ENGINE_ARGV_PREFIX],
        bundlePath: options.bundlePath,
        // The engine writes its default file tree and state under cwd, so cwd
        // must be the isolated userData directory.
        cwd: paths.userData,
        // stdout carries the "WebSocket:" line and stdin is the watchdog
        // signal, so both must be piped.
        stdio: "pipe",
        windowsHide: true,
        // POSIX gets its own process group so the stop path can signal the whole
        // group and take the engine's descendants with it: `detached` creates
        // "detached: POSIX creates a process group, used by the watchdog and by
        // tree killing"; section 4.2: without it "orphan control stops working").
        // Windows has no process groups in this sense; there the stop path
        // forces `taskkill /T /F` instead.
        detached: process.platform !== "win32",
      };

      return { ok: true, spec };
    },

    async secureGet(key) {
      // `Map.get` distinguishes an absent key from a stored empty string, which
      // is the distinction `NOT_FOUND` exists for. `STORAGE_UNAVAILABLE` is part
      // of the frozen union but unreachable here: an in-memory store cannot be
      // unavailable, and answering a code the host cannot produce would only
      // invent a failure mode.
      const value = secrets.get(key);

      if (value === undefined) {
        return { ok: false, code: "NOT_FOUND" };
      }

      return { ok: true, value };
    },

    async secureSet(key, value) {
      // Overwriting is the normal refresh path and never throws: the store is a
      // Map, so there is no I/O and therefore no partial write to guard against.
      // The value stays in process memory only, never on disk as plaintext
      // : persistence is in-process, row 3: "never plaintext at rest").
      secrets.set(key, value);

      return { ok: true };
    },

    async secureDelete(key) {
      // Deleting an absent key is a success, so a cleanup path never has to
      // read first.
      secrets.delete(key);

      return { ok: true };
    },

    async openExternal(url) {
      // A rejected URL is NOT recorded: `calls.openExternal` is meant to answer
      // "what did the core successfully ask the shell to open", and counting a
      // refusal there would make the trace disagree with the return value.
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

      // One queued answer per call, whatever `kind`/`multiple` say. The queue is
      // the whole deterministic answer of a headless host, so a caller that wants
      // two paths in one `multiple: true` call queues one entry per call
      // instead. An empty queue is the documented cancellation, which is `[]`
      // and not an error .
      const picked = pickQueue.shift();

      return picked === undefined ? [] : [picked];
    },

    async resolveLocalResource(absPath) {
      // Purely lexical containment: nothing is read, stat'ed or realpath'ed.
      // That keeps the member answerable for a path that does not exist yet and
      // keeps it free of I/O failures, which is what `OUT_OF_ROOT` versus
      // success needs to mean. A non-absolute input (a `..`-only string, a
      // drive-relative `C:foo`) is `OUT_OF_ROOT` too - there is no root a
      // relative path could be inside of.
      if (!isAbsolute(absPath)) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      const candidate = resolve(absPath);

      if (!allowedRoots.some((root) => isInsideRoot(root, candidate))) {
        return { ok: false, code: "OUT_OF_ROOT" };
      }

      // `file://` is the headless equivalent of the desktop's custom protocol
      // and VSCode's `asWebviewUri`. Built with
      // `pathToFileURL` rather than string concatenation so Windows drive
      // letters and spaces get the encoding the URL spec requires.
      return { ok: true, url: pathToFileURL(candidate).href };
    },

    onShutdown(cb) {
      // Synchronous registration, by contract.
      // Nothing is invoked here: `dispose` is the headless trigger.
      shutdownCallbacks.push(cb);
    },

    async notify(level, message) {
      // `canNotify` is false, so the documented answer is silent success
      // message is recorded first so a test can assert the text and level the
      // can assert the text and level the core tried to raise.
      calls.notify.push({ level, message });
    },

    async readDroppedFiles(_files) {
      // Unconditional, by requirement: docs/17-A3 section 4.1 row 9 ("returns
      // `unsupported`"), the `A3-Q09` adjudication, docs/01-3 section 2.2 item
      // 9 and the headless column of docs/01-3 section 2.3. The `ok` branch of
      // the frozen union exists for the other hosts, not for this one.
      //
      // The answer does not depend on the input, so a name-only entry, an entry
      // with a path and an empty list all get the same refusal. Nothing is read
      // either, which is why no `base64` can be produced and why no read can
      // leave `allowedRoots`.
      return { ok: false, code: "UNSUPPORTED" };
    },

    async dispose() {
      // Idempotent: a second call (or a shutdown racing a test teardown) must not
      // run a callback twice, because callbacks stop child processes.
      if (disposed) {
        return;
      }

      disposed = true;

      // Reversing the array is not the same as reversing the order: take the
      // callbacks out in registration order and run them in that order, so
      // "first registered, first invoked" holds.
      const pending = shutdownCallbacks.splice(0, shutdownCallbacks.length);
      let failure: { error: unknown } | undefined;

      for (const callback of pending) {
        try {
          callback();
        } catch (error) {
          // One bad callback must not strand the others: shutdown work is
          // process cleanup, so every registered callback runs even when an
          // earlier one threw. The first error is rethrown afterwards, because
          // swallowing it would hide a broken teardown.
          failure ??= { error };
        }
      }

      if (failure !== undefined) {
        throw failure.error;
      }
    },
  };
}

/**
 * Resolve the engine home, creating a disposable one when omitted.
 */
async function resolveEngineHome(engineHome: string | undefined): Promise<string> {
  if (engineHome !== undefined) {
    return resolve(engineHome);
  }

  return mkdtemp(join(tmpdir(), TEMP_ENGINE_HOME_PREFIX));
}

/**
 * Resolve `paths.temp` and keep it inside `engineHome`.
 *
 * Isolation is a hard rule, not a preference: a token directory outside the
 * engine home would write a secret next to unrelated data and would let the
 * engine's default file tree escape too. Rejecting the input is louder than
 * quietly falling back, so the caller learns its configuration is wrong.
 */
function resolveTokenDir(engineHome: string, tokenDir: string | undefined): string {
  if (tokenDir === undefined) {
    return join(engineHome, TEMP_DIR);
  }

  const absolute = resolve(engineHome, tokenDir);
  const fromHome = relative(engineHome, absolute);

  // Mirror `isInsideRoot`: a sibling named "..tokens" is inside, only ".." and
  // "../..." are outside. A bare `startsWith("..")` would reject that name.
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error(`tokenDir must stay inside engineHome: ${absolute} is outside ${engineHome}`);
  }

  return absolute;
}

/**
 * Resolve the `resolveLocalResource` whitelist.
 *
 * The default is `[engineHome]`, but only when the caller actually supplied an
 * engine home , so the corpus-A3 section 3.4.1: "default = [engineHome], otherwise no
 * root is allowed"). When the factory created its own `mkdtemp` directory the
 * caller never saw that path, so treating it as an implicit grant would let a
 * resource be resolved against a directory the caller cannot reason about; an
 * empty whitelist makes the refusal explicit instead.
 */
function resolveAllowedRoots(
  allowedRoots: readonly string[] | undefined,
  engineHome: string,
  hasConfiguredEngineHome: boolean,
): string[] {
  if (allowedRoots !== undefined) {
    // Absolute entries are normalised (`..` collapsed) as well as relative ones,
    // because the containment test compares resolved paths.
    return allowedRoots.map((root) => resolve(root));
  }

  return hasConfiguredEngineHome ? [engineHome] : [];
}

/**
 * True when `candidate` is `root` itself or a descendant of it.
 *
 * Both arguments are already absolute and resolved. The comparison is lexical:
 * a symlink inside the root that points outside it is still reported as inside,
 * because detecting that would need a `realpath` call and this member must
 * answer without I/O. That limit is recorded as an open question rather than
 * guessed at.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);

  // Same directory.
  if (fromRoot === "") {
    return true;
  }

  // Another drive or UNC share: `relative` answers an absolute path.
  if (isAbsolute(fromRoot)) {
    return false;
  }

  // The parent (or any ancestor) is outside. The separator check keeps a
  // sibling named "..foo" from being mistaken for an escape.
  return fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`);
}

/**
 * True when `raw` parses as a URL whose scheme is on the frozen allow-list.
 *
 * `new URL` is the parser on purpose: it rejects relative strings and
 * unparsable input (`https://`, `not a url`) with a `TypeError`, which is
 * exactly the "unparsable" case the contract maps to `REJECTED_SCHEME`.
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

/**
 * Absolute `NODE_OPTIONS` path of the watchdog, in the form Node can parse.
 *
 * Windows paths use forward slashes here because Node's NODE_OPTIONS parser
 * (measured on Node 24.22.3, Windows 10.0.19045) treats a backslash inside the
 * double quotes as an escape and strips it: `"C:\\Users\\..."` arrives as
 * `C:Users...` and the preload fails with MODULE_NOT_FOUND. A quoted path with
 * forward slashes - or with every backslash doubled - loads correctly, and both
 * forms keep the space-containing path as one argument. Forward slashes are
 * used because they are also valid absolute paths on Windows and need no
 * doubling, and because POSIX paths are already in that form.
 *
 * The result is absolute on both platforms. The quotes are what preserve
 * spaces; Node strips them from the parsed argument.
 */
function watchdogPathForNodeOptions(): string {
  const absolute = fileURLToPath(new URL(WATCHDOG_RELATIVE_PATH, import.meta.url));

  return process.platform === "win32" ? absolute.split("\\").join("/") : absolute;
}

/**
 * Copy `process.env` into the string-valued record the spawn spec requires.
 *
 * Spreading `process.env` directly would type each value as `string |
 * undefined`, which `Record<string, string>` does not accept; the entries Node
 * cannot represent are dropped. This mirrors what `spawn` does internally.
 */
function environmentWithoutUndefined(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  return env;
}
