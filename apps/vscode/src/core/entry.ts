/**
 * The core child's process entry: the one place the three seams of `./main.ts`
 * are injected with real implementations.
 *
 * `./main.ts` runs the message loop and deliberately starts no engine, because
 * every outside ability arrives as an argument. That keeps the lifecycle testable
 * in a plain Node process, but it also means the loop runs only once somebody
 * wires it, and nothing in the product did. This file is that wiring, and it is
 * what the build ships as `dist/core.mjs`: the extension host forks that
 * artifact and waits for `ready`, so a bundle that only *exports* the loop would
 * make the host wait out its whole boot budget and then fail.
 *
 * The three seams, and what supplies each one:
 *
 * - `startEngine` builds one `Engine` facade, asks how the engine is to be
 *   started, drives it to ready, and returns the handle `./main.ts` consumes.
 *   The question is asked through the host port proxy's `getRuntimeSpawnSpec`
 *   first. That member is the seam reserved for it, but the pipe in `./ipc.ts`
 *   carries no message for it, so the proxy has no provider and refuses by name;
 *   this file then composes the spec from the `init` the host already sent and
 *   says so where it does it.
 * - `invokeCommand` is the command service built over that same ready engine, so
 *   commands and frames travel on the engine's own endpoint instead of a second
 *   connection that could disagree with it.
 * - `secureStore` is the proxy's `secure`, forwarded unchanged: a secret only
 *   ever travels inside the correlated `secure.request` / `secure.reply` pair.
 *
 * Nothing here imports `vscode`: this file runs in the child, where that module
 * does not exist.
 */

import { Engine } from "@haruyuki/core";
import type { CommandReply, EngineSpawnSpec } from "@haruyuki/core";

import { createCommandService, type CommandService } from "./command-service.js";
import { createFrameOutlet, type ServiceFrameOutlet } from "./frame-path.js";
import {
  createVSCodeHostPortProxy,
  HostPortError,
  type HostPipe,
  type VSCodeHostPortProxy,
} from "./host-port-proxy.js";
import type { CoreInit, CorePaths } from "./ipc.js";
import {
  runCoreMain,
  type CommandInvoker,
  type CoreEngine,
  type EngineStarter,
  type SecureStore,
} from "./main.js";

/**
 * Engine argv before the bundle path.
 *
 * Repeated from the host port rather than imported: the host's copy is private
 * to a module that owns the host half of this wiring and must not be loaded in
 * the child. The port contract tests compare every shell's prefix, so a
 * divergence shows up as a failing gate rather than as two shells that quietly
 * disagree.
 */
const ENGINE_ARGV_PREFIX: readonly string[] = [
  "server",
  "--listen",
  "ws://127.0.0.1:0",
  "--ws-auth",
  "capability-token",
  "--ws-token-file",
];

/** The environment variable the engine reads to isolate its own state. */
const ENGINE_HOME_ENV = "HARUYUKI_HOME";

/** Cap on the idle wait of a hand-run; a host-forked child never reaches it. */
const IDLE_INTERVAL_MS = 1 << 30;

/**
 * The pipe to the extension host, as the host port proxy wants it.
 *
 * `process.send` exists only when the parent forked with an `ipc` stdio slot, so
 * a missing one is a `false` refusal rather than a throw: the proxy turns that
 * into a `DISCONNECTED` error at the call site, which is the honest answer for a
 * pipe that is not there.
 *
 * @returns the transport the proxy subscribes to
 */
function hostPipe(): HostPipe {
  return {
    send(message): boolean {
      if (process.send === undefined) return false;

      try {
        return process.send(message);
      } catch {
        // A closed channel means the host is gone. The proxy's own disconnect
        // listener is what reports that; throwing here would only lose the fact.
        return false;
      }
    },
    onMessage(listener: (raw: unknown) => void): () => void {
      process.on("message", listener);

      return () => {
        process.off("message", listener);
      };
    },
    onDisconnect(listener: () => void): () => void {
      process.on("disconnect", listener);

      return () => {
        process.off("disconnect", listener);
      };
    },
  };
}

