/**
 * The VSCode host port: what the extension host offers the core, implemented
 * against the real extension APIs.
 *
 * This file is the host half. The core half is `../core/host-port-proxy.ts`,
 * which is the same object as seen from the child process and can only reach
 * the host through the pipe in `../core/ipc.ts`. Two members therefore have no
 * proxy at all, because the pipe carries no message for them:
 * `getRuntimeSpawnSpec` and `resolveLocalResource` are answered here and handed
 * to the child as data at a later wiring stage.
 *
 * Four decisions worth stating, because each one is a place a shell usually
 * gets this wrong:
 *
 * 1. `canPopout` and `canFloat` are `false` on purpose. A VS Code webview
 *    cannot pop a panel into its own OS window or float one; that is a desktop
 *    window operation. The `false` is a refusal the core is told about, not a
 *    feature that was left out.
 * 2. `resolveLocalResource` takes the webview. `asWebviewUri` belongs to one
 *    `Webview` instance and its origin differs per instance, so a cached URI
 *    from another panel would load the wrong resource (or be refused by that
 *    panel's CSP). The port therefore holds no webview and resolves per call.
 * 3. Secrets only ever live in the memory of one call. The store is
 *    `context.secrets` (see `./secrets.ts`); nothing here writes to
 *    `globalState`, argv, an environment variable or a log line.
 * 4. `getRuntimeSpawnSpec` describes a process, it does not start one. Starting
 *    the engine is the core's job; a host that spawned here would race the
 *    child that is supposed to own the engine's lifetime.
 *
 * Everything the platform provides is injected (the secret storage, the storage
 * root, the file-URI factory, the process environment), so this module runs in a
 * plain `node` process and its failure paths are testable without an extension
 * host. The only VS Code dependency is a type import, which the compiler erases.
 */

import { isAbsolute, join } from "node:path";

import type { EngineSpawnSpec } from "@haruyuki/core";

import type { EngineSource } from "../core/ipc.js";
import { createHostSecretStore, type HostSecretStore, type SecretStorageLike } from "./secrets.js";

/** The environment variable the engine reads to isolate its own state. */
export const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/** Subdirectory of the storage root that holds engine settings and state. */
const USER_DATA_DIR = "userData";

/** Subdirectory of the storage root where the host expects engine logs. */
const LOGS_DIR = "logs";

/** Subdirectory of the storage root for disposable data. */
const CACHE_DIR = "cache";

/** Subdirectory of the storage root for short-lived isolates. */
const TEMP_DIR = "temp";

/**
 * Engine argv before the bundle path. Invoking the engine is engine knowledge,
 * not a shell preference, so every host passes the same prefix; the token file
 * path is appended by the engine's own start path, never the token itself.
 */
const ENGINE_ARGV_PREFIX: readonly string[] = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
];

/** What this shell can do, in the six flags the core branches on. */
export type VSCodeHostCapabilities = {
  /** A webview can show an OS notification through the extension host. */
  readonly canNotify: true;
  /** A panel cannot be popped into its own OS window; that is desktop only. */
  readonly canPopout: false;
  /** A floating/pinned window is a desktop window operation. */
  readonly canFloat: false;
  /** `env.openExternal` exists and only accepts `http:`/`https:`. */
  readonly canOpenExternal: true;
  /** `window.showOpenDialog` exists. */
  readonly canPickFiles: true;
  /**
   * A webview drop cannot expose a readable path to the extension host, so the
   * path half of the dropped-file union is unavailable and the caller must
   * fall back to the content half or to a picker.
   */
  readonly canReadDroppedFiles: false;
};

/**
 * The shell's one capability table.
 *
 * Frozen because a consumer may capture it: the four answers are properties of
 * this shell, not of an instance, and a mutable table would let one caller
 * silently change what another was told.
 */
export const VSCODE_HOST_CAPABILITIES: VSCodeHostCapabilities = Object.freeze({
  canNotify: true,
  canPopout: false,
  canFloat: false,
  canOpenExternal: true,
  canPickFiles: true,
  canReadDroppedFiles: false,
});

