/**
 * Supervision entry point.
 *
 * Public surface of `packages/core/src/supervision`: marker storage, process
 * evidence, the pure reclaim decision and the bounded kill. Consumers import
 * from here so moving an internal file never changes a call site.
 *
 * Why the constant below: `scripts/check-module-ownership.mjs` rejects a module
 * whose every statement is a forwarding export. The version is this file's own
 * declaration, which keeps it a module with an owner rather than an alias for
 * the files it forwards -- the same pattern the other package entry points use.
 */

/**
 * Shape version of this supervision surface.
 *
 * Bumped only when an exported shape changes in a way a consumer notices; the
 * markers themselves carry `schemaVersion: 1` independently.
 */
export const SUPERVISION_SURFACE_VERSION = 1;

export * from "./types";
export * from "./marker";
export * from "./evidence";
export * from "./reclaim";