/**
 * Build the proxy over the real pipe.
 *
 * The capability table is the host's, carried on `init`. It used to be a
 * hardcoded copy here, because the pipe carried nothing that could bring it --
 * so the two tables could disagree and neither process would notice. A shell
 * that stopped offering notifications while this copy still claimed them would
 * have gone on offering an entry point that did nothing.
 *
 * `resolveSpawnSpec` is deliberately absent: the provider lives in the host
 * process, and the pipe has no message that could carry its answer here. The
 * member therefore refuses by name, which is what {@link startEngineWiring}
 * expects to hear.
 *
 * @param init the host's `init`, which carries the paths and the capabilities
 * @returns the port as this process sees it
 */
function createPort(init: CoreInit): VSCodeHostPortProxy {
  return createVSCodeHostPortProxy({
    pipe: hostPipe(),
    capabilities: init.capabilities,
    paths: init.paths,
  });
}

/**
 * The complete environment for the engine child.
 *
 * A copy of this process's own environment minus `NODE_OPTIONS`, because an
 * inherited preload is not this shell's decision. `ELECTRON_RUN_AS_NODE` is
 * added only when this process really is the Electron binary running as Node:
 * setting it in a plain Node host would name a variable nothing reads.
 *
 * @param paths the roots from `init`
 * @returns the record the spawn receives, with no `undefined` entries
 */
function engineEnvironment(paths: CorePaths): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }

  delete env["NODE_OPTIONS"];

  if (typeof process.versions.electron === "string") {
    env["ELECTRON_RUN_AS_NODE"] = "1";
  }

  env[ENGINE_HOME_ENV] = paths.userData;

  return env;
}

/**
 * Compose the spawn spec from the `init` alone.
 *
 * This is the stand-in for the host port's `getRuntimeSpawnSpec`, and it exists
 * for one reason: the child is handed the engine source (`dir`, `bundlePath`,
 * `kind`) but not the process description, and the pipe has no message for one.
 * Every field here is therefore derived from data the host already sent - the
 * interpreter is this process's own binary, the working directory is the one the
 * host chose for this child and its engine - and the token file path is appended
 * by `Engine.start`, never the token itself.
 *
 * A host that grows a spawn-spec message can delete this function; nothing else
 * in this file reads it.
 *
 * @param init the host's `init`
 * @returns the eight-field spec `Engine.start` validates
 */
function localSpawnSpec(init: CoreInit): EngineSpawnSpec {
  return {
    exePath: process.execPath,
    env: engineEnvironment(init.paths),
    argvPrefix: [...ENGINE_ARGV_PREFIX],
    bundlePath: init.engine.bundlePath,
    cwd: init.cwd,
    stdio: "pipe",
    windowsHide: true,
    detached: false,
  };
}

/**
 * Ask the host for the spec, and compose it here only when nobody can answer.
 *
 * The single refusal that means "ask elsewhere" is the missing provider. A stale
 * engine directory or a refused workspace is a real failure and must reach
 * `./main.ts` as a failed start, because spawning a locally built spec in that
 * case would start the wrong process in a directory nobody chose.
 *
 * @param init the host's `init`
 * @param port the proxy over the host pipe
 * @returns the spec to spawn with
 */
async function resolveSpawnSpec(
  init: CoreInit,
  port: VSCodeHostPortProxy,
): Promise<EngineSpawnSpec> {
  try {
    return await port.getRuntimeSpawnSpec(init.engine);
  } catch (error) {
    const noProvider =
      error instanceof HostPortError &&
      error.code === "UNAVAILABLE" &&
      error.message.includes("spawn-spec provider");

    if (!noProvider) throw error;

    return localSpawnSpec(init);
  }
}

/** Everything one engine lifetime owns, in the order it has to be released. */
type EngineWiring = {
  readonly engine: Engine;
  readonly service: CommandService;
  readonly outlet: ServiceFrameOutlet;
  /** Release the outlet, close the pool and stop the engine. Idempotent. */
  readonly stop: () => Promise<void>;
};

