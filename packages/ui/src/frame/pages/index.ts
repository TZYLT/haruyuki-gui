/**
 * The sample pages and the one call that registers them.
 *
 * The samples prove the contract end to end: three definitions with the three
 * shapes the host has to support (a pinned left rail, a main page, a closable
 * right rail) and nothing else. `registerSamplePages` exists so a host bootstrap
 * or a test does not have to know which three files to import, and so the set the
 * default layout names and the set this module registers can never drift apart.
 */

import type { PageRegistry } from "../types.js";

import { conversationPage } from "./conversation.js";
import { navPage } from "./nav.js";
import { treePage } from "./tree.js";

/**
 * The samples, in the order the default layout shows them.
 *
 * Left rail, main, right rail -- the order is the reading order, so a page picker
 * that lists this array without grouping still reads sensibly.
 */
export const SAMPLE_PAGES = [navPage, conversationPage, treePage] as const;

/**
 * Register every sample page.
 *
 * Throws if a sample is already registered: that means two bootstraps ran, and
 * silently ignoring it would hide a double mount behind a correct-looking layout.
 *
 * @param registry the registry the host will read
 */
export function registerSamplePages(registry: PageRegistry): void {
  for (const page of SAMPLE_PAGES) {
    registry.register(page);
  }
}

export { conversationPage } from "./conversation.js";
export { navPage } from "./nav.js";
export { treePage } from "./tree.js";
