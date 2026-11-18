/**
 * `manifest.mjs` writes the two documents a release page quotes. The thing that
 * matters is that they cannot drift apart, and the thing that is easy to get
 * wrong is guessing why a platform has no artifact.
 *
 * The upload list and the release body are judged here for a second reason: the
 * document is only useful if it can be followed, so "which files" has to be
 * checked against what the build produced rather than trusted.
 */

import { describe, expect, it } from "vitest";

import {
  ManifestInconsistency,
  assertSameHashes,
  argumentRefusalFor,
  assertUploadList,
  buildDocuments,
  hashTable,
  parseHashTable,
  parseUploadedFiles,
  platformOf,
  platformStates,
  refusalFor,
  releaseNotes,
} from "./manifest.mjs";

describe("platformOf", () => {
  it("reads the extension when the extension is enough", () => {
    expect(platformOf("Haruyuki-0.1.0-linux-x86_64.AppImage")).toBe("linux");
    expect(platformOf("Haruyuki Setup 0.1.0.exe")).toBe("win32");
  });

  it("breaks the tie on the name for a zip, which both platforms use", () => {
    expect(platformOf("Haruyuki-0.1.0-win-x64.zip")).toBe("win32");
    expect(platformOf("Haruyuki-0.1.0-linux-x64.zip")).toBe("linux");
  });

  it("returns null rather than guessing when the name says nothing", () => {
    // A wrong guess here attributes a file to a platform that never shipped it.
    expect(platformOf("bundle.zip")).toBeNull();
    expect(platformOf("builder-debug.yml")).toBeNull();
  });
});

describe("hashTable", () => {
  it("renders the same digests that go into SHA256SUMS", () => {
    const artifacts = [
      { file: "Haruyuki-0.1.0-win-x64.zip", sha256: "a".repeat(64) },
      { file: "Haruyuki-0.1.0-linux-x86_64.AppImage", sha256: "b".repeat(64) },
    ];

    const table = hashTable(artifacts);

    // One row per artifact, each carrying its own file name and digest, so a
    // reader can find a file without translating formats.
    for (const artifact of artifacts) {
      expect(table).toContain(artifact.file);
      expect(table).toContain(artifact.sha256);
    }
    expect(table.split("\n")).toHaveLength(artifacts.length + 2);
  });
});

const WIN_ZIP = "Haruyuki-0.1.0-win-x64.zip";
const LINUX_APPIMAGE = "Haruyuki-0.1.0-linux-x86_64.AppImage";
const WIN_SHA = "a".repeat(64);
const LINUX_SHA = "b".repeat(64);
const LINUX_DIGEST = `docker.m.daocloud.io/library/node:24-bookworm-slim@sha256:${"c".repeat(64)}`;

const artifacts = [
  { platform: "win32", file: WIN_ZIP, bytes: 238_996_715, sha256: WIN_SHA },
  { platform: "linux", file: LINUX_APPIMAGE, bytes: 201_819_595, sha256: LINUX_SHA },
];

/** @param {Record<string, unknown>} [overrides] */
function facts(overrides = {}) {
  return {
    packageJson: { version: "0.1.0", productName: "Haruyuki" },
    rootJson: {
      packageManager: "pnpm@10.24.0",
      devDependencies: { electron: "45.3.2", "electron-builder": "26.18.0" },
    },
    described: artifacts,
    trees: ["win-unpacked"],
    platforms: {
      win32: { state: "built", builtIn: "win32-x64@build-host" },
      linux: { state: "built", builtIn: LINUX_DIGEST },
    },
    engine: { version: "0.6.0", source: { kind: "npm", spec: "haruyuki@0.6.0" }, lockSha256: null },
    commit: "abc1234",
    builtAt: "2026-11-18T00:00:00.000Z",
    dirty: false,
    ...overrides,
  };
}

