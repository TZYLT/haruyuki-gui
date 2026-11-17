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
 * names the keys, and `descriptors.test.ts` asserts both directions (every key
 * exists, and no `page.command.*` key is orphaned).
 */

import type { CapabilityMeta, CapabilityName } from "@haruyuki/protocol";
// eslint-disable-next-line no-restricted-imports -- 边界规则放宽：仅白名单常量表，权威判定在 scripts/check-boundaries.mjs 的 CONST_EXPORTS_BY_EDGE
import { CAPABILITY_META } from "@haruyuki/protocol";

import type { MessageKey } from "../i18n/locales/en.js";
import { COMMAND_PARAMS } from "./params.generated.js";
import type { CommandParamSpec } from "./params.generated.js";

/** Scope a capability runs in, taken from the generated metadata. */
export type CommandScope = (typeof CAPABILITY_META)[CapabilityName]["scope"];

/** One command the surface offers. */
export interface CapabilityDescriptor {
  readonly name: CapabilityName;
  /** First segment of the name (`agent`, `conversation`, …). */
  readonly family: string;
  /** `page.command.<familyAction>.label` — a declared catalogue key. */
  readonly labelKey: MessageKey;
  /** `page.command.<familyAction>.desc`. */
  readonly descKey: MessageKey;
  /** ASCII search terms: the name's own segments, never the Chinese copy. */
  readonly searchKeys: readonly string[];
  readonly scope: CommandScope;
  readonly params: readonly CommandParamSpec[];
}

/** A displayed group of descriptors. */
export interface CapabilityFamily {
  /** Family id, the first segment of every member's name. */
  readonly id: string;
  /** `page.command.<id>.name`. */
  readonly nameKey: MessageKey;
  /** Rows in name order. */
  readonly descriptors: readonly CapabilityDescriptor[];
}

/** The generated table is partial by design; widen it for keyed lookup. */
const PARAMS: Partial<Record<CapabilityName, readonly CommandParamSpec[]>> = COMMAND_PARAMS;

/**
 * Name a catalogue key.
 *
 * The single place where a built key becomes `MessageKey`. It is a cast, and it
 * is guarded twice: `descriptors.test.ts` asserts every key this module produces
 * exists in both catalogues, and `scripts/i18n/check.mjs` keeps the key format
 * frozen. Keeping it in one function means a consumer never casts.
 *
 * @param key full `page.command.*` key
 * @returns the same key, typed as a declared catalogue key
 */
function catalogueKey(key: string): MessageKey {
  return key as MessageKey;
}

/**
 * Whether an entry marks itself the bidirectional legacy body.
 *
 * `legacy` is present only on the generated entries that set it, so the check
 * narrows with `in` instead of asserting the whole union to `CapabilityMeta`.
 *
 * @param name capability name
 * @returns true when the entry marks itself legacy
 */
function isLegacy(name: CapabilityName): boolean {
  const meta = CAPABILITY_META[name];

  return "legacy" in meta && meta.legacy === true;
}

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
    labelKey: catalogueKey(`page.command.${familyAction}.label`),
    descKey: catalogueKey(`page.command.${familyAction}.desc`),
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
  .filter((name) => !isLegacy(name))
  .sort((left, right) => left.localeCompare(right));

/** The rows in display order; the maps below are built from this array. */
export const COMMAND_DESCRIPTOR_LIST: readonly CapabilityDescriptor[] = OFFERED.map(describe);

const BY_NAME = new Map<string, CapabilityDescriptor>(
  COMMAND_DESCRIPTOR_LIST.map((row) => [row.name, row]),
);

/**
 * Look one capability up by name.
 *
 * A `Map` rather than a `Record` index: the index signature would make every hit
 * `| undefined` (making callers write `!`), while accepting a misspelled name.
 * The honest shape is `undefined` for a name the surface does not offer.
 *
 * @param name capability name
 * @returns the row, or undefined when the surface does not offer that capability
 */
export function descriptorFor(name: CapabilityName): CapabilityDescriptor | undefined {
  return BY_NAME.get(name);
}

/** Every offered capability, keyed by name (read-only view of the same rows). */
export const CAPABILITY_DESCRIPTORS: Readonly<Record<string, CapabilityDescriptor>> =
  Object.fromEntries(COMMAND_DESCRIPTOR_LIST.map((row) => [row.name, row]));

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
    nameKey: catalogueKey(`page.command.${id}.name`),
    descriptors,
  }));
})();

/**
 * Filter the table by an ASCII query.
 *
 * Matching is prefix-first: rows whose search key starts with the query sort
 * before rows that merely contain it, and the labels are never searched
 * (Chinese copy is not a search path). The result is a fresh array, so
 * a caller sorting it cannot reorder the module's table.
 *
 * @param query raw input from the command panel
 * @returns matching rows, best first
 */
export function filterDescriptors(query: string): readonly CapabilityDescriptor[] {
  const needle = query.trim().toLowerCase();

  if (needle.length === 0) {
    return [...COMMAND_DESCRIPTOR_LIST];
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
