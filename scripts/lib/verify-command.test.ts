import { describe, expect, it } from "vitest";

import { needsShell, runCommand } from "./verify-command.mjs";

const settings = {
  cwd: process.cwd(),
  timeoutMs: 20_000,
  maxBuffer: 8 * 1024 * 1024,
  normalize: (output: string) => output,
};

describe("segment launch", () => {
  it("runs a real image directly and captures its output", () => {
    const result = runCommand(
      { command: process.execPath, args: ["-e", "process.stdout.write('launched')"] },
      settings,
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("launched");
    expect(result.spawnFailed).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it("reports a missing executable as a launch failure, not as a red test", () => {
    // Nothing about this command is a test that failed: it never started. The
    // caller has to be able to say so, because the repair is a different one.
    // An absolute image path, so this goes the direct way: a bare name could be
    // a batch shim, and the shell would then answer "not found" in its own
    // words with an exit code, which reads like a failing test.
    const missing =
      process.platform === "win32"
        ? "C:\\definitely-not-here\\missing.exe"
        : "/definitely-not-here/missing";
    const result = runCommand({ command: missing, args: [] }, settings);

    expect(result.spawnFailed).toBe(true);
    expect(result.status).toBeNull();
  });

  it("refuses a direct command line that is over the budget, and says what to do", () => {
    const result = runCommand(
      { command: process.execPath, args: ["-e", "", "x".repeat(40_000)] },
      settings,
    );

    expect(result.spawnFailed).toBe(true);
    expect(result.status).toBeNull();
    expect(result.output).toContain("split the segment");
  });

  it("sends a batch shim through a shell on Windows and a real image around it", () => {
    if (process.platform === "win32") {
      expect(needsShell({ command: "pnpm", args: [] })).toBe(true);
      expect(needsShell({ command: "C:/Program Files/nodejs/node.exe", args: [] })).toBe(false);
    } else {
      // POSIX keeps the shell: the length limit there is megabytes away.
      expect(needsShell({ command: "pnpm", args: [] })).toBe(true);
    }
  });
});
