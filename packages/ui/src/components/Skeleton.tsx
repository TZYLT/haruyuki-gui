/**
 * Skeleton.
 *
 * A loading placeholder. It renders **no text at all**, deliberately: text in a
 * skeleton gets read as content by a screen reader and skimmed as content by
 * everyone else, and then changes under the reader when the real content arrives.
 *
 * `aria-hidden` is on every skeleton, and the wait itself is announced once by a
 * live region instead. That is the arrangement that tells a blind user something
 * is happening without pretending to describe shapes they cannot see.
 *
 * The size props exist because a skeleton whose shape does not match the content
 * it replaces causes a layout jump, which is worse than no skeleton at all.
 */

import type { CSSProperties, ReactElement } from "react";

import { useT } from "../i18n/index.js";
import { ensureStyles } from "./styles.js";
import type { BaseProps } from "./types.js";

/** Props of {@link Skeleton}. */
export interface SkeletonProps extends BaseProps {
  /** Width. A number is pixels; a string is passed through as a CSS length. */
  width?: number | string;
  /** Height. Same convention as width. */
  height?: number | string;
  /** Corner rounding step. */
  radius?: "sm" | "md" | "full";
  /** Render this many stacked bars. Defaults to 1. */
  count?: number;
}

/** Radius step to token. */
const RADIUS_TOKENS = {
  sm: "var(--ui-radius-1)",
  md: "var(--ui-radius-2)",
  full: "var(--ui-radius-3)",
} as const;

/**
 * @param value pixel count or CSS length
 * @returns a CSS length string
 */
function length(value: number | string): string {
  return typeof value === "number" ? `${value}px` : value;
}

/**
 * A loading placeholder.
 *
 * @param props skeleton props
 * @returns one or more skeleton bars
 */
export function Skeleton({
  width = "100%",
  height = 16,
  radius = "sm",
  count = 1,
  className,
  style,
  "data-testid": testId,
}: SkeletonProps): ReactElement {
  ensureStyles();

  const t = useT();
  const barStyle: CSSProperties = {
    width: length(width),
    height: length(height),
    borderRadius: RADIUS_TOKENS[radius],
    ...style,
  };
  const classes = className === undefined ? "ui-skeleton" : `ui-skeleton ${className}`;
  const bars = Math.max(1, Math.floor(count));

  return (
    <div className="ui-skeleton__stack" data-testid={testId}>
      {/* The wait is announced once, here, rather than by each bar. A live region
          that repeats per bar would say "loading" three times for one wait. */}
      <span role="status" aria-live="polite" className="ui-skeleton__announcement">
        {t("common.state.loading")}
      </span>
      {Array.from({ length: bars }, (_, index) => (
        <div
          key={index}
          className={classes}
          style={barStyle}
          // Decorative: the announcement above already says what is happening.
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
