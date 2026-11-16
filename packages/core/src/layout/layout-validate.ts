/**
 * Layout document validation: the one gate a candidate document must pass
 * before core either stores it or hands it to a renderer, against the
 * `LayoutDoc` contract in `@haruyuki/protocol`.
 *
 * Why a whole module rather than a shape check
 *   The document is written by the renderer, so it is untrusted input on the
 *   way back in. A document that merely *looks* like `LayoutDoc` is not enough:
 *   the renderer's layout library can produce a split with one child, the same
 *   panel id twice, a negative `sizes` entry, or a tab whose `pageId` no longer
 *   exists -- and every one of those has to be caught here, before the store
 *   writes it and before the next load has to recover from it. The checks are
 *   grouped in the order a reviewer asks about them: version, size, structure,
 *   limits, uniqueness, then the soft repairs that are *not* errors.
 *
 * Unknown keys are the point, not noise
 *   `LayoutDoc` names the keys C4 understands; a newer renderer may add keys at
 *   any level. Those keys are preserved verbatim by the JSON round-trip clone
 *   clone this function returns, so nothing here
 *   rebuilds an object from known fields. The returned document is a clone:
 *   a caller that mutates it cannot reach the value it passed in.
 *
 * Unknown pages are NOT invalid
 *   `pageId` is opaque to core. A tab whose `pageId` is
 *   missing from `knownPageIds` is a placeholder the caller still has to render
 *   (or hide), so it is reported through `unknownPageIds` -- first-seen
 *   document order, hidden tabs included, deduplicated -- the report is exactly
 *   the set difference -- and never as an error.
 *
 * Missing `version` is not this function's problem
 *   The store reads the version off disk first and treats an absent field as
 *   version 1, so a document that reaches this function
 *   without a version was already rewritten by the store. Everything else that
 *   is not exactly the current version is `LAYOUT_UNSUPPORTED_VERSION`.
 *
 * Soft repairs (success, no error)
 *   `activePanelId` and a panel's `activeTabId` are selections, not structure.
 *   A dangling selection is repaired to the first available target, and when
 *   there is nothing to point at the property is removed. Refusing the whole
 *   document over a stale selection would turn "the last panel was removed"
 *   into "the layout could not be loaded", which is the failure this document
 *   exists to avoid.
 */

import type {
  LayoutDoc,
  LayoutErrorCode,
  LayoutPanel,
  LayoutSplit,
  LayoutTab,
} from "@haruyuki/protocol";
import { LAYOUT_DOC_VERSION, LAYOUT_LIMITS } from "@haruyuki/protocol";

/**
 * The result of validating one candidate document.
 *
 * `ok: false` carries a `LayoutErrorCode` from the shared protocol vocabulary
 * never user-facing prose: the renderer decides how to
 * explain it. `detail` is for logs and tests and names the offending path.
 */
export type LayoutValidation =
  | { ok: true; doc: LayoutDoc; unknownPageIds: string[] }
  | { ok: false; code: LayoutErrorCode; detail?: string };

/**
 * Internal control-flow exception.
 *
 * A recursive validator has three choices for reporting the first failure: a
 * discriminated result threaded through every call, an out-parameter, or a
 * throw caught at the boundary. The throw is the smallest code and the only one
 * that leaves the happy path readable; it never escapes this module.
 */
class LayoutViolation extends Error {
  readonly code: LayoutErrorCode;

  constructor(code: LayoutErrorCode, detail: string) {
    super(detail);
    this.name = "LayoutViolation";
    this.code = code;
  }
}

/** A JSON object, as `JSON.parse` produces them. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Machine-readable failure with a path a human can type into a debugger. */
function invalid(detail: string): never {
  throw new LayoutViolation("LAYOUT_INVALID", detail);
}

/** A documented size/depth/count limit was exceeded. */
function tooLarge(detail: string): never {
  throw new LayoutViolation("LAYOUT_TOO_LARGE", detail);
}

/** The value cannot be JSON at all, or its top level is not an object. */
function corrupt(detail: string): never {
  throw new LayoutViolation("LAYOUT_CORRUPT", detail);
}

/** Everything the walk accumulates across the document. */
interface WalkState {
  readonly knownPageIds: ReadonlySet<string>;
  readonly panelIds: Set<string>;
  readonly tabIds: Set<string>;
  readonly unknownPages: Set<string>;
  readonly unknownPageIds: string[];
  panels: number;
  tabs: number;
  /** The first panel in document order; `activePanelId`'s repair target. */
  firstPanelId: string | null;
  /** Fields a soft repair rewrote, so the caller can log that they changed. */
  readonly repaired: string[];
}

