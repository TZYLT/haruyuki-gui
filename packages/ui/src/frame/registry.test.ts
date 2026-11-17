/**
 * Registry behaviour and validation.
 *
 * These are contract tests, not implementation tests: each case is a rule a page
 * author or the layout host is allowed to rely on. No DOM, because the registry
 * is deliberately React-free -- it must be usable from the layout builder and
 * from tests without mounting anything.
 */

import { describe, expect, it } from "vitest";

import { createPageRegistry } from "./registry.js";
import type { PageDefinition } from "./types.js";

/**
 * A component is required by the contract but irrelevant to every rule tested
 * here, so one no-op stands in for all pages. It takes no props on purpose: a
 * component that ignores its props is the least assumption-laden thing a page
 * can be, and the registry does not inspect it.
 */
function NoopPage() {
  return null;
}

/**
 * Build a valid definition, then let the case under test break one field.
 *
 * Defaults are chosen so that a case only has to override the field it is about;
 * a failure then points at that field rather than at the fixture.
 *
 * @param overrides fields the case wants to change
 * @returns the definition to register
 */
function definition(overrides: Partial<PageDefinition> = {}): PageDefinition {
  return {
    id: "demo",
    titleKey: "page.error.retry",
    icon: "file",
    zone: "main",
    minWidth: 480,
    component: NoopPage,
    ...overrides,
  };
}

describe("createPageRegistry", () => {
  it("registers a valid page and finds it by id", () => {
    const registry = createPageRegistry();
    const page = definition();

    registry.register(page);

    expect(registry.has("demo")).toBe(true);
    // The stored entry is a frozen copy with the defaults resolved, so identity is
    // deliberately not preserved; the registered fields are what a lookup returns.
    expect(registry.get("demo")).toMatchObject({
      id: "demo",
      titleKey: "page.error.retry",
      icon: "file",
      zone: "main",
      minWidth: 480,
    });
    expect(Object.isFrozen(registry.get("demo"))).toBe(true);
  });

  it("returns undefined for an unknown id", () => {
    const registry = createPageRegistry();

    expect(registry.get("nope")).toBeUndefined();
    expect(registry.has("nope")).toBe(false);
  });

  it("rejects a duplicate id", () => {
    const registry = createPageRegistry();
    registry.register(definition());

    expect(() => registry.register(definition())).toThrow(/already registered/);
  });

  it.each([
    ["empty", ""],
    ["leading digit", "1nav"],
    ["uppercase", "Nav"],
    ["underscore", "nav_panel"],
    ["space", "nav panel"],
    ["dot", "nav.panel"],
    ["leading hyphen", "-nav"],
  ])("rejects an id that is %s", (_label, id) => {
    const registry = createPageRegistry();

    expect(() => registry.register(definition({ id }))).toThrow(/must match/);
  });

  it("accepts the id grammar it promises: lowercase, digits and interior hyphens", () => {
    const registry = createPageRegistry();

    registry.register(definition({ id: "side-panel-2" }));

    expect(registry.has("side-panel-2")).toBe(true);
  });

  it("requires defaultSide on a side page", () => {
    const registry = createPageRegistry();

    expect(() =>
      registry.register(definition({ id: "rail", zone: "side", minWidth: 240 })),
    ).toThrow(/must declare defaultSide/);
  });

  it("forbids defaultSide on a main page", () => {
    const registry = createPageRegistry();

    expect(() =>
      registry.register(definition({ id: "center", zone: "main", defaultSide: "left" })),
    ).toThrow(/must not declare defaultSide/);
  });

  it("accepts exactly 240 for a side page and rejects 239", () => {
    const registry = createPageRegistry();

    registry.register(definition({ id: "rail", zone: "side", defaultSide: "left", minWidth: 240 }));
    expect(() =>
      registry.register(
        definition({ id: "narrow", zone: "side", defaultSide: "left", minWidth: 239 }),
      ),
    ).toThrow(/minWidth >= 240/);
  });

  it("accepts exactly 480 for a main page and rejects 479", () => {
    const registry = createPageRegistry();

    registry.register(definition({ id: "center", minWidth: 480 }));
    expect(() => registry.register(definition({ id: "narrow", minWidth: 479 }))).toThrow(
      /minWidth >= 480/,
    );
  });

  it("rejects an empty titleKey or icon", () => {
    const registry = createPageRegistry();

    expect(() => registry.register(definition({ titleKey: "" as never }))).toThrow(
      /non-empty titleKey/,
    );
    expect(() => registry.register(definition({ icon: " " as never }))).toThrow(/non-empty icon/);
  });

  it("defaults pinned to false and allowMultiple to true", () => {
    const registry = createPageRegistry();

    registry.register(definition());
    const stored = registry.get("demo");

    expect(stored?.pinned).toBe(false);
    expect(stored?.allowMultiple).toBe(true);
  });

  it("keeps explicit pinned and allowMultiple values", () => {
    const registry = createPageRegistry();

    registry.register(
      definition({ id: "rail", zone: "side", defaultSide: "left", minWidth: 240, pinned: true }),
    );
    registry.register(definition({ id: "multi", allowMultiple: false }));

    expect(registry.get("rail")?.pinned).toBe(true);
    expect(registry.get("multi")?.allowMultiple).toBe(false);
  });

  it("lists pages in registration order", () => {
    const registry = createPageRegistry();

    registry.register(definition({ id: "third" }));
    registry.register(definition({ id: "first" }));
    registry.register(definition({ id: "second" }));

    expect(registry.list().map((page) => page.id)).toEqual(["third", "first", "second"]);
  });

  it("does not expose its backing collection through list()", () => {
    const registry = createPageRegistry();
    registry.register(definition());

    const first = registry.list() as PageDefinition[];
    first.pop();

    expect(registry.list()).toHaveLength(1);
  });
});
