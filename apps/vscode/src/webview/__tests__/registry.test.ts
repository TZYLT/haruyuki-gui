/**
 * The registry the webview hands to the frame.
 *
 * `registerSamplePages` throws on a duplicate id, which is a deliberate signal
 * that two bootstraps ran. These tests pin the consequence for this module: the
 * second request for a registry is answered with the first one, so the guard
 * cannot fire from a consumer that asks twice.
 */

import { describe, expect, it } from "vitest";
import { PAGE_IDS, unknownPageDefinitions } from "@haruyuki/ui";

import { createRegistry } from "../registry.js";

describe("createRegistry", () => {
  it("registers the three sample pages", () => {
    const registry = createRegistry();

    expect(registry.list().map((page) => page.id)).toEqual(["nav", "conversation", "tree"]);
  });

  it("is idempotent: asking twice neither throws nor re-registers", () => {
    const first = createRegistry();
    const second = createRegistry();

    expect(second).toBe(first);
    expect(second.list()).toHaveLength(3);
  });

  it("stays inside the frozen page catalogue", () => {
    expect(unknownPageDefinitions(createRegistry())).toEqual([]);
    expect(PAGE_IDS).toContain("conversation");
  });

  it("keeps the nav rail pinned and the tree closable, as the frame relies on", () => {
    const registry = createRegistry();

    expect(registry.get("nav")?.pinned).toBe(true);
    expect(registry.get("nav")?.defaultSide).toBe("left");
    expect(registry.get("tree")?.defaultSide).toBe("right");
    expect(registry.get("tree")?.pinned).toBe(false);
  });
});
