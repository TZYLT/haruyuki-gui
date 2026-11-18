/**
 * The package contract: the capability verdict must be reachable from the
 * the package root, not only from a deep path.
 *
 * That is the whole claim, and it is the one thing a deep-import test cannot
 * prove: the row was in `availability.ts` all along, and the review shipped it
 * while `packages/core/src/index.ts` never mentioned it. So this file imports
 * through the root, and the assertion is on identity -- a re-declared wrapper
 * would pass a "is a function" check while reproducing the same defect.
 */
import { describe, expect, it } from "vitest";

import { availabilityOf } from "./index.js";
import { availabilityOf as deepAvailabilityOf } from "./engine/capability/availability.js";

describe("package root: capability availability", () => {
  it("is the same function the module defines", () => {
    expect(availabilityOf).toBe(deepAvailabilityOf);
  });

  it("answers through the root alone", () => {
    // An ungated capability: reached without a probe and without a flag, which
    // is the case a wiring omission leaves impossible to call at all. The
    // `unknown` arm carries no `booleans` -- so this also pins that an ungated
    // capability never reads the probe.
    expect(availabilityOf("workspace.tree", { state: "unknown" }, "0.6.0")).toEqual({
      state: "available",
    });
  });
});