describe("uploadSteps", () => {
  it("writes the four steps in the order a person performs them", () => {
    const { manifest } = buildDocuments(facts());
    const steps = manifest.uploadSteps;

    expect(steps).toHaveLength(4);
    // The tag is created locally and not pushed: publishing is the user's act.
    expect(steps[0]).toContain(`git tag -a v0.1.0 -m "Haruyuki 0.1.0"`);
    expect(steps[0]).toContain("用户在本地建，不推送");
    expect(steps[1]).toContain("Draft a new release");
    expect(steps[1]).toContain("v0.1.0");
    expect(steps[3]).toBe("正文粘贴 releaseNotes");
  });

  it("names every file to attach, artifacts and documents alike", () => {
    const { manifest } = buildDocuments(facts());

    expect(parseUploadedFiles(manifest.uploadSteps)).toEqual([
      WIN_ZIP,
      LINUX_APPIMAGE,
      "SHA256SUMS",
      "release-manifest.json",
    ]);
    // A step list that leaves the reader to decide which files those are is the
    // defect this document exists to remove.
    expect(manifest.uploadSteps.join("\n")).not.toMatch(/上传：\s*$/m);
  });

  it("refuses a step list that names a file the build did not produce", () => {
    // The assertion is judged here, on the rendered steps, so removing it makes
    // this test - not merely the document - wrong.
    expect(() => assertUploadList([`上传：${WIN_ZIP}、missing.zip`], [WIN_ZIP])).toThrow(
      ManifestInconsistency,
    );
    expect(() => assertUploadList([`上传：${WIN_ZIP}`], [WIN_ZIP])).not.toThrow();
  });

  it("derives the file names from the step text, not from the array it rendered", () => {
    expect(parseUploadedFiles(["正文粘贴 releaseNotes"])).toEqual([]);
    expect(parseUploadedFiles([`上传：${WIN_ZIP}、SHA256SUMS`])).toEqual([WIN_ZIP, "SHA256SUMS"]);
  });
});

describe("releaseNotes", () => {
  it("carries the version as a title", () => {
    const { manifest } = buildDocuments(facts());

    expect(manifest.releaseNotes).toContain("# Haruyuki 0.1.0");
  });

  it("lists the same digest lines as SHA256SUMS, in the same order", () => {
    const { checksumText, manifest } = buildDocuments(facts());

    const lines = checksumText.trim().split("\n");
    const fromBody = parseHashTable(manifest.releaseNotes).map(
      (row) => `${row.sha256}  ${row.file}`,
    );

    expect(lines).toEqual([`${WIN_SHA}  ${WIN_ZIP}`, `${LINUX_SHA}  ${LINUX_APPIMAGE}`]);
    expect(fromBody).toEqual(lines);
  });

  it("catches a body whose digest differs from the checksum file", () => {
    // The assertion this file exists for has to be able to be false, otherwise
    // it is the same constant-true line it replaced.
    const doctored = hashTable([{ file: WIN_ZIP, sha256: "d".repeat(64) }]);
    expect(() => assertSameHashes(doctored, [`${WIN_SHA}  ${WIN_ZIP}`])).toThrow(/disagree/);
    // Same hashes in another format also disagree: a table is not a checksum line.
    expect(() => assertSameHashes("no table at all", [`${WIN_SHA}  ${WIN_ZIP}`])).toThrow(
      /disagree/,
    );
  });

  it("states each platform in one of the three ways it can be", () => {
    const built = buildDocuments(facts()).manifest.releaseNotes;
    expect(built).toContain("`win32`：已产出（win32-x64@build-host）");
    expect(built).toContain("`linux`：已产出");

    const missing = buildDocuments(
      facts({
        described: [artifacts[0]],
        platforms: {
          win32: { state: "built", builtIn: "win32-x64@build-host" },
          linux: { state: "not-built", reason: "docker-unavailable" },
        },
      }),
    ).manifest.releaseNotes;
    // A platform that was not built says so instead of vanishing from the body.
    expect(missing).toContain("`linux`：本版无产物（docker-unavailable）");

    const skipped = buildDocuments(
      facts({
        platforms: {
          win32: { state: "skipped", reason: "not-required" },
          linux: { state: "skipped", reason: "not-required" },
        },
      }),
    ).manifest.releaseNotes;
    expect(skipped).toContain("`linux`：本版不需要（not-required）");
  });

  it("keeps the unverified list to what applies to this build", () => {
    const both = buildDocuments(facts()).manifest.releaseNotes;
    expect(both).toContain("## 本版未验证项");
    expect(both).toContain("SmartScreen");
    expect(both).toContain("窗口是否真的画出来未验证");

    // No Linux artifact means no claim about a Linux window either.
    const winOnly = buildDocuments(
      facts({
        described: [artifacts[0]],
        platforms: {
          win32: { state: "built", builtIn: "win32-x64@build-host" },
          linux: { state: "not-built", reason: "docker-unavailable" },
        },
      }),
    ).manifest.releaseNotes;
    expect(winOnly).toContain("SmartScreen");
    expect(winOnly).not.toContain("窗口是否真的画出来未验证");
  });

  it("counts the bytes it lists instead of repeating a typed number", () => {
    const notes = releaseNotes({
      productName: "Haruyuki",
      version: "0.1.0",
      artifacts,
      platforms: facts().platforms,
    });

    expect(notes).toContain("合计 2 个文件");
  });
});

