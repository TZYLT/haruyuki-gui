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

import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { platformStates } from "./manifest.mjs";
import {
  containerAvailable,
  dereferenceTree,
  ERROR_PREFIX,
  isWrittenDocument,
  localTagExists,
  manifestArgs,
  parseArgs,
  previousBuildNote,
  readAppVersion,
  roundOne,
  runPipeline,
  scanArtifacts,
  scanTrees,
  targetDecision,
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

  it("refuses a reason for a platform this run was told not to build", () => {
    // Two assertions about one platform: `skipped, not-required` from the flag
    // and `not-built, <reason>` from the option. A manifest can only carry one,
    // so whichever lost would be a decision nobody made.
    expect(() => parseArgs(["--win-only", "--linux-not-built=docker-unavailable"])).toThrow(
      UsageError,
    );
    // The refusal has to say which two flags collided, and name them.
    try {
      parseArgs(["--win-only", "--linux-not-built=docker-unavailable"]);
    } catch (error) {
      expect(String(error)).toContain("--linux-not-built");
      expect(String(error)).toContain("--win-only");
    }
  });

  it("accepts a reason alongside the platform it is about", () => {
    // Requested and impossible is a legitimate answer, and the reason is how it
    // gets stated. Refusing this pair would break the only way to report it.
    const options = parseArgs(["--linux-only", "--linux-not-built=docker-unavailable"]);
    expect(options.targets).toEqual(["linux"]);
    expect(options.linuxNotBuilt).toBe("docker-unavailable");
  });

  it("accepts a reason when both platforms are asked for, because neither is excluded", () => {
    const options = parseArgs(["--linux-not-built=machine-offline"]);
    expect(options.targets).toEqual(["win32", "linux"]);
    expect(options.linuxNotBuilt).toBe("machine-offline");
  });

  it("refuses a reason outside the enum before any step runs", () => {
    // It becomes a field of the manifest, so an invented value would be published
    // as if it were a known cause.
    expect(() => parseArgs(["--linux-not-built=it-just-did-not-work"])).toThrow(UsageError);
    expect(() => parseArgs(["--linux-not-built="])).toThrow(UsageError);
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

  it("does not list the documents a previous run left as artifacts of this one", async () => {
    if (work === null) throw new Error("no work directory");
    // A second run in the same directory. `SHA256SUMS` and the manifest are
    // this pipeline's own output, written after this list is read: listing
    // yesterday's copies would present stale hashes as the description of what
    // just shipped. The seed is explicit because "it looked right when I ran it
    // once" is exactly how a plausible artifact list goes wrong unnoticed.
    await writeFile(path.join(work, "SHA256SUMS"), `${"a".repeat(64)}  old.zip\n`);
    await writeFile(path.join(work, "release-manifest.json"), '{"appVersion":"0.0.9"}');
    await writeFile(path.join(work, "Haruyuki-0.1.0-win-x64.zip"), "ZIPDATA");
    await writeFile(path.join(work, "builder-debug.yml"), "debug log");

    const found = await scanArtifacts(work);

    expect(found.map((artifact) => artifact.file)).toEqual(["Haruyuki-0.1.0-win-x64.zip"]);
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

    // A temporary directory is not a checkout, so git cannot answer and the
    // probe must say so with null rather than with false.
    expect(localTagExists("v0.1.0", work)).toBeNull();
  });

  it("agrees with git about the tags the checkout actually carries", async () => {
    // No hard-coded name. The previous version of this test asked about
    // `v0.1.0` and expected false, which holds only in a checkout that has not
    // tagged that version - so it passed here and failed on the machine that
    // does the releases. Asking what git lists, then requiring the probe to
    // agree both ways, is a claim about the probe rather than about the machine.
    // A checkout that carries no history can make this throw; that is not a
    // verdict about the probe, so it is read as "nothing to compare".
    const listed = (() => {
      try {
        return execFileSync("git", ["tag", "--list"], { encoding: "utf8" });
      } catch {
        return "";
      }
    })()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    for (const tag of listed.slice(0, 3)) {
      expect(localTagExists(tag), `git lists ${tag} but the probe denies it`).toBe(true);
    }
    // A checkout may legitimately carry no tags at all, so the negative case is
    // a name chosen not to exist rather than one assumed to be unused.
    expect(localTagExists("v0.0.0-no-such-release")).toBe(false);
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

describe("targetDecision", () => {
  it("answers 3 for linux-only when there is no container to build it in", () => {
    // The one exit code nothing had ever asked for. Linux has a single route in
    // this item - the container - so asking for it on a box without one is "this
    // machine cannot do the only thing requested", not a build that broke.
    const decision = targetDecision(
      { targets: ["linux"], linuxNotBuilt: null },
      {
        available: false,
      },
    );

    expect(decision?.code).toBe(3);
  });

  it("does not answer 3 when the container is there", () => {
    // Machine is capable: whatever happens next is about the build, so the
    // verdict must come from the build and not from here.
    const decision = targetDecision(
      { targets: ["linux"], linuxNotBuilt: null },
      {
        available: true,
      },
    );

    expect(decision).toBeNull();
  });

  it("never answers 3 when another target was also requested", () => {
    // There is other work to do, so the run's verdict is about what it did.
    // `3` here would replace a real result with "this machine could not".
    for (const targets of [["win32"], ["win32", "linux"]]) {
      expect(targetDecision({ targets, linuxNotBuilt: null }, { available: false })).toBeNull();
    }
  });

  it("says the target cannot be built here rather than that the build failed", () => {
    const decision = targetDecision(
      { targets: ["linux"], linuxNotBuilt: null },
      {
        available: false,
      },
    );

    // A reader who sees "failed" will go looking for a broken build that never
    // started; the message has to say nothing was attempted.
    expect(decision?.message).toContain("nothing was attempted");
    expect(decision?.message).not.toContain("build failure.");
  });
});

describe("containerAvailable", () => {
  it("reads the probe's answer rather than trusting a platform check", () => {
    // Deliberately not `process.platform`: a Linux host without Docker is
    // exactly the case that must come out as unavailable, and a host check
    // would call it capable.
    expect(
      containerAvailable(
        () => ({ status: 0 }),
        () => false,
      ),
    ).toBe(true);
    expect(
      containerAvailable(
        () => ({ status: 1 }),
        () => false,
      ),
    ).toBe(false);
  });

  it("treats a probe that cannot run at all as no container", () => {
    // `docker` is not on PATH: the spawn throws, which is the most common way
    // this machine has no container, and it must not crash the command.
    expect(
      containerAvailable(
        () => {
          throw new Error("ENOENT");
        },
        () => false,
      ),
    ).toBe(false);
  });

  it("is available from inside the container, where no daemon exists to ask", () => {
    // The image has no Docker in it. Asking the daemon there answers "no" about
    // the one place that can do the work - which would turn the only working
    // route into an exit 3.
    expect(
      containerAvailable(
        () => ({ status: 1 }),
        (p) => p === "/.dockerenv",
      ),
    ).toBe(true);
    expect(
      containerAvailable(
        () => ({ status: 1 }),
        (p) => p === "/run/.containerenv",
      ),
    ).toBe(true);
  });
});

describe("runPipeline", () => {
  it("returns 3 and starts no round when linux is the only target and there is no container", async () => {
    const calls: string[] = [];
    const lines: string[] = [];

    const code = await runPipeline(["--linux-only"], {
      versionConflict: async () => null,
      previousBuildNote: async () => null,
      container: () => false,
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

    expect(code).toBe(3);
    // Decided before any work: a twenty-minute runtime stage is not the place to
    // discover the machine lacks the route.
    expect(calls).toEqual([]);
    expect(lines.join("").startsWith(`${ERROR_PREFIX.cannotBuild} `)).toBe(true);
  });

  it("runs when the same request has a container, because the machine can do it", async () => {
    const calls: string[] = [];

    const code = await runPipeline(["--linux-only"], {
      versionConflict: async () => null,
      previousBuildNote: async () => null,
      container: () => true,
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
      container: () => true,
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
      container: () => true,
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
      container: () => true,
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
      container: () => true,
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

describe("isWrittenDocument", () => {
  it("keeps this build's own outputs out of the artifact list", () => {
    // A second run in the same directory finds yesterday's SHA256SUMS and
    // manifest. Listing them as artifacts presents stale hashes as if they
    // described what just shipped, and the manifest is written after this list
    // is printed - so its own output cannot be one of its inputs.
    expect(isWrittenDocument("SHA256SUMS")).toBe(true);
    expect(isWrittenDocument("release-manifest.json")).toBe(true);
    expect(isWrittenDocument("builder-debug.yml")).toBe(true);
  });

  it("keeps the packages themselves in it", () => {
    expect(isWrittenDocument("Haruyuki-0.1.0-win-x64.zip")).toBe(false);
    expect(isWrittenDocument("Haruyuki-0.1.0-linux-x86_64.AppImage")).toBe(false);
  });
});

describe("manifestArgs", () => {
  it("carries what this run was asked to build into the manifest", () => {
    // The manifest decides between "skipped" and "not-built" from this list
    // alone. Losing it makes a Windows-only run describe itself as a machine
    // that could not build Linux, and the manifest then exits non-zero over a
    // platform nobody requested.
    expect(manifestArgs({ targets: ["win32"], linuxNotBuilt: null })).toEqual(["--targets=win32"]);
    expect(manifestArgs({ targets: ["win32", "linux"], linuxNotBuilt: null })).toEqual([
      "--targets=win32,linux",
    ]);
  });

  it("passes the stated reason through for a platform that was attempted", () => {
    expect(
      manifestArgs({ targets: ["win32", "linux"], linuxNotBuilt: "docker-unavailable" }),
    ).toEqual(["--targets=win32,linux", "--linux-not-built=docker-unavailable"]);
  });

  it("never drops the requested targets, whichever flags the run added", () => {
    // A second switch that quietly replaced the whole list would reintroduce
    // the defect the targets list exists to prevent.
    for (const options of [
      { targets: ["win32"], linuxNotBuilt: null },
      { targets: ["win32"], linuxNotBuilt: "machine-offline" },
      { targets: ["linux"], linuxNotBuilt: "toolchain-missing" },
    ]) {
      expect(manifestArgs(options).some((arg) => arg.startsWith("--targets="))).toBe(true);
    }
  });

  it("makes a windows-only run skipped on Linux, not incapable of it", () => {
    // The whole chain the defect lived in: what the user typed, through what
    // the orchestration passes on, into the platform states the manifest
    // writes. Judged end to end because each link can look right on its own -
    // the flags parse fine, the arguments look plausible, and the run still
    // reports a request-only build as a broken machine.
    const options = parseArgs(["--win-only"]);
    const passed = manifestArgs(options);
    const targetsArg = passed.find((arg) => arg.startsWith("--targets="));
    expect(targetsArg).toBeDefined();
    const targets = String(targetsArg).slice("--targets=".length).split(",");

    const { states, unstated } = platformStates({
      produced: ["win32"],
      targets,
      linuxNotBuilt: options.linuxNotBuilt,
      builtInOf: (platform) => `${platform}@host`,
    });

    expect(states.linux).toEqual({ state: "skipped", reason: "not-required" });
    // Nothing was asked for and nothing is missing, so the manifest must not
    // turn this run into a failure.
    expect(unstated).toEqual([]);
  });
});