/** Require a non-empty string, naming the field in the failure. */
function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${path} must be a non-empty string`);
  }
  return value;
}

/**
 * Walk one node, validating it and every node below it.
 *
 * `depth` counts nodes from the root, with the root at 1, so
 * `maxDepth: 32` accepts a root reached through 31 nested splits and rejects
 * the next one. The check happens on entry, before any recursion, which is what
 * makes the cap a cap: a pathologically deep document stops at the limit
 * instead of exhausting the stack first.
 */
function validateNode(node: unknown, depth: number, path: string, state: WalkState): void {
  if (depth > LAYOUT_LIMITS.maxDepth) {
    tooLarge(`${path} is nested deeper than ${LAYOUT_LIMITS.maxDepth} levels`);
  }

  if (!isRecord(node)) {
    invalid(`${path} must be an object`);
  }

  if (node["type"] === "split") {
    validateSplit(node, depth, path, state);
    return;
  }

  if (node["type"] === "panel") {
    validatePanel(node, path, state);
    return;
  }

  invalid(`${path}.type must be "split" or "panel"`);
}

/** Validate a split: orientation, child count, sizes, then recurse. */
function validateSplit(
  node: Record<string, unknown>,
  depth: number,
  path: string,
  state: WalkState,
): void {
  const split = node as unknown as LayoutSplit;

  if (split.orientation !== "horizontal" && split.orientation !== "vertical") {
    invalid(`${path}.orientation must be "horizontal" or "vertical"`);
  }

  const children = split.children;

  if (!Array.isArray(children)) {
    invalid(`${path}.children must be an array`);
  }

  // A one-child split has no meaning and is what a buggy drag operation leaves
  // behind.
  if (children.length < 2) {
    invalid(`${path}.children must have at least two entries`);
  }

  const sizes = node["sizes"];

  if (sizes !== undefined) {
    if (!Array.isArray(sizes)) {
      invalid(`${path}.sizes must be an array`);
    }

    if (sizes.length !== children.length) {
      invalid(`${path}.sizes must have one entry per child (${children.length})`);
    }

    for (let index = 0; index < sizes.length; index += 1) {
      const size = sizes[index];

      if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
        invalid(`${path}.sizes[${index}] must be a finite positive number`);
      }
    }
  }

  for (let index = 0; index < children.length; index += 1) {
    validateNode(children[index], depth + 1, `${path}.children[${index}]`, state);
  }
}

/** Validate a panel, its tabs, uniqueness, then soft-repair its `activeTabId`. */
function validatePanel(node: Record<string, unknown>, path: string, state: WalkState): void {
  const panel = node as unknown as LayoutPanel;

  const id = requireNonEmptyString(panel.id, `${path}.id`);

  if (state.panelIds.has(id)) {
    invalid(`duplicate panel id "${id}" at ${path}`);
  }

  state.panelIds.add(id);

  if (state.firstPanelId === null) {
    state.firstPanelId = id;
  }

  state.panels += 1;

  if (state.panels > LAYOUT_LIMITS.maxPanels) {
    tooLarge(`document has more than ${LAYOUT_LIMITS.maxPanels} panels`);
  }

  const tabs = panel.tabs;

  if (!Array.isArray(tabs)) {
    invalid(`${path}.tabs must be an array`);
  }

  for (let index = 0; index < tabs.length; index += 1) {
    validateTab(tabs[index], `${path}.tabs[${index}]`, state);
  }

  const activeTabId = node["activeTabId"];

  if (activeTabId !== undefined) {
    const isDangling = !tabs.some((tab) => tab.tabId === activeTabId);

    if (isDangling) {
      const firstTab = tabs[0];

      if (firstTab === undefined) {
        delete panel.activeTabId;
      } else {
        panel.activeTabId = firstTab.tabId;
      }

      state.repaired.push(`${path}.activeTabId`);
    }
  }
}

/** Validate one tab, count it, and record an unknown `pageId`. */
function validateTab(tab: unknown, path: string, state: WalkState): void {
  if (!isRecord(tab)) {
    invalid(`${path} must be an object`);
  }

  const typed = tab as unknown as LayoutTab;

  const tabId = requireNonEmptyString(typed.tabId, `${path}.tabId`);

  if (state.tabIds.has(tabId)) {
    invalid(`duplicate tab id "${tabId}" at ${path}`);
  }

  state.tabIds.add(tabId);

  state.tabs += 1;

  if (state.tabs > LAYOUT_LIMITS.maxTabs) {
    tooLarge(`document has more than ${LAYOUT_LIMITS.maxTabs} tabs`);
  }

  const pageId = requireNonEmptyString(typed.pageId, `${path}.pageId`);

  // `hidden` is a tri-state in JSON terms: absent, true, false. Anything else
  // would be read back by the renderer as truthy and is not the contract.
  if ("hidden" in tab && typeof tab["hidden"] !== "boolean") {
    invalid(`${path}.hidden must be a boolean`);
  }

  if (!state.knownPageIds.has(pageId) && !state.unknownPages.has(pageId)) {
    state.unknownPages.add(pageId);
    state.unknownPageIds.push(pageId);
  }
}

/**
 * Validate a candidate `LayoutDoc` against the frozen v1 schema.
 *
 * Returns a JSON-cloned document on success, so the caller owns the result and
 * no unknown key has been dropped. On failure returns the first violation only:
 * a document is either storable or it is not, and a list of every error in a
 * document nobody will write is noise.
 *
 * @param value the candidate, usually `JSON.parse` of a save request
 * @param knownPageIds the caller's page registry; an empty set means every page
 *   is unknown, which is still a valid document
 */
export function validateLayoutDoc(
  value: unknown,
  knownPageIds: ReadonlySet<string>,
  log?: (code: string, detail?: Record<string, unknown>) => void,
): LayoutValidation {
  try {
    if (!isRecord(value)) {
      corrupt("layout document must be a JSON object");
    }

    // The store substitutes version 1 for a missing field before calling here
    // anything that survives to this point must say 1.
    if (value["version"] !== LAYOUT_DOC_VERSION) {
      throw new LayoutViolation(
        "LAYOUT_UNSUPPORTED_VERSION",
        `layout document version must be ${LAYOUT_DOC_VERSION}`,
      );
    }

    // Measure the compact JSON, not the in-memory object: the limit is the file
    // the store will write. This also produces the deep
    // clone that preserves unknown keys at every level.
    const text = stringify(value);

    const bytes = Buffer.byteLength(text, "utf8");

    if (bytes > LAYOUT_LIMITS.maxBytes) {
      tooLarge(
        `layout document is ${String(bytes)} bytes; the limit is ${String(LAYOUT_LIMITS.maxBytes)}`,
      );
    }

    const doc = JSON.parse(text) as LayoutDoc;

    const state: WalkState = {
      knownPageIds,
      panelIds: new Set<string>(),
      tabIds: new Set<string>(),
      unknownPages: new Set<string>(),
      unknownPageIds: [],
      panels: 0,
      tabs: 0,
      firstPanelId: null,
      repaired: [],
    };

    validateNode(doc.root, 1, "root", state);

    repairActivePanelId(doc, state);

    // A repair replaces a dangling id with a real one, which can be a few bytes
    // longer; re-measure so the returned document is also within the write
    // limit, not merely the candidate that came in.
    if (Buffer.byteLength(JSON.stringify(doc), "utf8") > LAYOUT_LIMITS.maxBytes) {
      tooLarge(`layout document exceeds ${String(LAYOUT_LIMITS.maxBytes)} bytes after soft repair`);
    }

    // A soft repair changes a selection the user can see, so it leaves a trace:
    // a log entry, not a banner.
    if (state.repaired.length > 0) {
      log?.("LAYOUT_REPAIRED", { count: state.repaired.length, fields: state.repaired });
    }

    return { ok: true, doc, unknownPageIds: state.unknownPageIds };
  } catch (error) {
    if (error instanceof LayoutViolation) {
      return { ok: false, code: error.code, detail: error.message };
    }

    throw error;
  }
}

/** `JSON.stringify`, with the two failure modes a validator can name. */
function stringify(value: unknown): string {
  let text: string | undefined;

  try {
    text = JSON.stringify(value);
  } catch {
    corrupt("layout document is not JSON-serializable");
  }

  if (typeof text !== "string") {
    corrupt("layout document is not JSON-serializable");
  }

  return text;
}

/**
 * Repair `activePanelId` after the walk, when every panel id is known.
 *
 * A document can legitimately lose the panel that was active (the user closed
 * or collapsed it). The selection then points at nothing; it is moved to the
 * first panel in document order, or removed when the document has none. This is
 * deliberately not an error: it is logged as a repair instead.
 */
function repairActivePanelId(doc: LayoutDoc, state: WalkState): void {
  const activePanelId = doc.activePanelId;

  if (activePanelId === undefined) {
    return;
  }

  const isDangling = !state.panelIds.has(activePanelId);

  if (!isDangling) {
    return;
  }

  if (state.firstPanelId === null) {
    delete doc.activePanelId;
  } else {
    doc.activePanelId = state.firstPanelId;
  }

  state.repaired.push("activePanelId");
}