describe("buildDocuments", () => {
  it("writes a manifest that describes this build and nothing else", () => {
    const { checksumText, manifest } = buildDocuments(facts());

    expect(manifest.tag).toBe("v0.1.0");
    expect(manifest.appVersion).toBe("0.1.0");
    expect(manifest.artifacts).toEqual(artifacts);
    expect(manifest.platforms).toEqual(facts().platforms);
    expect(manifest.trees).toEqual(["win-unpacked"]);
    expect(manifest.dirty).toBe(false);
    // The two documents a downloader checks against, from one set of hashes.
    expect(checksumText).toBe(`${WIN_SHA}  ${WIN_ZIP}\n${LINUX_SHA}  ${LINUX_APPIMAGE}\n`);
  });

  it("refuses to describe a build under a version it cannot name", () => {
    // An empty version renders "v" as the tag and a blank title, which reads
    // like a real release; refusing is the only honest answer.
    expect(() => buildDocuments(facts({ packageJson: { version: "" } }))).toThrow(
      ManifestInconsistency,
    );
  });
});

describe("platformStates", () => {
  const BOTH = ["win32", "linux"];
  const builtInOf = (platform: string) => `${platform}@host`;

  it("records a platform this run was not asked for as skipped, not as missing", () => {
    // Asked to build Windows only. The other platform was never attempted, so
    // "this machine cannot build Linux" would be a claim about a machine that
    // was never asked the question.
    const { states, unstated } = platformStates({
      produced: ["win32"],
      targets: ["win32"],
      linuxNotBuilt: null,
      builtInOf,
    });

    expect(states.win32).toEqual({ state: "built", builtIn: "win32@host" });
    expect(states.linux).toEqual({ state: "skipped", reason: "not-required" });
    // Nothing is missing here: a skipped platform is an answer, so the caller
    // must not turn this run into a failure.
    expect(unstated).toEqual([]);
  });

  it("still calls a requested platform with no artifact unstated, so the run fails", () => {
    // The teeth: "asked for both, produced one" is not a choice, and must not
    // be reported as if it were.
    const { states, unstated } = platformStates({
      produced: ["win32"],
      targets: BOTH,
      linuxNotBuilt: null,
      builtInOf,
    });

    expect(states.linux).toEqual({ state: "not-built", reason: "unstated" });
    expect(unstated).toEqual(["linux"]);
  });

  it("keeps a stated reason when the requested platform was attempted and impossible", () => {
    const { states, unstated } = platformStates({
      produced: ["win32"],
      targets: BOTH,
      linuxNotBuilt: "docker-unavailable",
      builtInOf,
    });

    expect(states.linux).toEqual({ state: "not-built", reason: "docker-unavailable" });
    expect(unstated).toEqual([]);
  });

  it("does not let a reason excuse a platform nobody asked for", () => {
    // A reason describes an attempt. With no attempt there is nothing to explain,
    // and recording `not-built` here would say the box is incapable.
    const { states, unstated } = platformStates({
      produced: ["win32"],
      targets: ["win32"],
      linuxNotBuilt: "docker-unavailable",
      builtInOf,
    });

    expect(states.linux).toEqual({ state: "skipped", reason: "not-required" });
    expect(unstated).toEqual([]);
  });

  it("says built for an artifact that exists even if it was not asked for", () => {
    // The file is the authority on what it is: a leftover package is described
    // as built, because a reader downloading it would get it.
    const { states } = platformStates({
      produced: BOTH,
      targets: ["win32"],
      linuxNotBuilt: null,
      builtInOf,
    });

    expect(states.linux).toEqual({ state: "built", builtIn: "linux@host" });
  });
});

