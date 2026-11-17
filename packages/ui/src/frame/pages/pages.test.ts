/**
 * The sample pages, checked against the registry rather than against snapshots.
 *
 * These are the definitions the host mounts first, so the thing worth asserting
 * is that the registry accepts them at all: a sample with a bad id, a side page
 * without an edge, or too small a `minWidth` would fail at bootstrap, and the
 * failure belongs in a test rather than in an empty window.
 *
 * No DOM: mounting the components would test the placeholder copy, not the
 * contract. The registry is the part that can be wrong in a way the compiler does
 * not see.
 */

import { describe, expect, it } from "vitest";

import { createPageRegistry } from "../registry.js";
import { registerSamplePages, SAMPLE_PAGES } from "./index.js";

describe("sample pages", () => {
  it("registers every sample into a fresh registry", () => {
    const registry = createPageRegistry();

    registerSamplePages(registry);

    expect(registry.list().map((page) => page.id)).toEqual(SAMPLE_PAGES.map((page) => page.id));
    expect(registry.list()).toHaveLength(3);
  });

  it("keeps the navigation rail pinned on the left so it cannot be closed away", () => {
    const registry = createPageRegistry();
    registerSamplePages(registry);

    const nav = registry.get("nav");

    expect(nav?.zone).toBe("side");
    expect(nav?.defaultSide).toBe("left");
    expect(nav?.pinned).toBe(true);
    expect(nav?.minWidth).toBeGreaterThanOrEqual(240);
  });

  it("puts the conversation in the main zone and allows more than one", () => {
    const registry = createPageRegistry();
    registerSamplePages(registry);

    expect(registry.get("conversation")?.zone).toBe("main");
    expect(registry.get("conversation")?.allowMultiple).toBe(true);
  });

  it("puts the tree on the right and leaves it closable", () => {
    const registry = createPageRegistry();
    registerSamplePages(registry);

    const tree = registry.get("tree");

    expect(tree?.defaultSide).toBe("right");
    expect(tree?.pinned).toBe(false);
  });
});