/**
 * A resource URI, narrowed to what this module reads.
 *
 * Structural on purpose: `vscode.Uri` has `toString()`, and declaring only that
 * keeps this file free of a runtime dependency on the API module.
 */
export type UriLike = { toString(): string };

/**
 * A webview, narrowed to the one member this port calls.
 *
 * The concrete instance is a `vscode.Webview`. It is a parameter rather than a
 * constructor argument because `asWebviewUri` answers per instance: passing the
 * webview at call time is what makes a cross-panel URI impossible by
 * construction, instead of a rule somebody has to remember.
 */
export type WebviewLike = { asWebviewUri(localResource: UriLike): UriLike };

/** The four directory roots, as the core reads them. */
export type VSCodeHostPaths = {
  readonly userData: string;
  readonly logs: string;
  readonly cache: string;
  readonly temp: string;
};

/**
 * The members the core sees of its host.
 *
 * The one signature that differs from the shell-wide reading is
 * `resolveLocalResource`: it takes the webview (see decision 2 above). Every
 * other member is shell-wide, so one port per extension activation serves every
 * panel.
 */
export interface VSCodeHostPort {
  readonly capabilities: VSCodeHostCapabilities;
  readonly paths: VSCodeHostPaths;
  /** Describe the engine child. Never starts it. */
  getRuntimeSpawnSpec(source: EngineSource): Promise<EngineSpawnSpec>;
  /** The host's own secret store; also the end of the core's `secure` pipe. */
  readonly secure: HostSecretStore;
  /** @returns the URI that webview can load for that local absolute path */
  resolveLocalResource(webview: WebviewLike, path: string): Promise<string>;
  /** @returns an unsubscribe function */
  onShutdown(callback: () => void): () => void;
}

/**
 * The handle the composition root keeps.
 *
 * `triggerShutdown` is the shell's own stand-in for extension deactivation, the
 * same shape the package's VSCode test double already exposes. It is not part of
 * {@link VSCodeHostPort}: the core never triggers a shell shutdown.
 */
export type VSCodeHostPortHandle = VSCodeHostPort & {
  /** Run every registered shutdown callback once; idempotent. */
  triggerShutdown(): void;
};

/** Everything the port needs that only the shell can answer. */
export type VSCodeHostPortOptions = {
  /** `context.secrets`. Never `globalState`, which is plain text on disk. */
  readonly secrets: SecretStorageLike;
  /** `context.globalStorageUri.fsPath`: the parent of the four roots. */
  readonly storageRoot: string;
  /**
   * Create one directory and its parents.
   *
   * Required rather than optional: the four roots are composed here and exist
   * nowhere until something makes them, and VS Code documents `globalStorageUri`
   * as a directory the extension creates. A temp root that is missing fails the
   * engine's token write before the engine is even spawned, which reaches the
   * user as a start failure with nothing visible to act on.
   */
  readonly ensureDirectory: (absPath: string) => void;
  /** `vscode.Uri.file`, injected so this module needs no runtime VS Code import. */
  readonly toFileUri: (absPath: string) => UriLike;
  /** The engine interpreter. Defaults to this process's own executable. */
  readonly execPath?: string;
  /** The environment to copy for the engine child. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Diagnostic sink. Lines never carry a secret. */
  readonly log?: (line: string) => void;
};

/**
 * Build the port.
 *
 * @param options the injected shell answers
 * @returns the port plus the shutdown trigger
 */
