/**
 * The frozen v1 layout document schema.
 *
 * The schema is deliberately small and transport-neutral: it is what the
 * renderer stores, what core validates, and what the VSCode shell must be able
 * to read without a second schema. Unknown keys at every level are preserved by
 * the validator; this file only names the keys the core validator understands.
 */

/** The only document version v1 reads or writes. */
export const LAYOUT_DOC_VERSION = 1 as const;

/**
 * Hard limits, enforced by the validator in core before anything is written.
 *
 * `maxBytes` is measured on the compact JSON text, not on the in-memory object,
 * so the number matches the file on disk. The other three bound the recursion
 * and the renderer's DOM cost.
 */
export const LAYOUT_LIMITS = {
  maxBytes: 256 * 1024,
  maxPanels: 256,
  maxTabs: 1024,
  maxDepth: 32,
} as const;

/** One layout document. */
export type LayoutDoc = {
  version: typeof LAYOUT_DOC_VERSION;
  root: LayoutNode;
  /** The panel that was active when the document was saved, if any. */
  activePanelId?: string;
  /** Opaque future-proofing bag; preserved verbatim across a round trip. */
  extras?: Record<string, unknown>;
};

/** A split or a panel. */
export type LayoutNode = LayoutSplit | LayoutPanel;

/** A container with two or more children. */
export type LayoutSplit = {
  type: "split";
  orientation: "horizontal" | "vertical";
  /** At least two children; a one-child split is an invalid document. */
  children: LayoutNode[];
  /** Fractions of the parent's main axis; length matches `children` when set. */
  sizes?: number[];
  extras?: Record<string, unknown>;
};

/** A leaf that holds tabs. */
export type LayoutPanel = {
  type: "panel";
  id: string;
  tabs: LayoutTab[];
  /** The tab that was active when the panel was saved, if any. */
  activeTabId?: string;
  extras?: Record<string, unknown>;
};

/** One tab. `pageId` is opaque to the layout layer; the caller's registry decides known/unknown. */
export type LayoutTab = {
  tabId: string;
  pageId: string;
  /** Page-owned props; the layout layer preserves them and never interprets them. */
  props?: Record<string, unknown>;
  /** An unknown panel that the user closed: not rendered, still present. */
  hidden?: boolean;
  extras?: Record<string, unknown>;
};
