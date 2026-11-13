/**
 * Public surface of the icon layer.
 *
 * The provenance tally is a local declaration and a genuine one: the licence
 * audit needs to know how many of our icons are Feather-derived, and computing it
 * here means the answer cannot drift from the mapping.
 */

import { ICONS, type IconProvenance } from "./registry.js";

/** Identifies the icon layer in diagnostics. */
export const ICON_LAYER = "icons" as const;

/**
 * Count the icons per upstream provenance.
 *
 * @returns counts keyed by provenance
 */
export function iconProvenanceCounts(): Record<IconProvenance, number> {
  const counts: Record<IconProvenance, number> = { feather: 0, lucide: 0 };

  for (const entry of Object.values(ICONS)) {
    counts[entry.provenance] += 1;
  }

  return counts;
}

export { EXTENSION_ICONS, ICON_NAMES, ICONS, iconForFile } from "./registry.js";
export type { IconDefinition, IconName, IconProvenance, KnownExtension } from "./registry.js";

export { Icon } from "./Icon.js";
export type { IconProps } from "./Icon.js";
