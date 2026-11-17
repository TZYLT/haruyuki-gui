/**
 * The command surface's descriptor table.
 *
 * One row per capability, with **no capability name written here**: the names,
 * their scope and their wire mapping all come from `@haruyuki/protocol`'s
 * generated tables, and the arguments come from the generated
 * `params.generated.ts`. That is what makes "no second name table"
 * checkable rather than aspirational — see `descriptors.test.ts`, which fails if
 * a `family.action` literal reappears in this file.
 *
 * Copy lives in the locales under `page.command.<familyAction>.label` / `.desc`
 * (four segments) and `page.command.<family>.name`; this table only
 * names the keys, so a missing key is a copy defect, not a descriptor defect.
 */

import type { CapabilityMeta, CapabilityName } from "@haruyuki/protocol";
// eslint-disable-next-line no-restricted-imports -- 边界规则放宽：仅白名单常量表，权威判定在 scripts/check-boundaries.mjs 的 CONST_EXPORTS_BY_EDGE
import { CAPABILITY_META } from "@haruyuki/protocol";

import { COMMAND_PARAMS } from "./params.generated.js";
import type { CommandParamSpec } from "./params.generated.js";

/** Scope a capability runs in, taken from the generated metadata. */
export type CapabilityScope = (typeof CAPABILITY_META)[CapabilityName]["scope"];

/** One command the surface offers. */
export interface CapabilityDescriptor {
  readonly name: CapabilityName;
  /** First segment of the name (`agent`, `conversation`, …). */
  readonly family: string;
  /** `page.command.<familyAction>.label` (`FZ-7`: at most four segments). */
  readonly labelKey: string;
  /** `page.command.<familyAction>.desc`. */
  readonly descKey: string;
  /** ASCII search terms: the name's own segments, never the Chinese copy. */
  readonly searchKeys: readonly string[];
  readonly scope: CapabilityScope;
  readonly params: readonly CommandParamSpec[];
}

/** A displayed group of descriptors. */
export interface CapabilityFamily {
  /** Family id, the first segment of every member's name. */
  readonly id: string;
  /** `page.command.<id>.name`. */
  readonly nameKey: string;
  /** Rows in name order. */
  readonly descriptors: readonly CapabilityDescriptor[];
}

/** Public alias kept for the signed interface in `docs/63` §4.2. */
export type CapabilityParamSpec = CommandParamSpec;

/** The generated table is partial by design; widen it for keyed lookup. */
const PARAMS: Partial<Record<CapabilityName, readonly CommandParamSpec[]>> = COMMAND_PARAMS;

/**
 * Split a camelCase segment into words (`secretApply` → `secret`, `apply`), so
 * search matches "apply" as well as "secretApply".
 *
 * @param segment camelCase name segment
 * @returns lower-case words
 */
function splitWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Build one row from a generated metadata entry.
 *
 * @param name capability name, used as the key of both generated tables
 * @returns the descriptor row
 */
function describe(name: CapabilityName): CapabilityDescriptor {
  const [family = "", action = ""] = name.split(".");
  const meta: CapabilityMeta = CAPABILITY_META[name];
  const familyAction = `${family}${action.charAt(0).toUpperCase()}${action.slice(1)}`;

  return {
    name,
    family,
    labelKey: `page.command.${familyAction}.label`,
    descKey: `page.command.${familyAction}.desc`,
    searchKeys: [family, ...splitWords(action)],
    scope: meta.scope,
    params: PARAMS[name] ?? [],
  };
}

/**
 * Capabilities the surface offers: everything except the bidirectional legacy
 * body (`file.ops`, excluded by its own metadata flag rather than a literal).
 */
const OFFERED: readonly CapabilityName[] = (Object.keys(CAPABILITY_META) as CapabilityName[])
  .filter((name) => (CAPABILITY_META[name] as CapabilityMeta).legacy !== true)
  .sort((left, right) => left.localeCompare(right));

/** Every offered capability, keyed by name. */
export const CAPABILITY_DESCRIPTORS: Readonly<Record<string, CapabilityDescriptor>> =
  Object.fromEntries(OFFERED.map((name) => [name, describe(name)]));

/** The same rows in display order. */
export const COMMAND_DESCRIPTOR_LIST: readonly CapabilityDescriptor[] = OFFERED.map(
  (name) => CAPABILITY_DESCRIPTORS[name] as CapabilityDescriptor,
);

/** Rows grouped by family, families in name order. */
export const CAPABILITY_FAMILIES: readonly CapabilityFamily[] = (() => {
  const groups = new Map<string, CapabilityDescriptor[]>();

  for (const descriptor of COMMAND_DESCRIPTOR_LIST) {
    const rows = groups.get(descriptor.family);

    if (rows === undefined) {
      groups.set(descriptor.family, [descriptor]);
    } else {
      rows.push(descriptor);
    }
  }

  return [...groups.entries()].map(([id, descriptors]) => ({
    id,
    nameKey: `page.command.${id}.name`,
    descriptors,
  }));
})();

/**
 * Filter the table by an ASCII query.
 *
 * Matching is prefix-first: a row whose search keys contain a key starting with
 * the query sorts before rows that merely contain it, and the label/description
 * are never searched ( Chinese copy is not a search path).
 *
 * @param query raw input from the command panel
 * @returns matching rows, best first
 */
export function filterDescriptors(query: string): readonly CapabilityDescriptor[] {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return COMMAND_DESCRIPTOR_LIST;
  }

  const scored: Array<{ descriptor: CapabilityDescriptor; rank: number }> = [];

  for (const descriptor of COMMAND_DESCRIPTOR_LIST) {
    let rank = -1;

    for (const key of descriptor.searchKeys) {
      if (key.startsWith(needle)) {
        rank = 0;
        break;
      }

      if (key.includes(needle) && rank < 0) {
        rank = 1;
      }
    }

    if (rank >= 0) {
      scored.push({ descriptor, rank });
    }
  }

  return scored
    .sort(
      (left, right) =>
        left.rank - right.rank || left.descriptor.name.localeCompare(right.descriptor.name),
    )
    .map((entry) => entry.descriptor);
}
