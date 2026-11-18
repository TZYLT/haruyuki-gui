/**
 * The working directory: the first workspace folder, or an explicit refusal.
 *
 * The no-workspace case is the one this suite exists for. Every "reasonable"
 * fallback (the home directory, the extension's own storage root, the editor's
 * cwd) would start an engine that writes its tree somewhere the user did not
 * choose and cannot see, so the refusal is a value and the home directory is a
 * capability the caller has to ask for.
 */

import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveWorkspaceCwd, useHomeDir, type WorkspaceFolderLike } from "../workspace.js";

/** One folder, shaped like `vscode.WorkspaceFolder`. */
function folder(fsPath: string): WorkspaceFolderLike {
  return { uri: { fsPath } };
}

describe("resolveWorkspaceCwd", () => {
  it("uses the first workspace folder and roots the file tree at it", () => {
    const first = resolve("/projects/one");
    const resolution = resolveWorkspaceCwd({
      folders: [folder(first), folder("/projects/two")],
      homeDir: "/home/somebody",
    });

    expect(resolution).toEqual({
      ok: true,
      cwd: first,
      fileTreeRoot: first,
      origin: "workspace",
    });
  });

  it("refuses with no workspace folder open and does not choose a directory", () => {
    const resolution = resolveWorkspaceCwd({ folders: [], homeDir: "/home/somebody" });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.reason).toBe("no-workspace");
    // The refusal names the choice and offers the directory it would use, so a
    // caller can ask about it instead of guessing.
    expect(resolution.ok === false && resolution.needsConfirmation).toBe(true);
    expect(resolution.ok === false && resolution.homeDir).toBe(useHomeDir("/home/somebody"));
    expect(resolution.ok === false && resolution.detail).toContain(useHomeDir("/home/somebody"));
    expect(resolution.ok === false && resolution.detail).toContain("confirm");
  });

  it("does not degrade to the home directory before the user confirms it", () => {
    const resolution = resolveWorkspaceCwd({
      folders: [],
      homeDir: "/home/somebody",
      confirmedHomeDir: false,
    });

    expect(resolution.ok).toBe(false);
    expect(resolution).not.toHaveProperty("cwd");
  });

  it("degrades to the home directory only after confirmation, and says so", () => {
    const resolution = resolveWorkspaceCwd({
      folders: [],
      homeDir: "/home/somebody",
      confirmedHomeDir: true,
    });

    expect(resolution).toEqual({
      ok: true,
      cwd: resolve("/home/somebody"),
      fileTreeRoot: resolve("/home/somebody"),
      origin: "home",
    });
  });

  it("prefers an open workspace folder over a confirmed home directory", () => {
    const resolution = resolveWorkspaceCwd({
      folders: [folder("/projects/one")],
      homeDir: "/home/somebody",
      confirmedHomeDir: true,
    });

    expect(resolution.ok && resolution.origin).toBe("workspace");
  });

  it("treats a folder without a directory as no workspace folder", () => {
    const resolution = resolveWorkspaceCwd({
      folders: [folder("   ")],
      homeDir: "/home/somebody",
    });

    expect(resolution.ok).toBe(false);
    expect(resolution.ok === false && resolution.detail).toContain("first workspace folder");
  });

  it("treats an absent folder list as no workspace", () => {
    const resolution = resolveWorkspaceCwd({ folders: undefined, homeDir: "/home/somebody" });

    expect(resolution.ok).toBe(false);
  });
});

describe("useHomeDir", () => {
  it("resolves the override it is given", () => {
    expect(useHomeDir("/home/somebody")).toBe(resolve("/home/somebody"));
  });

  it("falls back to the process home directory and returns an absolute path", () => {
    const home = useHomeDir();

    expect(home).toBe(resolve(home));
    expect(home).toBe(resolve(join(home)));
  });
});
