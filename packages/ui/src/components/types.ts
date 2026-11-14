/**
 * Props shared by every component in this package.
 *
 * Deliberately tiny. A large shared base (`style`, `id`, `aria-*`, event
 * handlers, ref) would be a second public API that has to stay compatible
 * forever; the components forward `data-*` and `className` because callers
 * genuinely need them for layout, and nothing else.
 */

import type { CSSProperties, ReactNode } from "react";

/** What every component accepts in addition to its own props. */
export interface BaseProps {
  /** Extra class names, appended after the component's own. */
  className?: string;
  /** Inline styles. Allowed because layout is the caller's business. */
  style?: CSSProperties;
  /** Test hook. Passed through unchanged. */
  "data-testid"?: string;
}

/** Anything renderable. Re-exported so components need one import, not two. */
export type { ReactNode };
