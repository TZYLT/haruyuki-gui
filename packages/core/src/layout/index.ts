/**
 * The layout surface, re-exported from `@haruyuki/core`.
 *
 * This is deliberately not a pure forwarding module: `LAYOUT_LAYER` is a real
 * local declaration, which keeps the barrel gate's ownership question answered
 * here rather than hidden behind a nameless `export *` chain.
 */
export const LAYOUT_LAYER = "core/layout" as const;

export * from "./layout-paths.js";
export * from "./layout-fs.js";
export * from "./layout-validate.js";
export * from "./layout-merge.js";
export * from "./layout-store.js";
export * from "./draft-store.js";
export * from "./layout-channel.js";
