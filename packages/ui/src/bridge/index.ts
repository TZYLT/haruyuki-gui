/**
 * Public surface of the bridge layer.
 *
 * The local declaration below is the layer's own identity string. It is a real
 * value this layer owns, and it keeps the module from being a pure forwarding
 * barrel that `scripts/check-module-ownership.mjs` rejects: a module whose every
 * statement re-exports another one hides who owns the dependency edge. The
 * sibling layers (`components`, `i18n`, `icons`, `tokens`) carry the same kind of
 * constant for the same reason.
 *
 * Everything behavioural lives in `entry.ts`; this file is the single import
 * path a host sees.
 */

/** Identifies the bridge layer in diagnostics. */
export const BRIDGE_LAYER = "bridge" as const;

export * from "./entry.js";
export * from "./hooks.js";
export * from "./store.js";
export * from "./terminal.js";
