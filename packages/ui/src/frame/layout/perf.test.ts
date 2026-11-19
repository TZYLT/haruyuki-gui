import { describe, expect, it } from "vitest";
import type { LayoutDoc } from "@haruyuki/protocol";

import { toDockview, toLayoutDoc } from "./map.js";

/** @returns a document with fifty tabs across five main groups */
function wideDoc(): LayoutDoc {
  const tabs = Array.from({ length: 50 }, (_, index) => ({
    tabId: `tab-${String(index)}`,
    pageId: "conversation",
  }));
  const groups = Array.from({ length: 5 }, (_, group) => ({
    type: "panel" as const,
    id: `group-${String(group)}`,
    tabs: tabs.slice(group * 10, group * 10 + 10),
  }));

  return { version: 1, root: { type: "split", orientation: "horizontal", children: groups } };
}

describe("layout mapping budget", () => {
  it("converts fifty tabs both ways well inside the restore budget", () => {
    const doc = wideDoc();
    const samples: number[] = [];

    for (let index = 0; index < 9; index += 1) {
      const started = performance.now();
      const dock = toDockview(doc, { width: 1440, height: 900 });
      toLayoutDoc(dock.serialized, doc);
      samples.push(performance.now() - started);
    }

    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)] ?? Infinity;

    // The full mount budget covers the dock mount too; this only proves the frame's
    // own conversion is not the part that spends hundreds of milliseconds.
    expect(median).toBeLessThan(100);
  });
});
