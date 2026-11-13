/**
 * Engine host entry point.
 *
 * Public surface of `packages/core/src/engine`, consumed through this barrel and
 * never by reaching into a sibling file. Kept export-only so the module graph
 * stays acyclic and the facade can grow without changing import sites.
 *
 * The host port is not re-exported here: it is a shell-side contract and lives in
 * `packages/core/src/port`.
 */
export * from "./types";
