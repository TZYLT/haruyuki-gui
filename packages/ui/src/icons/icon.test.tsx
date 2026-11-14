/**
 * Icon layer tests.
 *
 * The interesting assertions are the accessibility split and the closed name set.
 * Pixel appearance is not asserted: jsdom performs no layout, and an icon's
 * visual correctness is a job for the real-browser pass, not for a component
 * test that would only prove the element exists.
 */

// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LocaleProvider } from "../i18n/index.js";
import {
  EXTENSION_ICONS,
  ICON_NAMES,
  ICONS,
  Icon,
  iconForFile,
  iconProvenanceCounts,
} from "./index.js";

describe("icon registry", () => {
  it("exposes every icon as a runtime name", () => {
    expect(ICON_NAMES.length).toBe(Object.keys(ICONS).length);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  it("maps every name to a component and a provenance", () => {
    for (const name of ICON_NAMES) {
      const entry = ICONS[name];

      expect(entry.component, name).toBeDefined();
      expect(["lucide", "feather"], name).toContain(entry.provenance);
    }
  });

  it("counts provenance without gaps", () => {
    // The licence audit reads this: Feather-derived artwork is MIT while the
    // rest is ISC, so the split has to add up rather than be estimated.
    const counts = iconProvenanceCounts();

    expect(counts.feather + counts.lucide).toBe(ICON_NAMES.length);
    expect(counts.feather).toBeGreaterThan(0);
    expect(counts.lucide).toBeGreaterThan(0);
  });

  it("uses semantic names rather than shape names", () => {
    // A shape name survives a library swap but lies about intent. These are the
    // ones a library would tempt you into.
    for (const banned of ["x", "trash", "plus", "minus", "pencil", "gear"]) {
      expect(ICON_NAMES as readonly string[]).not.toContain(banned);
    }
  });
});

describe("file extension mapping", () => {
  it("resolves a bare extension", () => {
    expect(iconForFile("md")).toBe("file");
    expect(iconForFile("PNG")).toBe("file");
  });

  it("resolves a full file name", () => {
    expect(iconForFile("README.md")).toBe("file");
    expect(iconForFile("package.json")).toBe("file");
  });

  it("falls back to the generic icon instead of failing", () => {
    // A caller never has to branch on "no icon for this extension".
    expect(iconForFile("archive.zzz")).toBe("file");
    expect(iconForFile("no-extension")).toBe("file");
    expect(iconForFile("")).toBe("file");
  });

  it("only ever returns names that exist in the registry", () => {
    for (const extension of Object.keys(EXTENSION_ICONS)) {
      expect(ICON_NAMES as readonly string[]).toContain(iconForFile(extension));
    }
  });
});

describe("Icon accessibility", () => {
  it("hides a decorative icon from assistive technology", () => {
    // No label key means the icon repeats information already in text.
    const { container } = render(<Icon name="delete" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.getAttribute("aria-label")).toBeNull();
    expect(svg?.getAttribute("role")).toBeNull();
  });

  it("names a semantic icon from its message key", () => {
    const { container } = render(
      <LocaleProvider locale="en">
        <Icon name="delete" labelKey="a11y.action.delete" />
      </LocaleProvider>,
    );
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("aria-hidden")).toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Delete");
  });

  it("translates the accessible name with the active locale", () => {
    const { container } = render(
      <LocaleProvider locale="zh-CN">
        <Icon name="delete" labelKey="a11y.action.delete" />
      </LocaleProvider>,
    );

    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe("删除");
  });

  it("keeps the icon out of the tab order", () => {
    // A non-interactive svg must not become a tab stop; the interactive thing is
    // the button around it.
    const { container } = render(<Icon name="search" />);

    expect(container.querySelector("svg")?.getAttribute("focusable")).toBe("false");
  });
});

describe("Icon rendering", () => {
  it("renders an svg for a registered name", () => {
    const { container } = render(<Icon name="check" />);

    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("inherits the font size when no size is given", () => {
    // Inheriting is what makes a glyph sit level with its text; a fixed default
    // would overflow at large text sizes.
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe("1em");
    expect(svg?.getAttribute("height")).toBe("1em");
  });

  it("honours an explicit pixel size", () => {
    const { container } = render(<Icon name="check" size={20} />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("width")).toBe("20");
    expect(svg?.getAttribute("height")).toBe("20");
  });

  it("takes its colour from a token, not a literal", () => {
    // A hard-coded colour here would survive every theme and every contrast
    // check, and the icon gate would have nothing to catch.
    const { container } = render(<Icon name="check" />);
    const svg = container.querySelector("svg");

    expect(svg?.getAttribute("style")).toContain("var(--ui-color-neutral-2)");
  });

  it("merges a caller className", () => {
    const { container } = render(<Icon name="check" className="caller-class" />);

    expect(container.querySelector("svg")?.getAttribute("class")).toContain("caller-class");
  });

  it("renders inside a labelled button without a duplicate announcement", () => {
    // The realistic case: an icon inside a button that already has a name. The
    // button is the accessible node; the icon must not add a second one.
    render(
      <LocaleProvider locale="en">
        <button type="button" aria-label="Delete">
          <Icon name="delete" />
        </button>
      </LocaleProvider>,
    );

    expect(screen.getByRole("button", { name: "Delete" })).toBeDefined();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });
});
