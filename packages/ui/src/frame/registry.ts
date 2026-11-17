/**
 * The page registry.
 *
 * A single mutable map behind a read-mostly interface: pages register once, at
 * startup, and the host looks them up per layout tab afterwards. Registration
 * order is the order `list()` returns, which is what the page picker and the
 * default-layout builder read, so it is part of the behaviour rather than an
 * accident of `Map` iteration.
 *
 * Validation lives here rather than at each call site because the rules are
 * about the registry's own invariants: a bad entry makes every layout that
 * mentions it wrong, and the failure has to be loud at startup instead of a
 * blank tab later. The messages name the offending id so a typo is findable
 * without a debugger.
 */

import type { PageDefinition, PageRegistry } from "./types.js";

/**
 * The id grammar.
 *
 * Lowercase letters, digits and interior hyphens, starting with a letter. The id
 * is written into layout documents and read by versions that do not share this
 * registry, so it is treated as a filename-like token: case-folding and
 * punctuation variants would let "Nav" and "nav" become two pages that save
 * documents the other build cannot resolve.
 */
const PAGE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A side page that cannot be laid out narrower than this is unusable. */
const SIDE_MIN_WIDTH = 240;

/** A main page that cannot be laid out at least this wide is unusable. */
const MAIN_MIN_WIDTH = 480;

/**
 * Reject a definition with a message a page author can act on.
 *
 * @param message what is wrong, in one sentence
 * @throws always
 */
function reject(message: string): never {
  throw new Error(`page registry: ${message}`);
}

/**
 * Check one definition before it enters the registry.
 *
 * The checks are ordered cheapest-and-most-fundamental first: an id that cannot
 * be spelled is a different mistake from a side page forgetting its edge, and
 * reporting the first failure keeps the message specific.
 *
 * @param definition the entry about to be stored
 * @param known the ids already registered
 */
function validate(definition: PageDefinition, known: ReadonlyMap<string, PageDefinition>): void {
  if (!PAGE_ID_PATTERN.test(definition.id)) {
    reject(`id "${definition.id}" must match ${String(PAGE_ID_PATTERN)}`);
  }

  if (known.has(definition.id)) {
    reject(`id "${definition.id}" is already registered`);
  }

  if (definition.titleKey.trim() === "") {
    reject(`page "${definition.id}" needs a non-empty titleKey`);
  }

  if (definition.icon.trim() === "") {
    reject(`page "${definition.id}" needs a non-empty icon`);
  }

  if (definition.zone === "side") {
    if (definition.defaultSide === undefined) {
      reject(`side page "${definition.id}" must declare defaultSide`);
    }
  } else if (definition.defaultSide !== undefined) {
    reject(`main page "${definition.id}" must not declare defaultSide`);
  }

  const minimum = definition.zone === "side" ? SIDE_MIN_WIDTH : MAIN_MIN_WIDTH;

  if (!Number.isFinite(definition.minWidth) || definition.minWidth < minimum) {
    reject(
      `page "${definition.id}" needs minWidth >= ${String(minimum)} (got ${String(definition.minWidth)})`,
    );
  }
}

/**
 * Fill in the optional fields so readers never have to repeat the defaults.
 *
 * The component is cast away from its own props parameter on purpose: the map is
 * heterogeneous, so lookups cannot know which `P` a caller registered. This does
 * not weaken the contract -- the props shape is enforced where the page is
 * defined and inside the component -- it only erases a parameter that a lookup by
 * id could never recover.
 *
 * @param definition a validated definition
 * @returns a frozen definition with defaults resolved
 */
function normalise<P extends object>(definition: PageDefinition<P>): PageDefinition {
  const erased = definition as unknown as PageDefinition;

  return Object.freeze({
    ...erased,
    pinned: erased.pinned ?? false,
    allowMultiple: erased.allowMultiple ?? true,
  });
}

/**
 * Create an empty registry.
 *
 * @returns a registry with no pages; registrations are private to the instance
 */
export function createPageRegistry(): PageRegistry {
  const definitions = new Map<string, PageDefinition>();

  return {
    register<P extends object>(definition: PageDefinition<P>): void {
      const erased = definition as unknown as PageDefinition;

      validate(erased, definitions);
      definitions.set(erased.id, normalise(erased));
    },

    get(id: string): PageDefinition | undefined {
      return definitions.get(id);
    },

    /**
     * Every page, in registration order.
     *
     * A copy, not the internal iteration: the returned array is `readonly` to
     * TypeScript but not at runtime, and handing out the backing collection would
     * let a caller reorder the set the host depends on.
     */
    list(): readonly PageDefinition[] {
      return [...definitions.values()];
    },

    has(id: string): boolean {
      return definitions.has(id);
    },
  };
}
