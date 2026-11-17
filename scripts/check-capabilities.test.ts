import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("capability literal gate", () => {
  it("passes on the repository's allowlisted sample page", () => {
    const result = spawnSync(process.execPath, [path.join("scripts", "check-capabilities.mjs")], {
      encoding: "utf8",
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
