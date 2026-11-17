/**
 * The command surface's descriptor table (`the log`).
 *
 * One row per capability, with **no capability name written here**: the names,
 * their scope and their wire mapping all come from `@haruyuki/protocol`'s
 * generated tables, and the arguments come from the generated
 * `params.generated.ts`. That is what makes "no second name table"
 * checkable rather than aspirational — see `command-descriptors.test.ts`, which
 * fails if a `family.action` literal reappears in this file.
 *
 * The English label and Chinese description live in the locale files under
 * `page.command.<family>.<action>.label` / `.desc`; this table only names the
 * keys so a missing key is a copy defect, not a descriptor defect.
 */

import type { CapabilityMeta, CapabilityName } from "@haruyuki/protocol";
// eslint-disable-next-line no-restricted-imports -- 边界规则放宽：仅白名单常量表，权威判定在 scripts/check-boundaries.mjs 的 CONST_EXPORTS_BY_EDGE
import { CAPABILITY_META } from "@haruyuki/protocol";

import { COMMAND_PARAMS } from "./params.generated.js";
import type { CommandParamSpec } from "./params.generated.js";

/** The generated table is partial by design; widen it for keyed lookup. */
const PARAMS: Partial<Record<CapabilityName, readonly CommandParamSpec[]>> = COMMAND_PARAMS;

/** Scope a capability runs in, taken from the generated metadata. */
export type CommandScope = (typeof CAPABILITY_META)[CapabilityName]["scope"];

export interface CommandDescriptor {
  readonly name: CapabilityName;
  /** First segment of the name (`agent`, `conversation`, …). */
  readonly family: string;
  /** i18n key of the command's English label. */
  readonly labelKey: string;
  /** i18n key of the Chinese description shown under the label. */
  readonly descKey: string;
  /** ASCII search terms: the name's own segments, never the Chinese copy. */
  readonly searchKeys: readonly string[];
  readonly scope: CommandScope;
  readonly params: readonly CommandParamSpec[];
}

/**
 * Split a camelCase segment into its words (`secretApply` → `secret`, `apply`),
 * so search matches "apply" as well as "secretApply".
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
function describe(name: CapabilityName): CommandDescriptor {
  const [family = "", action = ""] = name.split(".");
  const meta: CapabilityMeta = CAPABILITY_META[name];

  return {
    name,
    family,
    labelKey: `page.command.${family}.${action}.label`,
    descKey: `page.command.${family}.${action}.desc`,
    searchKeys: [family, ...splitWords(action)],
    scope: meta.scope,
    params: PARAMS[name] ?? [],
  };
}

/**
 * Every capability the command surface offers, in name order.
 *
 * `file.ops` is excluded by its own metadata flag (`legacy`), not by a literal
 * name: it is a bidirectional legacy body with no reply frame, so it has no
 * one-shot command form (`D-04`).
 */
export const COMMAND_DESCRIPTORS: readonly CommandDescriptor[] = (
  Object.keys(CAPABILITY_META) as CapabilityName[]
)
  .filter((name) => (CAPABILITY_META[name] as CapabilityMeta).legacy !== true)
  .sort((left, right) => left.localeCompare(right))
  .map(describe);

/** Rows grouped by family, families in name order. */
export function descriptorsByFamily(): ReadonlyMap<string, readonly CommandDescriptor[]> {
  const groups = new Map<string, CommandDescriptor[]>();

  for (const descriptor of COMMAND_DESCRIPTORS) {
    const rows = groups.get(descriptor.family);

    if (rows === undefined) {
      groups.set(descriptor.family, [descriptor]);
    } else {
      rows.push(descriptor);
    }
  }

  return groups;
}

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
export function filterDescriptors(query: string): readonly CommandDescriptor[] {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return COMMAND_DESCRIPTORS;
  }

  const scored: Array<{ descriptor: CommandDescriptor; rank: number }> = [];

  for (const descriptor of COMMAND_DESCRIPTORS) {
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
