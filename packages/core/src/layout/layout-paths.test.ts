/**
 * Tests for the layout path map.
 *
 * These are pure-name tests: no filesystem, no clock. The point is that the four
 * keys are exactly the frozen ones, that the two shells can never alias each
 * other, and that a timestamp cannot turn a backup name into a
 * path that escapes `layout/`.
 */

import { basename, dirname, join, sep } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LAYOUT_DIR_NAME,
  LAYOUT_SHELLS,
  backupPath,
  backupPrefix,
  draftPath,
  formatTimestamp,
  layoutDir,
  layoutPath,
} from "./layout-paths";

const USER_DATA = join("tmp", "engine-home");

describe("layoutDir", () => {
  it("is the layout directory under userData", () => {
    expect(layoutDir(USER_DATA)).toBe(join(USER_DATA, LAYOUT_DIR_NAME));
    expect(basename(layoutDir(USER_DATA))).toBe("layout");
  });
});

describe("shell keys", () => {
  it("maps each shell to the frozen layout and draft names", () => {
    expect(basename(layoutPath(USER_DATA, "desktop"))).toBe("desktop.json");
    expect(basename(layoutPath(USER_DATA, "vscode"))).toBe("vscode.json");
    expect(basename(draftPath(USER_DATA, "desktop"))).toBe("drafts-desktop.json");
    expect(basename(draftPath(USER_DATA, "vscode"))).toBe("drafts-vscode.json");
  });

  it("keeps every key inside the layout directory", () => {
    for (const shell of LAYOUT_SHELLS) {
      expect(dirname(layoutPath(USER_DATA, shell))).toBe(layoutDir(USER_DATA));
      expect(dirname(draftPath(USER_DATA, shell))).toBe(layoutDir(USER_DATA));
      expect(dirname(backupPath(USER_DATA, shell, "2026-01-02T03-04-05-006Z"))).toBe(
        layoutDir(USER_DATA),
      );
    }
  });

  it("gives the two shells independent files", () => {
    expect(layoutPath(USER_DATA, "desktop")).not.toBe(layoutPath(USER_DATA, "vscode"));
    expect(draftPath(USER_DATA, "desktop")).not.toBe(draftPath(USER_DATA, "vscode"));
    expect(layoutPath(USER_DATA, "desktop")).not.toBe(draftPath(USER_DATA, "desktop"));
    // The exported shell list is exactly the closed union, with no duplicates.
    expect(new Set(LAYOUT_SHELLS).size).toBe(2);
    expect([...LAYOUT_SHELLS].sort()).toEqual(["desktop", "vscode"]);
  });

  it("treats a trailing separator in userData as the same root", () => {
    expect(layoutPath(`${USER_DATA}${sep}`, "desktop")).toBe(layoutPath(USER_DATA, "desktop"));
  });
});

describe("backup paths", () => {
  it("names the copy <shell>.corrupt-<timestamp>.json", () => {
    const timestamp = "2026-11-16T21-30-24-123Z";
    expect(basename(backupPath(USER_DATA, "desktop", timestamp))).toBe(
      `desktop.corrupt-${timestamp}.json`,
    );
    expect(basename(backupPath(USER_DATA, "vscode", timestamp))).toBe(
      `vscode.corrupt-${timestamp}.json`,
    );
    expect(backupPrefix("desktop")).toBe("desktop.corrupt-");
    expect(backupPrefix("vscode")).toBe("vscode.corrupt-");
  });

  it("does not let a hostile timestamp escape the layout directory", () => {
    for (const hostile of ["../../evil", "..\\..\\evil", "a/b", "..", ""]) {
      const path = backupPath(USER_DATA, "desktop", hostile);
      expect(dirname(path)).toBe(layoutDir(USER_DATA));
      expect(basename(path)).toMatch(/^desktop\.corrupt-.*\.json$/);
      expect(basename(path)).not.toContain("/");
      expect(basename(path)).not.toContain("\\");
    }
  });
});

describe("formatTimestamp", () => {
  it("is portable and sorts chronologically", () => {
    const early = formatTimestamp(new Date("2026-01-02T03:04:05.006Z"));
    const late = formatTimestamp(new Date("2026-01-02T03:04:05.007Z"));
    expect(early).toBe("2026-01-02T03-04-05-006Z");
    expect(early < late).toBe(true);
    expect(early).not.toMatch(/[:.]/);
  });
});
