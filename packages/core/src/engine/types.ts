/**
 * Engine host: the frozen type surface for hosting the Haruyuki engine process.
 *
 * These types are the contract between the engine facade (`engine.ts`), the
 * spawn/token/port/connection layers beside it and the `HostPort` interface
 * (`../port/host-port.ts`). They are deliberately free of behaviour: no class,
 * behaviour: no class, no default, no validation, so a later package can change
 * the implementation without reopening the contract.
 *
 * The two runtime tuples below are the single source of truth for the matching
 * unions. Deriving the union from a tuple costs nothing at runtime for the
 * consumer that only imports the type (`verbatimModuleSyntax` keeps it erased),
 * and it means the state list and the error-code list can be asserted in tests
 * and walked in logs without a second, drifting copy.
 */

/**
 * Lifecycle of one hosted engine process.
 *
 * `failed` is terminal. `reconnecting` is out of scope here: it belongs to the
 * B3 reconnection work, so it must not appear before then.
 */
export const ENGINE_STATES = [
  "idle",
  "spawning",
  "handshaking",
  "ready",
  "closing",
  "closed",
  "failed",
] as const;

export type EngineState = (typeof ENGINE_STATES)[number];

/**
 * Error taxonomy of the start path. The classification rules that map a fault
 * to one of these live in the facade (`engine.ts`), not here.
 *
 * - SPAWN_FAILED: the process could not be started, or the host port refused to
 *   produce a spawn spec.
 * - PORT_NOT_FOUND: no `WebSocket:` line inside the port timeout, or the port
 *   answered ECONNREFUSED.
 * - AUTH_FAILED: the socket upgrade was rejected with 401/403.
 * - PROTOCOL_MISMATCH: the connection opened but the handshake answer never
 *   matched within the handshake timeout, or reported an unexpected version.
 * - TIMEOUT: the fallback code for any other bounded wait.
 */
export const ENGINE_ERROR_CODES = [
  "SPAWN_FAILED",
  "PORT_NOT_FOUND",
  "AUTH_FAILED",
  "PROTOCOL_MISMATCH",
  "TIMEOUT",
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/**
 * One failure, already classified.
 *
 * `detail` is for humans and logs, never for branching. `wireHint` carries the
 * untrusted, engine-supplied fragment that triggered the classification (for
 * example the raw first stdout line) when there is one, so a field report can be
 * matched against engine output without re-running the failing scenario.
 */
export type EngineError = {
  code: EngineErrorCode;
  detail: string;
  wireHint?: string;
};

/**
 * What the engine reports about itself in the app_server_info handshake.
 *
 * `protocolVersion` is the wire protocol revision (0.6.0 answers 1).
 * `engineVersion` is the engine build string (`letta_code_version` on the wire)
 * and is what an expected-version check compares against.
 * `backend` mirrors the server mode: `local` for an embedded runtime, `api` when
 * the engine proxies a hosted backend.
 * `raw` is the untouched response frame. It is `unknown` on purpose: the facade
 * logs it and nothing else may depend on undocumented fields, so an engine-side
 * schema change cannot leak into our types.
 */
export type AppServerInfo = {
  protocolVersion: number;
  engineVersion: string;
  backend: "local" | "api";
  raw: unknown;
};

/**
 * Everything the host knows about how to start the engine, resolved by the host
 * port before the facade spawns anything.
 *
 * The child argv is `<exePath> <bundlePath> <argvPrefix...>`: `exePath` is the
 * interpreter (`node` in the headless today, a bundled binary later),
 * `bundlePath` is the engine entry point, and `argvPrefix` holds the engine's
 * own arguments (`server --listen ...`). `env` is the complete environment the
 * child receives - callers must not merge it with `process.env` afterwards.
 * `cwd` is where the engine writes its `.haruyuki` state, so it must point at an
 * isolated directory. `stdio` is pinned to `"pipe"` because the port discovery
 * reads stdout and the watchdog needs a live stdin. `detached` and
 * `windowsHide` are process-group and console-window decisions; keeping them in
 * the spec keeps `child_process.spawn` calls free of platform branching.
 */
export type EngineSpawnSpec = {
  exePath: string;
  env: Record<string, string>;
  argvPrefix: string[];
  bundlePath: string;
  cwd: string;
  stdio: "pipe";
  windowsHide: boolean;
  detached: boolean;
};

/**
 * The engine facade's observable output, as three discriminated variants.
 *
 * Why this split: the facade exposes exactly three subscription points
 * (`onState`, `onError`, `onFrame`), and each one has a single, different payload
 * with a different lifetime rule. A tagged union keeps them in one stream for
 * logging and tests while still letting a consumer narrow to just the part it
 * needs, and it makes an exhaustiveness check possible when a future variant is
 * added.
 *
 * - `state` fires on every accepted transition (see the state diagram in
 *   no recursive section 3.3(e)).
 * - `error` fires once per classified failure; the accompanying state change to
 *   `failed` is a separate `state` event, so a consumer can log the cause and the
 *   consequence independently.
 * - `frame` is a heartbeat-ish timestamp only. The frame body is protocol data
 *   owned by `@haruyuki/protocol`; carrying it here would couple the engine
 *   transport to the message schema, which is exactly what the layering forbids.
 *   Consumers that need the payload subscribe to the protocol layer instead.
 */
export type EngineEvent =
  | { readonly type: "state"; readonly state: EngineState }
  | { readonly type: "error"; readonly error: EngineError }
  | { readonly type: "frame"; readonly at: number };
