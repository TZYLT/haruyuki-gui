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

export { AppFrame, COMPACT_WIDTH } from "./AppFrame.js";
export type { AppFrameProps } from "./AppFrame.js";
export { Banner, BANNER_SCENE_TONE } from "./Banner.js";
export type { BannerProps, BannerScene } from "./Banner.js";
export { CompactSideRail, SideRail } from "./SideRail.js";
export type { CompactSideRailProps, SideRailProps, SideRailSide } from "./SideRail.js";
export { TopBar } from "./TopBar.js";
export type { EditAction, TopBarProps } from "./TopBar.js";
export { createActivityStore, badgeText } from "./activity.js";
export type { ActivityState, ActivityStore } from "./activity.js";
export { toDockview, toLayoutDoc, docEquals } from "./layout/map.js";
export { hiddenTabCount, hideTab, preserveResetTabs } from "./layout/hidden.js";
export { layoutBanner } from "./layout/banner.js";
export type { LayoutOutcome } from "./layout/banner.js";
export type { DockviewLayout, HiddenTab, SerializedLayout } from "./layout/map.js";
export { PAGE_IDS, unknownPageDefinitions } from "./contract.js";
export type { PageId } from "./contract.js";
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
