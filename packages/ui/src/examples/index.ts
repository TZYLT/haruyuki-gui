/**
 * Entry point for the sample page.
 *
 * This is **test scaffolding**, not part of the package's public API. It exports
 * the one page a human opens to judge whether the components compose, and it
 * exists as a subpath (`@haruyuki/ui/examples`) so the shell's renderer can load
 * that page through a declared entry rather than reaching into `src/` with a
 * relative path. A deep path into another package's `src/` is the thing an
 * `exports` map exists to prevent: it would break the moment a file moved, and
 * nothing would report it.
 *
 * Nothing outside the sample should import from here. A product surface that
 * imported `SamplePage` would inherit a preview page -- and every component, at
 * once -- as its own dependency.
 *
 * The local constant keeps this module from being a pure forwarding barrel, which
 * the ownership gate rejects: a module with no declaration of its own owns nothing
 * and cannot be reasoned about. `main.tsx` next door is the browser entry that
 * mounts what this file exports; it is not exported here because the shell loads
 * the page, not the dev server entry.
 */

import { SamplePage } from "./SamplePage.js";
import type { SamplePageProps } from "./SamplePage.js";

/**
 * Identifies the sample page in diagnostics.
 *
 * A consumer that logs which surface it rendered can tell the sample apart from a
 * product page without loading both.
 */
export const SAMPLE_PAGE_LAYER = "examples" as const;

export { SamplePage };
export type { SamplePageProps };
