import { describe, expect, it } from "vitest";

import { PAGE_IDS, unknownPageDefinitions } from "./contract.js";
import { createPageRegistry } from "./registry.js";
import { registerSamplePages } from "./pages/index.js";

describe("page catalogue", () => {
  it("is frozen and has no duplicate ids", () => {
    expect(Object.isFrozen(PAGE_IDS)).toBe(true);
    expect(new Set(PAGE_IDS).size).toBe(PAGE_IDS.length);
  });

  it("keeps the sample pages inside the catalogue", () => {
    const registry = createPageRegistry();
    registerSamplePages(registry);

    expect(unknownPageDefinitions(registry)).toEqual([]);
  });

  it("reports an id outside the catalogue", () => {
    const registry = createPageRegistry();
    registerSamplePages(registry);
    registry.register({
      id: "vendor-extra",
      titleKey: "page.nav.title",
      icon: "info",
      zone: "main",
      minWidth: 480,
      component: () => null,
    });

    expect(unknownPageDefinitions(registry)).toEqual(["vendor-extra"]);
  });
});
