/**
 * `release.mjs` is the one command the whole item is judged by, and its two
 * interesting behaviours are easy to get wrong in a way that still "works":
 * a flag pair that silently does both instead of refusing, and a dereference
 * that skips links instead of resolving them. Both are pinned here.
 *
 * The version guard is pinned for the same reason: it can only be wrong in a
 * way nobody notices - a second package under a published number looks exactly
 * like the first one, and no checksum tells them apart afterwards.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dereferenceTree,
  ERROR_PREFIX,
  localTagExists,
  parseArgs,
  previousBuildNote,
  readAppVersion,
  roundOne,
  runPipeline,
  scanArtifacts,
  scanTrees,
  UsageError,
  versionConflict,
} from "./release.mjs";

let work: string | null = null;

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "g2-release-"));
});

afterEach(async () => {
  if (work !== null) await rm(work, { recursive: true, force: true });
  work = null;
});

describe("parseArgs", () => {
  it("does both platforms when neither flag is given", () => {
    expect(parseArgs([]).targets).toEqual(["win32", "linux"]);
  });

  it("narrows to one platform when asked", () => {
    expect(parseArgs(["--win-only"]).targets).toEqual(["win32"]);
    expect(parseArgs(["--linux-only"]).targets).toEqual(["linux"]);
  });

  it("refuses the pair instead of guessing, because both means the same as neither", () => {
    expect(() => parseArgs(["--win-only", "--linux-only"])).toThrow(UsageError);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // Silently ignoring a typo turns "--win-onyl" into "build everything",
    // which is the most expensive possible interpretation of a typo.
    expect(() => parseArgs(["--win-onyl"])).toThrow(UsageError);
  });

  it("keeps round 1 separate from a skipped check", () => {
    const options = parseArgs(["--skip-bundle"]);
    expect(options.skipBundle).toBe(true);
    expect(options.skipInstall).toBe(false);
    expect(options.skipFetch).toBe(false);
  });
});

describe("dereferenceTree", () => {
  it("replaces a relative symlink with the file it points at", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "cli.js"), "console.log(1);\n");
    await symlink(path.join("cli.js"), path.join(work, "link.js"));

    const result = await dereferenceTree(work);

    expect(result.replaced).toBe(1);
    // A link is a way of reaching content, so the content is what survives.
    expect(await readFile(path.join(work, "link.js"), "utf8")).toBe("console.log(1);\n");
  });

  it("refuses a dangling link instead of dropping it", async () => {
    if (work === null) throw new Error("no work directory");
    await symlink(path.join(work, "gone.js"), path.join(work, "link.js"));

    // Dropping it would leave the lock describing a tree with one file fewer
    // than the one on disk, and that mismatch surfaces at start-up, not here.
    await expect(dereferenceTree(work)).rejects.toThrow(/dangling symlink/);
  });
});

describe("scanArtifacts", () => {
  it("finds what the builder wrote instead of expecting names", async () => {
    if (work === null) throw new Error("no work directory");
    await mkdir(path.join(work, "win-unpacked"), { recursive: true });
    await writeFile(path.join(work, "win-unpacked", "app.exe"), "BINARY");
    await writeFile(path.join(work, "haruyuki-0.1.0-win-x64.zip"), "ZIPDATA");

    const found = await scanArtifacts(work);

    // The tree is zip content, not something a user downloads.
    expect(found.map((artifact) => artifact.file)).toEqual(["haruyuki-0.1.0-win-x64.zip"]);
    expect(found[0]?.bytes).toBe(7);
  });

  it("returns nothing for a directory that does not exist yet", async () => {
    expect(await scanArtifacts(path.join(work ?? "", "release"))).toEqual([]);
  });
});

describe("scanTrees", () => {
  it("reports the unpacked tree that the artifact list leaves out", async () => {
    if (work === null) throw new Error("no work directory");
    await mkdir(path.join(work, "win-unpacked"), { recursive: true });
    await writeFile(path.join(work, "win-unpacked", "app.exe"), "BINARY");

    // The tree is not a download, so it stays out of the artifacts - but a
    // manifest that never mentions it cannot judge the artifact claim.
    expect(await scanTrees(work)).toEqual(["win-unpacked"]);
    expect((await scanArtifacts(work)).map((artifact) => artifact.file)).toEqual([]);
  });
});

describe("readAppVersion", () => {
  it("takes the version from package.json, which is the only place it lives", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "package.json"), JSON.stringify({ version: "2.3.4" }), "utf8");

    expect(await readAppVersion(work)).toBe("2.3.4");
  });

  it("says null rather than inventing a version for a package that has none", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "package.json"), JSON.stringify({ name: "x" }), "utf8");

    expect(await readAppVersion(work)).toBeNull();
  });
});

describe("localTagExists", () => {
  it("answers yes or no from git, and says so when git cannot answer", async () => {
    if (work === null) throw new Error("no work directory");

    // No tag is created here: the probe is asked about a name that cannot be a
    // release, and about a directory that is not a checkout at all.
    expect(localTagExists("v0.0.0-no-such-release")).toBe(false);
    expect(localTagExists("v0.1.0", work)).toBeNull();
  });
});

describe("versionConflict", () => {
  it("allows a version no tag claims", async () => {
    expect(
      await versionConflict(
        async () => "0.1.0",
        () => false,
      ),
    ).toBeNull();
  });

  it("refuses a version that is already a tag, and says which tag", async () => {
    const refusal = await versionConflict(
      async () => "0.1.0",
      () => true,
    );

    expect(refusal?.prefix).toBe(ERROR_PREFIX.tagTaken);
    expect(refusal?.message).toContain("v0.1.0");
    expect(refusal?.message).toContain("apps/desktop/package.json");
    // The reader has to know the refusal cost them nothing, and what to do next.
    expect(refusal?.message).toContain("Nothing was built");
  });

  it("refuses when git cannot say whether the tag exists", async () => {
    // "unknown" has to be louder than "no": the guard exists to make a silent
    // re-release impossible, and answering "maybe taken" as "free" is how that
    // silence happens.
    const refusal = await versionConflict(
      async () => "0.1.0",
      () => null,
    );

    expect(refusal?.prefix).toBe(ERROR_PREFIX.tagUnknown);
    expect(refusal?.message).toContain("could not read the tag list");
    expect(refusal?.message).toContain("Nothing was built");
  });

  it("says the two ways of refusing are different, because the fixes differ", async () => {
    const taken = await versionConflict(
      async () => "0.1.0",
      () => true,
    );
    const unknown = await versionConflict(
      async () => "0.1.0",
      () => null,
    );

    // Bumping the version fixes one and only one of these; a caller told "the
    // number is taken" would bump and hit the same wall again.
    expect(taken?.prefix).not.toBe(unknown?.prefix);
  });

  it("refuses a package with no version instead of packaging under a blank tag", async () => {
    const refusal = await versionConflict(
      async () => null,
      () => false,
    );

    expect(refusal?.prefix).toBe(ERROR_PREFIX.prerequisite);
    expect(refusal?.message).toContain("no version");
  });
});

describe("previousBuildNote", () => {
  it("says nothing when there is no earlier document", async () => {
    if (work === null) throw new Error("no work directory");

    expect(await previousBuildNote("0.1.0", work)).toBeNull();
  });

  it("finds the earlier build for the same version without being told the version", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "package.json"), JSON.stringify({ version: "0.1.0" }), "utf8");
    await mkdir(path.join(work, "release"), { recursive: true });
    await writeFile(
      path.join(work, "release", "release-manifest.json"),
      JSON.stringify({ appVersion: "0.1.0", builtAt: "T", commit: "C", dirty: false }),
      "utf8",
    );

    // The default call is the one the command actually makes. A version that
    // arrives as `undefined` compares unequal to everything and turns this
    // warning off for every leftover document, which is the failure this note
    // exists to prevent - so the unwired call is judged, not just the wired one.
    const note = await previousBuildNote(undefined, path.join(work, "release"));

    expect("message" in note! ? note.message : "").toContain("builtAt=T");
  });

  it("names the earlier build for the same version, in the fields that identify it", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(
      path.join(work, "release-manifest.json"),
      JSON.stringify({
        appVersion: "0.1.0",
        builtAt: "2026-11-18T10:45:04.999Z",
        commit: "36f9a42",
        dirty: true,
      }),
      "utf8",
    );

    const note = await previousBuildNote("0.1.0", work);

    expect("message" in note! ? note.message : "").toContain("builtAt=2026-11-18T10:45:04.999Z");
    expect("message" in note! ? note.message : "").toContain("commit=36f9a42");
    expect("message" in note! ? note.message : "").toContain("dirty=true");
  });

  it("says nothing about a document that describes another version", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(
      path.join(work, "release-manifest.json"),
      JSON.stringify({ appVersion: "0.0.9", builtAt: "x", commit: "y", dirty: false }),
      "utf8",
    );

    // A leftover from an older version is expected in a build tree and says
    // nothing about this one.
    expect(await previousBuildNote("0.1.0", work)).toBeNull();
  });

  it("reports an unreadable document instead of skipping it", async () => {
    if (work === null) throw new Error("no work directory");
    await writeFile(path.join(work, "release-manifest.json"), "{ not json", "utf8");

    const note = await previousBuildNote("0.1.0", work);

    // The run is about to overwrite it; saying nothing is worst exactly here.
    expect("unreadable" in note!).toBe(true);
  });
});

describe("runPipeline", () => {
  it("stops before the first step when the version is already published", async () => {
    const calls: string[] = [];
    const lines: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => ({
        prefix: ERROR_PREFIX.tagTaken,
        message: "there is no v0.1.0 left to build",
      }),
      roundOne: async () => {
        calls.push("roundOne");
        return 0;
      },
      roundTwo: async () => {
        calls.push("roundTwo");
        return 0;
      },
      stderr: (text) => lines.push(text),
    });

    // Nothing was attempted, so no round ran and there is nothing to describe.
    expect(code).toBe(2);
    expect(calls).toEqual([]);
    expect(lines.join("")).toContain("there is no v0.1.0 left to build");
  });

  it("runs both rounds when the version is free", async () => {
    const calls: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => null,
      previousBuildNote: async () => null,
      roundOne: async () => {
        calls.push("roundOne");
        return 0;
      },
      roundTwo: async () => {
        calls.push("roundTwo");
        return 0;
      },
      stderr: () => {},
    });

    expect(code).toBe(0);
    expect(calls).toEqual(["roundOne", "roundTwo"]);
  });

  it("runs the second time for the same version, because a leftover document is not a publication", async () => {
    const calls: string[] = [];
    const lines: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => null,
      previousBuildNote: async () => ({
        message: "release/release-manifest.json already describes 0.1.0: builtAt=T1 commit=C1",
      }),
      roundOne: async () => {
        calls.push("roundOne");
        return 0;
      },
      roundTwo: async () => {
        calls.push("roundTwo");
        return 0;
      },
      stderr: (text) => lines.push(text),
    });

    // Re-runnable is the whole point: refusing here would make the same command
    // fail merely because it succeeded before.
    expect(code).toBe(0);
    expect(calls).toEqual(["roundOne", "roundTwo"]);
    // Not silent, though: the old documents are named before being overwritten.
    expect(lines.join("")).toContain("builtAt=T1 commit=C1");
  });

  it("warns about an unreadable leftover instead of passing over it", async () => {
    const lines: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => null,
      previousBuildNote: async () => ({ unreadable: "release/release-manifest.json is not JSON" }),
      roundOne: async () => 0,
      roundTwo: async () => 0,
      stderr: (text) => lines.push(text),
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("release/release-manifest.json is not JSON");
  });

  it("does not start the second round when the first one failed", async () => {
    const calls: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => null,
      previousBuildNote: async () => null,
      roundOne: async () => {
        calls.push("roundOne");
        return 2;
      },
      roundTwo: async () => {
        calls.push("roundTwo");
        return 0;
      },
      stderr: () => {},
    });

    expect(code).toBe(2);
    expect(calls).toEqual(["roundOne"]);
  });
});

describe("ERROR_PREFIX", () => {
  it("gives each source of exit code 2 its own fixed first line", () => {
    const prefixes = [
      ERROR_PREFIX.prerequisite,
      ERROR_PREFIX.usage,
      ERROR_PREFIX.tagTaken,
      ERROR_PREFIX.tagUnknown,
    ];

    // Same code, four causes. A check that reads only the exit code cannot tell
    // "typo" from "broken install" from "already published".
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("writes a distinguishable first line for a usage error", async () => {
    const lines: string[] = [];

    const code = await runPipeline(["--win-only", "--linux-only"], {
      stderr: (text) => lines.push(text),
    });

    expect(code).toBe(2);
    expect(lines[0]?.startsWith(`${ERROR_PREFIX.usage}\n`)).toBe(true);
  });

  it("writes a distinguishable first line for a refusal", async () => {
    const lines: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => ({
        prefix: ERROR_PREFIX.tagTaken,
        message: "v0.1.0 is taken",
      }),
      stderr: (text) => lines.push(text),
    });

    expect(code).toBe(2);
    expect(lines[0]?.startsWith(`${ERROR_PREFIX.tagTaken}\n`)).toBe(true);
    // The three sources never share a first line, so the source survives being
    // read by something that only sees the log.
    expect(ERROR_PREFIX.tagTaken).not.toBe(ERROR_PREFIX.usage);
  });

  it("writes a distinguishable first line when a prerequisite is missing", async () => {
    const lines: string[] = [];

    const code = await runPipeline([], {
      versionConflict: async () => ({
        prefix: ERROR_PREFIX.prerequisite,
        message: "apps/desktop/package.json has no version",
      }),
      stderr: (text) => lines.push(text),
    });

    // The same code as a typo, and the opposite reaction: one is fixed by
    // editing the command line, this one by restoring the checkout.
    expect(code).toBe(2);
    expect(lines[0]?.startsWith(`${ERROR_PREFIX.prerequisite}\n`)).toBe(true);
  });
});

describe("roundOne", () => {
  it("names a failed install as a prerequisite, not as a version problem", async () => {
    const lines: string[] = [];
    const originalErr = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    const originalOut = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;
    process.stderr.write = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    // The step log is noise here: this test is about which line the failure
    // carries, not about the progress report around it.
    process.stdout.write = () => true;

    let code: number;
    try {
      // The first step fails and nothing after it runs, so this reaches the
      // real branch without touching node_modules.
      code = await roundOne({ skipInstall: false, skipFetch: false }, () => ({ status: 1 }));
    } finally {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    }

    expect(code).toBe(2);
    expect(lines.join("")).toContain(ERROR_PREFIX.prerequisite);
    // The prefix is what tells this apart from a usage error or a taken tag,
    // and this is the only branch that proves the line is actually written.
    expect(lines.join("")).not.toContain(ERROR_PREFIX.usage);
    expect(lines.join("")).not.toContain(ERROR_PREFIX.tagTaken);
  });
});
