/**
 * Tests for the engine token file.
 *
 * Every case builds its own `mkdtemp` directory and the shared `afterEach` only
 * unlinks the two known file names before removing the directory (no recursive
 * section 5.1 rule 3: no recursive removal).
 *
 * The ACL cases are split by platform on purpose: POSIX asserts the exact mode,
 * Windows asserts the real `icacls` output, so a degrading environment fails the
 * "exact" expectation instead of silently passing. The degraded branch is
 * exercised through the documented `applyAcl` test seam, never by replacing the
 * platform command in production code.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  generateToken,
  isTokenFilePresent,
  removeTokenFile,
  TOKEN_FILE_NAME,
  writeTokenFile,
} from "./token";

/** Kept outside the assertions so `applyAcl` failures are deterministic. */
const runCommand = promisify(execFile);

const tempDirs: string[] = [];

/** Create a tracked temp directory that `afterEach` removes point by point. */
async function createTempDir(prefix = "haruyuki-token-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Known final path for a temp directory, without calling the unit under test. */
function tokenPath(dir: string): string {
  return join(dir, TOKEN_FILE_NAME);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0).reverse()) {
    for (const name of [TOKEN_FILE_NAME, `${TOKEN_FILE_NAME}.tmp`]) {
      await unlink(join(dir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }

    await rmdir(dir);
  }
});

describe("generateToken", () => {
  it("returns 64 lowercase hex characters", () => {
    const token = generateToken();

    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different token on every call", () => {
    const tokens = Array.from({ length: 8 }, () => generateToken());

    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("writeTokenFile", () => {
  it("writes the token plus a trailing newline and reports an exact ACL", async () => {
    const dir = await createTempDir();
    const token = generateToken();

    const result = await writeTokenFile(dir, token);

    expect(result.path).toBe(tokenPath(dir));
    expect(result.acl).toBe("exact");
    expect(result.reason).toBeUndefined();

    const content = await readFile(result.path, "utf8");
    expect(content).toBe(`${token}\n`);
    // The engine trims before comparing, so the trimmed value must be the token.
    expect(content.trim()).toBe(token);
  });

  it("leaves no temporary file behind", async () => {
    const dir = await createTempDir();

    await writeTokenFile(dir, generateToken());

    expect(await readdir(dir)).toEqual([TOKEN_FILE_NAME]);
    await expect(isTokenFilePresent(join(dir, `${TOKEN_FILE_NAME}.tmp`))).resolves.toBe(false);
  });

  it("replaces an existing token file without a random suffix", async () => {
    const dir = await createTempDir();
    const firstToken = generateToken();
    const secondToken = generateToken();

    const first = await writeTokenFile(dir, firstToken);
    const second = await writeTokenFile(dir, secondToken);

    expect(second.path).toBe(first.path);
    expect((await readFile(second.path, "utf8")).trim()).toBe(secondToken);
    expect(await readdir(dir)).toEqual([TOKEN_FILE_NAME]);
  });

  it("throws when the target directory does not exist", async () => {
    const dir = await createTempDir();
    const missingDir = join(dir, "missing");

    await expect(writeTokenFile(missingDir, generateToken())).rejects.toThrow();
    await expect(isTokenFilePresent(join(missingDir, TOKEN_FILE_NAME))).resolves.toBe(false);
  });
});

describe("removeTokenFile", () => {
  it("removes the file and tolerates a second removal", async () => {
    const dir = await createTempDir();
    const { path: filePath } = await writeTokenFile(dir, generateToken());

    await expect(isTokenFilePresent(filePath)).resolves.toBe(true);

    await removeTokenFile(filePath);

    await expect(isTokenFilePresent(filePath)).resolves.toBe(false);
    await expect(removeTokenFile(filePath)).resolves.toBeUndefined();
  });

  it("does not delete a directory it is pointed at", async () => {
    const dir = await createTempDir();

    await expect(removeTokenFile(dir)).rejects.toThrow();
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("reports absence for a path that never existed", async () => {
    const dir = await createTempDir();

    await expect(isTokenFilePresent(tokenPath(dir))).resolves.toBe(false);
  });
});

describe("platform ACL", () => {
  it.skipIf(process.platform === "win32")("sets mode 0o600 on POSIX", async () => {
    const dir = await createTempDir();

    const result = await writeTokenFile(dir, generateToken());

    expect(result.acl).toBe("exact");
    const info = await stat(result.path);
    expect(info.mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform !== "win32")(
    "grants read access to the current user only on Windows",
    async () => {
      const dir = await createTempDir();

      const result = await writeTokenFile(dir, generateToken());
      expect(result.acl).toBe("exact");

      const { stdout } = await runCommand("icacls", [result.path], { windowsHide: true });
      const acl = stdout.toLowerCase();

      // icacls normalizes a bare account name to "MACHINE\\user", so a substring
      // match on the current user is the stable assertion.
      expect(acl).toContain(userInfo().username.toLowerCase());
      // /inheritance:r must remove the directory's inherited groups.
      expect(acl).not.toContain("everyone");
      expect(acl).not.toContain("builtin\\users");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "keeps the ACL exact for a directory with spaces and non-ASCII characters",
    async () => {
      // Escapes keep this source file ASCII while the real path exercises R-5.
      const dir = await createTempDir("haruyuki-token-\u6d4b\u8bd5 ");
      const token = generateToken();

      const result = await writeTokenFile(dir, token);

      expect(result.acl).toBe("exact");
      expect((await readFile(result.path, "utf8")).trim()).toBe(token);

      const { stdout } = await runCommand("icacls", [result.path], { windowsHide: true });
      const acl = stdout.toLowerCase();

      // Group names stay readable ASCII even when the console encoding mangles
      // the localized path portion of the output.
      expect(acl).toContain("(r)");
      expect(acl).not.toContain("everyone");
      expect(acl).not.toContain("builtin\\users");
      expect(stdout.toLowerCase()).toContain(userInfo().username.toLowerCase());
    },
  );
});

describe("degraded ACL", () => {
  it("reports degraded with the raw diagnostic when the ACL step fails", async () => {
    const dir = await createTempDir();
    const token = generateToken();

    const result = await writeTokenFile(dir, token, {
      applyAcl: async () => {
        const failure = new Error("account lookup failed") as Error & {
          code: number;
          stderr: string;
        };
        failure.code = 1332;
        failure.stderr = "no-such-user-zzz: no mapping between account names and SIDs.";
        throw failure;
      },
    });

    expect(result.acl).toBe("degraded");
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("no-such-user-zzz");
    expect(result.reason).toContain("exit 1332");
    // A degraded ACL must not damage the secret itself.
    expect((await readFile(result.path, "utf8")).trim()).toBe(token);
  });

  it("compacts a multi-line diagnostic into one bounded line", async () => {
    const dir = await createTempDir();
    const longStderr = `first line ${"x".repeat(400)}\nsecond line`;

    const result = await writeTokenFile(dir, generateToken(), {
      applyAcl: async () => {
        const failure = new Error("acl failed") as Error & { stderr: string };
        failure.stderr = longStderr;
        throw failure;
      },
    });

    expect(result.acl).toBe("degraded");
    expect(result.reason).toBeDefined();
    expect(result.reason).not.toContain("\n");
    expect(result.reason?.length ?? 0).toBeLessThanOrEqual(303);
  });
});
