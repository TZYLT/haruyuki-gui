/**
 * @haruyuki/core
 *
 * Responsibility: the single shared core (domain logic and protocol-facing
 * services) consumed by both the desktop shell and the VSCode extension shell.
 *
 * Two surfaces are exported here and nowhere else, because a deep import into
 * `./engine/...` or `./port/...` is not part of the contract:
 *
 * - `./engine`: the engine facade, its frozen state/error types and the
 *   classification helpers .
 * - `./port`: the `HostPortStartup` startup subset, frozen as ``HostPortStartup` v1` by
 *   docs/13-B1 section 4 and extended to the nine-item `nine-item contract` by docs/18-A3
 *   section 3.4.1, plus the headless implementation that proves the contract is
 *   implementable without Electron.
 * - `./bridge`: the frame producer (`FZ-1 v1`, docs/21 C5) -- the serializer
 *   guard, the sequencer, the bounded queue, the pager, the batching window,
 *   the handshake and the sender that assembles them. The renderer's consumer
 *   half lives in `@haruyuki/ui/bridge`.
 * - `./supervision`: the runtime-marker, process-evidence and reclaim primitives
 *   shared by the desktop shell and, later, the VSCode shell (docs/33-D4). They
 *   are policy-free: the shell decides when to write a marker or kill a process.
 * - `./layout`: the C4 layout store, validator, draft store and transport-neutral
 *   channel (a layout load, docs/36). The document schema itself is in
 *   `@haruyuki/protocol`; this surface is the core half.
 * - `./merge`: the engine event merger -- ordered delivery, duplicate refusal,
 *   message assembly, terminal slicing and the diagnostics counters the shells
 *   and the reconnect path read.
 *
 * The placeholder constant stays: it is the package's self-identity, and removing
 * it would break the "not a barrel" shape this file has to keep (see
 * scripts/check-module-ownership.mjs).
 */
export const CORE_PACKAGE_NAME = "@haruyuki/core" as const;

export * from "./bridge/index.js";
export * from "./command/index.js";
export * from "./content/index.js";
export * from "./engine";
export * from "./engine/client/index.js";
export * from "./layout/index.js";
export * from "./merge/index.js";
export * from "./port/host-port";
export * from "./port/headless-host-port";
export * from "./supervision/index.js";

// The capability availability verdict (docs/62 §6.3, docs/63 §4.3). Exported by
// name rather than by wildcard: `isVersionAtLeast` and `isOffered` are the
// module's own helpers, and widening them to the package contract would promise
// two things nobody asked for. The consumer is the command gate, which lives in
// a later item; until then this row is the contract, not a rendering.
export { availabilityOf } from "./engine/capability/availability.js";
export type { CapabilityAvailability } from "./engine/capability/availability.js";
