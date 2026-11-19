/**
 * The page contract the frame host and the pages share.
 *
 * This module is the seam between "a page" and "the thing that mounts it": the
 * frame knows only these fields, and a page knows only the props in
 * `PageInstanceProps`. Keeping it a type-only module means the renderer can
 * depend on it without pulling any host, dock, or page implementation into the
 * graph, and a page author can read this file alone to learn the whole contract.
 *
 * Two vocabulary types are imported rather than declared: the message key union
 * and the icon name union are owned by the i18n and icon layers. Re-declaring
 * either here would make a second source of truth, and the two copies would
 * drift the moment one side adds a name.
 */

import type { ComponentType } from "react";

import type { MessageKey } from "../i18n/index.js";
import type { IconName } from "../icons/index.js";

/** Which half of the window a page belongs to. */
export type PageZone = "main" | "side";

/** Which edge a side-zone page sits on by default. */
export type SidePosition = "left" | "right";

/**
 * Where an `openPage` request lands.
 *
 * `focused` is the default so a page can open a detail view without having to
 * know the layout: the host decides whether that means the same group, the main
 * zone, or a side rail.
 */
export type OpenTarget = "focused" | "main" | "side-left" | "side-right";

/**
 * The transient state a page can publish to its tab.
 *
 * Three separate numbers/booleans rather than one enum because a tab can be
 * streaming and have unread output at the same time; the host picks which one
 * wins when it draws a single indicator.
 */
export type PageActivity = {
  readonly streaming: boolean;
  readonly approvals: number;
  readonly unread: number;
};

/**
 * The props every page component receives.
 *
 * `P` is the page's own props shape, persisted in the layout document and passed
 * back to it on restore. `params` is `Partial` on purpose: a layout written by an
 * older or newer version may omit a key or carry one this page no longer knows,
 * and a page must render anyway rather than crash on a missing field.
 */
export type PageInstanceProps<P extends object = Record<string, unknown>> = {
  /** Tab id of this instance; distinct from `pageId` because a page may be multi-open. */
  readonly instanceId: string;
  readonly pageId: string;
  /** Props read back from the layout document; tolerate missing and unknown keys. */
  readonly params: Readonly<Partial<P>>;
  /** The instance is on screen and its zone is not collapsed. */
  readonly visible: boolean;
  /** This is the active tab of its group. */
  readonly active: boolean;
  /** False for pinned pages, which have no close affordance. */
  readonly canClose: boolean;
  /** The layout revision the host has applied; pages compare before saving. */
  readonly layoutRevision: number;
  setTitle(title: string): void;
  /** Merge a partial update into the tab's activity indicator. */
  setActivity(update: Partial<PageActivity>): void;
  close(): void;
  /** Returns the new instance's tab id; target defaults to `focused`. */
  openPage(pageId: string, params?: Record<string, unknown>, target?: OpenTarget): string;
};

/**
 * What a page declares at registration time.
 *
 * The fields are readonly because a registry entry is a contract, not mutable
 * configuration: changing one after registration would make the layout the host
 * already built disagree with the definition it was built from.
 */
export type PageDefinition<P extends object = Record<string, unknown>> = {
  /** Stable identity; the layout document persists this, not the title. */
  readonly id: string;
  /** Default tab title; a page may override it at runtime via `setTitle`. */
  readonly titleKey: MessageKey;
  /** A name from the icon layer's closed union, never a library export. */
  readonly icon: IconName;
  readonly zone: PageZone;
  /** Required for side pages, forbidden for main pages. */
  readonly defaultSide?: SidePosition;
  /** Smallest width the page is usable at, in px; side >= 240, main >= 480. */
  readonly minWidth: number;
  /** No close button, and "close others / close all" skip it. Defaults to false. */
  readonly pinned?: boolean;
  /** Whether the same page id may be open more than once. Defaults to true. */
  readonly allowMultiple?: boolean;
  readonly component: ComponentType<PageInstanceProps<P>>;
};

/**
 * The registry consumers register pages into and the host reads pages from.
 *
 * `get`/`list` hand back the erased definition rather than the `P` that
 * `register` received: a lookup by id cannot know which props shape was
 * registered. The props are still enforced where they matter -- at the page's
 * own definition site and inside the component -- and the host passes the
 * persisted `params` through untouched.
 */
export type PageRegistry = {
  register<P extends object>(definition: PageDefinition<P>): void;
  get(id: string): PageDefinition | undefined;
  list(): readonly PageDefinition[];
  has(id: string): boolean;
};

/**
 * What the frame can actually do in this build.
 *
 * `popout` and `floating` are the literal `false`, not `boolean`: they are
 * unavailable in this version, and a literal type turns "we might enable it
 * later" into a compile error at every call site that would have to be revisited
 * rather than a runtime check nobody wrote.
 */
export type FrameCapabilities = {
  /** The dock library is available; false means the fixed two-column fallback. */
  readonly dock: boolean;
  readonly popout: false;
  readonly floating: false;
  /** Whether the window is currently in compact mode. */
  readonly compact: boolean;
  readonly layoutWritable: boolean;
};
