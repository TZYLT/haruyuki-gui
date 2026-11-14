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
 *   docs/13-B1 section 4, plus the headless implementation that proves the
 *   contract is implementable without Electron.
 * - `./bridge`: the frame producer (`FZ-1 v1`, docs/21 C5) -- the serializer
 *   guard, the sequencer, the bounded queue, the pager, the batching window,
 *   the handshake and the sender that assembles them. The renderer's consumer
 *   half lives in `@haruyuki/ui/bridge`.
 *
 * The placeholder constant stays: it is the package's self-identity, and removing
 * it would break the "not a barrel" shape this file has to keep (see
 * scripts/check-module-ownership.mjs).
 */
export const CORE_PACKAGE_NAME = "@haruyuki/core" as const;

export * from "./bridge/index.js";
export * from "./engine";
export * from "./port/host-port";
export * from "./port/headless-host-port";