describe("refusalFor", () => {
  // Both reasons are checked before anything is written. A document that is
  // written and then declared invalid outlives the run that refused it, and the
  // next reader cannot tell a refused build's leftovers from a published one.

  it("refuses a requested platform that produced nothing and said nothing", () => {
    const refusal = refusalFor({ unstated: ["linux"], dirty: false, allowDirty: false });

    expect(refusal?.code).toBe(1);
    expect(refusal?.message).toContain("no reason given");
    expect(refusal?.message).toContain("linux");
  });

  it("refuses a dirty tree, which the requirement forbids releasing", () => {
    const refusal = refusalFor({ unstated: [], dirty: true, allowDirty: false });

    expect(refusal?.code).toBe(1);
    expect(refusal?.message).toContain("uncommitted changes");
    expect(refusal?.message).toContain("--dirty");
  });

  it("allows a dirty tree when the caller asked for a local build", () => {
    // `--dirty` is a decision, not a default: the document is produced and the
    // caller has said on purpose that it must not be published.
    expect(refusalFor({ unstated: [], dirty: true, allowDirty: true })).toBeNull();
  });

  it("allows a clean tree with every requested platform accounted for", () => {
    expect(refusalFor({ unstated: [], dirty: false, allowDirty: false })).toBeNull();
  });

  it("names the missing reason before the dirty tree, so one run reports one cause", () => {
    // Both are true; the earlier check wins so the message is actionable rather
    // than a list a reader has to triage.
    const refusal = refusalFor({ unstated: ["linux"], dirty: true, allowDirty: false });

    expect(refusal?.message).toContain("no reason given");
    expect(refusal?.message).not.toContain("uncommitted changes");
  });
});

describe("argumentRefusalFor", () => {
  // The pipeline refused this pair and this command accepted it, then dropped
  // half of it: the caller said why Linux is missing and the document said
  // nobody asked. Both scripts answer the same question, so both refuse.

  it("refuses a reason for a platform this run was not asked to build", () => {
    const refusal = argumentRefusalFor({ targets: ["win32"], linuxNotBuilt: "docker-unavailable" });

    expect(refusal).not.toBeNull();
    expect(refusal).toContain("not asked to build");
    expect(refusal).toContain("skipped");
  });

  it("accepts a reason when linux really was asked for", () => {
    expect(
      argumentRefusalFor({ targets: ["win32", "linux"], linuxNotBuilt: "docker-unavailable" }),
    ).toBeNull();
    expect(argumentRefusalFor({ targets: ["linux"], linuxNotBuilt: "machine-offline" })).toBeNull();
  });

  it("refuses a reason outside the enum", () => {
    const refusal = argumentRefusalFor({ targets: ["linux"], linuxNotBuilt: "it-just-broke" });

    expect(refusal).not.toBeNull();
    expect(refusal).toContain("must be one of");
    expect(refusal).toContain("not a missing capability");
  });

  it("says nothing when no reason was given", () => {
    expect(argumentRefusalFor({ targets: ["win32"], linuxNotBuilt: null })).toBeNull();
    expect(argumentRefusalFor({ targets: ["linux"], linuxNotBuilt: null })).toBeNull();
  });
});
