/**
 * The icon name set.
 *
 * A closed literal union, not `keyof typeof lucide`. Two reasons, both from the
 * requirement:
 *
 * - `IconName` is our vocabulary. Importing the library's full set would make
 *   every one of its ~2300 icons part of our public API, so removing an icon we
 *   never used would be a breaking change, and a typo would be accepted as long
 *   as the library happened to have a similar name.
 * - The mapping is the swap point. Changing icon library means rewriting this
 *   file, and nothing else: no call site names a library export.
 *
 * Each entry maps a semantic name to the library component plus the upstream
 * project that drew it, because Lucide's licence splits the other way: 115 of its
 * icons are derived from Feather and are MIT, the rest ISC. The licence audit
 * needs to know which of ours fall on which side, and that is a fact about the
 * mapping, so it lives next to the mapping.
 */

import {
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  FileText,
  Info,
  Link,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Unlock,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";

/** Upstream provenance of one icon's artwork. */
export type IconProvenance = "lucide" | "feather";

/** One mapping entry. */
export interface IconDefinition {
  /** The library component that draws it. */
  component: LucideIcon;
  /** Which licence the artwork travels under. */
  provenance: IconProvenance;
}

/**
 * The mapping, keyed by our semantic name.
 *
 * Names are the action or object, never the shape: `delete` not `trash`,
 * `close` not `x`. A shape name survives a library swap but lies about intent.
 *
 * `satisfies Record<string, IconDefinition>` rather than a type annotation so
 * the literal keys stay narrow -- that is what makes `IconName` a union of these
 * names and not `string`.
 */
export const ICONS = {
  search: { component: Search, provenance: "feather" },
  delete: { component: Trash2, provenance: "feather" },
  close: { component: X, provenance: "feather" },
  check: { component: Check, provenance: "feather" },
  chevronDown: { component: ChevronDown, provenance: "feather" },
  info: { component: Info, provenance: "feather" },
  warning: { component: AlertTriangle, provenance: "feather" },
  calendar: { component: Calendar, provenance: "feather" },
  add: { component: Plus, provenance: "feather" },
  remove: { component: Minus, provenance: "feather" },
  download: { component: Download, provenance: "feather" },
  upload: { component: Upload, provenance: "feather" },
  clock: { component: Clock, provenance: "feather" },
  lock: { component: Lock, provenance: "feather" },
  link: { component: Link, provenance: "feather" },
  copy: { component: Copy, provenance: "lucide" },
  settings: { component: Settings, provenance: "lucide" },
  refresh: { component: RefreshCw, provenance: "lucide" },
  unlock: { component: Unlock, provenance: "lucide" },
  file: { component: FileText, provenance: "lucide" },
} as const satisfies Record<string, IconDefinition>;

/** Every icon this package can render. */
export type IconName = keyof typeof ICONS;

/** Runtime list of the same set, for tests and for the gate. */
export const ICON_NAMES = Object.keys(ICONS) as readonly IconName[];

/**
 * File-extension to icon name.
 *
 * Constant data rather than logic: an extension is a string, and a string is a
 * key, so a lookup table is the whole implementation. Entries are added when a
 * consumer needs one, not speculatively -- an unreachable row is a row nobody
 * can verify.
 */
export const EXTENSION_ICONS = {
  md: "file",
  markdown: "file",
  txt: "file",
  json: "file",
  ts: "file",
  tsx: "file",
  js: "file",
  jsx: "file",
  css: "file",
  html: "file",
  yml: "file",
  yaml: "file",
  toml: "file",
  png: "file",
  jpg: "file",
  jpeg: "file",
  gif: "file",
  svg: "file",
  webp: "file",
  pdf: "file",
} as const satisfies Record<string, IconName>;

/** The extensions this table recognises. */
export type KnownExtension = keyof typeof EXTENSION_ICONS;

/**
 * Pick an icon for a file name or extension.
 *
 * Accepts either because callers have either: a picker has a name, a listing has
 * an extension. The extension is matched case-insensitively and falls back to the
 * generic file icon rather than returning undefined, so a caller never has to
 * branch on "no icon".
 *
 * @param nameOrExtension file name or bare extension
 * @returns an icon name, always
 */
export function iconForFile(nameOrExtension: string): IconName {
  const trimmed = nameOrExtension.trim().toLowerCase();
  const extension = trimmed.includes(".") ? trimmed.slice(trimmed.lastIndexOf(".") + 1) : trimmed;

  if (Object.hasOwn(EXTENSION_ICONS, extension)) {
    return EXTENSION_ICONS[extension as KnownExtension];
  }

  return "file";
}
