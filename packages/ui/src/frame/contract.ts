/**
 * The page catalogue, exported as a runtime value.
 *
 * The registry is the authority at runtime; this list exists for consumers that
 * need the closed set without importing a page (a migration, a contract test, a
 * future shell that only knows page ids). It is frozen, so an accidental push is
 * a loud failure rather than a silent drift.
 */

import type { PageRegistry } from "./types.js";

/** Every page id the frozen catalogue defines. */
export const PAGE_IDS = Object.freeze([
  "nav",
  "conversation",
  "memory",
  "tree",
  "viewer",
  "context",
  "concurrency",
  "terminal",
  "settings",
  "topics",
] as const);

/** One page id. */
export type PageId = (typeof PAGE_IDS)[number];

/**
 * Page ids in a registry that are not part of the frozen catalogue.
 *
 * @param registry the page registry to inspect
 * @returns unknown ids, sorted; empty when the registry stays inside the catalogue
 */
export function unknownPageDefinitions(registry: PageRegistry): string[] {
  const known = new Set<string>(PAGE_IDS);

  return registry
    .list()
    .map((page) => page.id)
    .filter((id) => !known.has(id))
    .sort();
}
