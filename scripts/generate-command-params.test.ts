/**
 * The generated command parameter table must not drift from the
 * contract snapshot.
 *
 * The check runs the real generator with `--check`, so a snapshot bump that
 * forgets to regenerate fails here instead of shipping stale arguments.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GENERATOR = path.join(REPO_ROOT, "scripts", "generate-command-params.mjs");

describe("generate-command-params", () => {
  it("reports the committed table as up to date", () => {
    const result = spawnSync(process.execPath, [GENERATOR, "--check"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });

    expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).toContain("up to date");
    expect(result.status).toBe(0);
  });
});