/**
 * Start one engine and wire the command service over it.
 *
 * @param init the host's `init`, which names the engine and its directories
 * @param port the proxy over the host pipe
 * @returns the wiring for this lifetime
 */
async function startEngineWiring(init: CoreInit, port: VSCodeHostPortProxy): Promise<EngineWiring> {
  const spawnSpec = await resolveSpawnSpec(init, port);
  const engine = new Engine();

  await engine.start({
    spawnSpec,
    expectedEngineVersion: init.expectedVersion,
    tokenDir: init.paths.temp,
  });

  const service = createCommandService({ engine });

  // A ready engine has an endpoint, so this builds the pool now rather than on
  // the first command. Before it, `invoke` answers `COMMAND_CHANNEL_UNAVAILABLE`.
  service.attach();

  const outlet = createFrameOutlet(service);

  let stopping: Promise<void> | null = null;

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      outlet.dispose();
      await service.detach();
      // Never rejects by contract, and it is the only path that removes the
      // token file and stops the engine's child.
      await engine.stopGraceful();
    })();

    return stopping;
  };

  return { engine, service, outlet, stop };
}

/**
 * Build the three seams over one process lifetime.
 *
 * The port is created on the first `init`, because `init` is the only message
 * that carries the host's roots. Until then a secret request is answered with a
 * failure instead of waiting for configuration that arrives exactly once.
 *
 * @returns the injected seams
 */
function createWiring(): {
  readonly startEngine: EngineStarter;
  readonly invokeCommand: CommandInvoker;
  readonly secureStore: SecureStore;
} {
  let port: VSCodeHostPortProxy | null = null;
  let current: EngineWiring | null = null;

  /** @returns the proxy, once `init` has named the host's roots */
  function requirePort(): VSCodeHostPortProxy {
    if (port === null) {
      throw new Error("the host port is not configured until the core receives its init");
    }

    return port;
  }

  const startEngine: EngineStarter = async (init: CoreInit): Promise<CoreEngine> => {
    port ??= createPort(init);

    const wiring = await startEngineWiring(init, requirePort());
    current = wiring;

    return {
      stop: async (): Promise<void> => {
        await wiring.stop();
        current = null;
      },
      // The outlet already has the engine handle's signature, so no adapter is
      // needed and no frame can be re-encoded on the way out.
      onFrame: wiring.outlet.onFrame,
      // The facade is this process's child. If it stops after `ready`, nothing
      // else in the shell can see it, so the subscription is wired here rather
      // than left to a reader that may not exist.
      onState: (listener) =>
        wiring.engine.onState((state) => {
          listener(state);
        }),
    };
  };

  const invokeCommand: CommandInvoker = async (call): Promise<CommandReply> => {
    const wiring = current;

    if (wiring === null) {
      return { ok: false, code: "COMMAND_CHANNEL_UNAVAILABLE" };
    }

    return await wiring.service.invoke(call);
  };

  const secureStore: SecureStore = {
    get: (key: string): Promise<string | undefined> => requirePort().secure.get(key),
    set: async (key: string, value: string): Promise<void> => {
      await requirePort().secure.set(key, value);
    },
    delete: async (key: string): Promise<void> => {
      await requirePort().secure.delete(key);
    },
  };

  return { startEngine, invokeCommand, secureStore };
}

/**
 * Report a run that has no host, then stay idle.
 *
 * The extension host always forks this bundle with an IPC channel, so a missing
 * channel means somebody ran the artifact by hand. Exiting immediately with code
 * 0 is exactly the failure this entry exists to remove: a boot that did nothing
 * would be indistinguishable from a working one. The run therefore says what it
 * needs and keeps running, so an operator sees a live process and one line of
 * diagnostics instead of a silent success.
 */
function runWithoutHost(): void {
  process.stderr.write(
    "core entry: no IPC channel; this child is forked by the extension host and cannot serve a bare run\n",
  );

  setInterval(() => undefined, IDLE_INTERVAL_MS);
}

/** The process entry: a forked child runs the loop, a bare run explains itself. */
function main(): void {
  if (process.channel === undefined) {
    runWithoutHost();
    return;
  }

  runCoreMain(createWiring());
}

main();
