/**
 * Public surface of the frame layer.
 *
 * Host code imports the frame from this one entry so the layer's API is a thing
 * somebody chose rather than whatever happens to be reachable by a deep import.
 * Keeping it a single entry also lets the internals move -- the samples will be
 * deleted once real pages exist, and that should not be an edit at every host.
 *
 * `FRAME_LAYER` is a local declaration on purpose: a module that only forwards
 * other modules hides where its behaviour lives, and the ownership gate rejects
 * that shape.
 */

/** Identifies the frame layer in diagnostics. */
export const FRAME_LAYER = "frame" as const;

export { createPageRegistry } from "./registry.js";
export type {
  FrameCapabilities,
  OpenTarget,
  PageActivity,
  PageDefinition,
  PageInstanceProps,
  PageRegistry,
  PageZone,
  SidePosition,
} from "./types.js";

export {
  conversationPage,
  navPage,
  registerSamplePages,
  SAMPLE_PAGES,
  treePage,
} from "./pages/index.js";