export function createVSCodeHostPort(options: VSCodeHostPortOptions): VSCodeHostPortHandle {
  const { toFileUri, log } = options;

  const paths: VSCodeHostPaths = {
    userData: join(options.storageRoot, USER_DATA_DIR),
    logs: join(options.storageRoot, LOGS_DIR),
    // VS Code has no "cache" root, so it is composed under the storage root:
    // that keeps it disposable alongside the rest of this extension's data.
    cache: join(options.storageRoot, CACHE_DIR),
    temp: join(options.storageRoot, TEMP_DIR),
  };

  // The roots are created once, here, rather than at each use: the token write
  // runs in the core child and cannot ask the shell to make a directory, so a
  // root that does not exist yet is a failure the child can only report.
  for (const root of [paths.userData, paths.logs, paths.cache, paths.temp]) {
    try {
      options.ensureDirectory(root);
    } catch (error) {
      // Reported and not thrown: the shell can still open its panel and show
      // what went wrong, which is strictly better than failing to activate.
      log?.(`could not create ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const secure = createHostSecretStore(options.secrets);

  const shutdownCallbacks = new Set<() => void>();

  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;

  return {
    capabilities: VSCODE_HOST_CAPABILITIES,
    paths,
    secure,

    async getRuntimeSpawnSpec(source: EngineSource): Promise<EngineSpawnSpec> {
      return {
        // The extension host is itself a Node process (Electron running as one
        // on desktop), so this is the binary the engine child runs with. No
        // separate interpreter is searched for: a mismatch between the two
        // would be a second, disagreeing answer to the same question.
        exePath: execPath,
        env: engineEnvironment(env, paths.userData),
        argvPrefix: [...ENGINE_ARGV_PREFIX],
        bundlePath: source.bundlePath,
        // The engine writes its default file tree under cwd, and `source.dir` is
        // the package root it was resolved against, so the two agree.
        cwd: source.dir,
        // stdout carries the engine's WebSocket line and its stderr is relayed.
        stdio: "pipe",
        // A console window flashing on Windows is a defect, not a detail.
        windowsHide: true,
        // Not detached: the engine belongs to the core child's process group, so
        // a core crash takes the engine with it instead of leaking it.
        detached: false,
      };
    },

    async resolveLocalResource(webview: WebviewLike, path: string): Promise<string> {
      // The member has no failure code in the minimal port, so an unusable path
      // is a rejection with a sentence rather than a `file:` URI that would load
      // as a broken image. A relative path is the common case: it would resolve
      // against the extension host's cwd here and against the engine's later.
      if (!isAbsolute(path)) {
        throw new Error(`local resource path must be absolute: ${path}`);
      }

      // Per call and per webview: never cached, never hoisted to module scope.
      return webview.asWebviewUri(toFileUri(path)).toString();
    },

    onShutdown(callback: () => void): () => void {
      shutdownCallbacks.add(callback);

      return () => {
        shutdownCallbacks.delete(callback);
      };
    },

    triggerShutdown(): void {
      // Taken before running so a callback that registers another cannot make
      // this loop run forever, and so a second deactivate is a no-op.
      const pending = [...shutdownCallbacks];

      shutdownCallbacks.clear();

      for (const callback of pending) {
        try {
          callback();
        } catch (error) {
          log?.(`a shutdown callback failed: ${describe(error)}`);
        }
      }
    },
  };
}

/**
 * Build the complete environment for the engine child.
 *
 * Complete on purpose: `EngineSpawnSpec.env` is what the spawn receives, with no
 * second merge of `process.env`, so anything missing here is missing in the
 * engine. `NODE_OPTIONS` is dropped because an inherited preload is not this
 * shell's decision and would double up whatever the engine installs itself.
 *
 * @param base the process environment to copy
 * @param userData the engine home
 * @returns the child environment
 */
export function engineEnvironment(
  base: Readonly<Record<string, string | undefined>>,
  userData: string,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  delete env["NODE_OPTIONS"];

  // `process.execPath` is `Code.exe` inside the desktop extension host, which
  // only behaves as Node when the child is told so. A plain Node host has no
  // such binary and must not receive the variable.
  if (typeof process.versions.electron === "string") {
    env["ELECTRON_RUN_AS_NODE"] = "1";
  }

  env[ENGINE_HOME_ENV] = userData;

  return env;
}

/**
 * @param value thrown value
 * @returns its message when it is an `Error`, else its rendering
 */
function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
