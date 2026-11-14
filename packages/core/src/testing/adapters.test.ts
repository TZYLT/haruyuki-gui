/**
 * Three-adapter parity: one call sequence, three `HostPort` shapes.
 *
 * Requirement source: docs/01-3 section 2.4 ("the same call sequence against
 * the desktop and VSCode doubles must produce the same observable results -
 * shapes and error codes equal, path content may differ"), docs/17-A3 section
 * 4.2 (A3 ships doubles only) and docs/18-A3 section 6 .
 *
 * The claim under test is narrow and honest. The three adapters are NOT expected
 * to be identical: a headless process has no notification channel, a desktop
 * window and a webview turn local paths into different URL shapes, and only two
 * of the three can read a drop. What must hold is that, for the same call, the
 * data shape and the failure code are the same, so `core` can be written once.
 * Everything that legitimately differs is asserted as a difference, not
 * normalised away - an "equality" test that strips a field is exactly how a
 * cross-shell bug survives.
 *
 * The doubles are test support, not product code: they live under
 * `packages/core/src/testing/` so the package root cannot import them, and they
 * must not import the headless implementation - the point is to compare the
 * three shapes, and one importing another would hide a drift instead of
 * exposing it.
 *
 * Cleanup is point-by-point: each file is unlinked and each directory is
 * unlinked and each directory is removed only after its children.
 */

import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createHeadlessHostPort } from "../port/headless-host-port";
import type { HostPort, HostPortStartup } from "../port/host-port";
import { createDesktopHostPort } from "./adapters/desktop";
import { createVscodeHostPort } from "./adapters/vscode";

/** Roots created by a case; removed once that case settles. */
const tempRoots = new Set<string>();

afterEach(async () => {
  for (const root of tempRoots) {
    await removeTree(root);
  }

  tempRoots.clear();
});

/** The frozen spawn-spec fields, used to compare the spec shape. */
const SPAWN_SPEC_FIELDS = [
  "exePath",
  "env",
  "argvPrefix",
  "bundlePath",
  "cwd",
  "stdio",
  "windowsHide",
  "detached",
] as const;

/** URLs all three adapters must reject with the same code. */
const REJECTED_URLS = [
  "mailto:dev@example.com",
  "file:///C:/Windows/win.ini",
  "javascript:alert(1)",
  "ftp://example.com/file",
  "../relative/path",
  "not a url",
  "",
];

/** The nine frozen members, in contract order. */
const CONTRACT_MEMBERS = [
  "secureGet",
  "secureSet",
  "secureDelete",
  "openExternal",
  "pickPaths",
  "resolveLocalResource",
  "onShutdown",
  "notify",
  "readDroppedFiles",
] as const;

type AdapterKind = "headless" | "desktop" | "vscode";

/**
 * The trace the adapters expose for assertions.
 *
 * It is not part of `HostPort`; it is the A3 test-support convention that makes
 * "the core asked for X" observable without a desktop shell. Comparing it across
 * adapters is extra evidence, not a frozen-contract claim.
 */
type TraceablePort = HostPort & {
  readonly calls: {
    openExternal: string[];
    notify: { level: string; message: string }[];
    pickPaths: number;
  };
};

type Fixture = {
  kind: AdapterKind;
  root: string;
  bundlePath: string;
  insideFile: string;
  outsideFile: string;
  /** One answer per `pickPaths` call; a list is a `multiple: true` answer. */
  pickedAnswers: Array<string | string[]>;
  droppedFilePath: string;
  droppedContent: string;
  port: TraceablePort;
  /** Run the callbacks registered through `onShutdown`. */
  shutdown: () => Promise<void> | void;
};

type SecureRead = Awaited<ReturnType<HostPort["secureGet"]>>;
type ExternalResult = Awaited<ReturnType<HostPort["openExternal"]>>;
type DroppedResult = Awaited<ReturnType<HostPort["readDroppedFiles"]>>;

/**
 * What the shared sequence observed.
 *
 * Split in two on purpose: `shared` is compared across adapters, `specific` is
 * where the legitimate differences are asserted. Nothing is dropped from the
 * comparison because it was inconvenient - a field that differs lands in
 * `specific` and gets an explicit assertion.
 */
type SequenceResult = {
  shared: {
    spawnOk: boolean;
    spawnFields: string[];
    spawnStdio: string | undefined;
    spawnWindowsHide: boolean | undefined;
    spawnDetached: boolean | undefined;
    spawnBundleIsAbsolute: boolean;
    spawnCwdIsUserData: boolean;
    spawnEnvHomeIsUserData: boolean;
    spawnEnvInheritsPath: boolean;
    secureSeeded: string | undefined;
    secureMissingCode: string;
    secureOverwrite: string | undefined;
    secureAfterDeleteCode: string;
    secureDeleteAbsentOk: boolean;
    externalAcceptedHttp: boolean;
    externalAcceptedHttps: boolean;
    externalRejectedCodes: string[];
    externalTraced: string[];
    pickFirstCount: number;
    pickSecondCount: number;
    pickCancelledCount: number;
    pickCallCount: number;
    notifyLevels: string[];
    notifyResolved: boolean;
    resourceInsideOk: boolean;
    resourceOutsideCodes: string[];
  };
  specific: {
    capabilities: HostPortStartup["capabilities"];
    paths: HostPortStartup["paths"];
    spawnExe: string;
    spawnElectronRunAsNode: string | undefined;
    resourceInsideUrl: string;
    pickFirstAnswer: string[];
    pickSecondAnswer: string[];
    dropped: DroppedResult;
  };
};

describe("headless, desktop and VSCode adapters agree", () => {
  it("runs one identical call sequence and gets the same shapes and codes", async () => {
    const { fixtures, results } = await createAll();

    expect(results.desktop.shared).toEqual(results.headless.shared);
    expect(results.vscode.shared).toEqual(results.headless.shared);

    // Each adapter handed back the answers it was queued with, at its own path
    // content: the call sequence is identical, the file names are not.
    for (const kind of ["headless", "desktop", "vscode"] as const) {
      const [firstAnswer, secondAnswer] = fixtures[kind].pickedAnswers;

      expect(firstAnswer).toBeDefined();
      expect(secondAnswer).toBeDefined();
      expect(results[kind].specific.pickFirstAnswer).toEqual(asList(firstAnswer));
      // The second call asks for `multiple: true`, so a list answer survives
      // whole; before this the parity test asked for multiple and asserted one.
      expect(results[kind].specific.pickSecondAnswer).toEqual(asList(secondAnswer));
      expect(results[kind].specific.pickSecondAnswer.length).toBe(2);
    }

    // Spot-check the meaningful entries rather than trusting the object diff
    // alone, so a future field added to `shared` cannot make the suite vacuous.
    expect(results.headless.shared.spawnOk).toBe(true);
    expect(results.headless.shared.spawnFields).toEqual([...SPAWN_SPEC_FIELDS].sort());
    expect(results.headless.shared.spawnStdio).toBe("pipe");
    expect(results.headless.shared.spawnCwdIsUserData).toBe(true);
    expect(results.headless.shared.spawnEnvHomeIsUserData).toBe(true);
    // A complete environment: the double hands the caller an env it can spawn
    // with, so `PATH` and the rest of the host's environment are present.
    expect(results.headless.shared.spawnEnvInheritsPath).toBe(true);
    expect(results.headless.shared.secureSeeded).toBe("seeded-value");
    expect(results.headless.shared.secureOverwrite).toBe("v2");
    expect(results.headless.shared.externalAcceptedHttp).toBe(true);
    expect(results.headless.shared.externalAcceptedHttps).toBe(true);
    expect(results.headless.shared.pickCallCount).toBe(3);
    expect(results.headless.shared.resourceInsideOk).toBe(true);
    expect(results.headless.shared.notifyLevels).toEqual(["info", "warn", "error"]);
    expect(results.headless.shared.notifyResolved).toBe(true);
  });

  it("answers the same frozen code for the same failure input", async () => {
    const { results } = await createAll();

    const headlessCodes = [
      results.headless.shared.secureMissingCode,
      ...results.headless.shared.externalRejectedCodes,
      ...results.headless.shared.resourceOutsideCodes,
    ];

    expect(headlessCodes).toContain("NOT_FOUND");
    expect(headlessCodes).toContain("REJECTED_SCHEME");
    expect(headlessCodes).toContain("OUT_OF_ROOT");

    expect([
      results.desktop.shared.secureMissingCode,
      ...results.desktop.shared.externalRejectedCodes,
      ...results.desktop.shared.resourceOutsideCodes,
    ]).toEqual(headlessCodes);

    expect([
      results.vscode.shared.secureMissingCode,
      ...results.vscode.shared.externalRejectedCodes,
      ...results.vscode.shared.resourceOutsideCodes,
    ]).toEqual(headlessCodes);

    // The rejected set is the contract's allow-list complement: every entry must
    // be rejected, not only the first one.
    expect(results.headless.shared.externalRejectedCodes).toEqual(
      REJECTED_URLS.map(() => "REJECTED_SCHEME"),
    );
  });

  it("differs only where the shells legitimately differ", async () => {
    const { fixtures, results } = await createAll();

    // 1. Capabilities: the four flags are the shell's self-report, so they are
    //    the one member that is supposed to differ.
    expect(results.headless.specific.capabilities).toEqual({
      canNotify: false,
      canReadDroppedFiles: false,
      canPopout: false,
      canFloatingWindow: false,
    });

    expect(results.desktop.specific.capabilities).toEqual({
      canNotify: true,
      canReadDroppedFiles: true,
      canPopout: true,
      canFloatingWindow: true,
    });

    expect(results.vscode.specific.capabilities).toEqual({
      canNotify: true,
      canReadDroppedFiles: true,
      canPopout: false,
      canFloatingWindow: false,
    });

    // 2. resolveLocalResource URL shape: file protocol, custom protocol,
    //    asWebviewUri-shaped https URL. All three parse as URLs and all three
    //    differ, so the same core code can treat the result as an opaque URL.
    const headlessUrl = results.headless.specific.resourceInsideUrl;
    const desktopUrl = results.desktop.specific.resourceInsideUrl;
    const vscodeUrl = results.vscode.specific.resourceInsideUrl;
    const urls = [headlessUrl, desktopUrl, vscodeUrl];

    expect(headlessUrl.startsWith("file:")).toBe(true);
    expect(desktopUrl.startsWith("haruyuki-resource:")).toBe(true);
    expect(vscodeUrl.startsWith("https://file+.vscode-resource.vscode-cdn.net/")).toBe(true);

    for (const url of urls) {
      expect(() => new URL(url)).not.toThrow();
    }

    expect(new Set(urls).size).toBe(3);

    // 3. readDroppedFiles support: headless refuses, desktop hands back a path,
    //    VSCode hands back base64 content. The names always survive.
    const droppedName = "dropped.txt";

    expect(results.headless.specific.dropped).toEqual({ ok: false, code: "UNSUPPORTED" });

    expect(results.desktop.specific.dropped).toEqual({
      ok: true,
      entries: [{ name: droppedName, path: fixtures.desktop.droppedFilePath }],
    });

    expect(results.vscode.specific.dropped).toEqual({
      ok: true,
      entries: [
        {
          name: droppedName,
          base64: Buffer.from(fixtures.vscode.droppedContent, "utf8").toString("base64"),
        },
      ],
    });

    // 4. Spawn executable: Electron's own binary with ELECTRON_RUN_AS_NODE for
    //    desktop, a node binary for VSCode, the running interpreter headless.
    expect(results.headless.specific.spawnExe).toBe(process.execPath);
    expect(results.desktop.specific.spawnExe).toBe(process.execPath);
    expect(results.vscode.specific.spawnExe).toBe("node");

    expect(results.desktop.specific.spawnElectronRunAsNode).toBe("1");
    // VSCode never adds the flag. It inherits the parent environment like every
    // other shell, so the assertion is about "not set by this port", not about
    // "absent" - on a host that already sets it, absent would be a CI fact.
    expect(results.vscode.specific.spawnElectronRunAsNode).toBe(
      process.env["ELECTRON_RUN_AS_NODE"],
    );

    // The headless spec carries a complete copy of the parent environment, so
    // the flag is inherited verbatim rather than added: on this host-process
    // tree it may already be set, and asserting its absence would test the CI
    // environment instead of the port.
    expect(results.headless.specific.spawnElectronRunAsNode).toBe(
      process.env["ELECTRON_RUN_AS_NODE"],
    );

    // The equality test above already proves the shared spawn fields match;
    // this makes the env difference explicit rather than incidental.
    expect(results.desktop.shared.spawnFields).toEqual(results.vscode.shared.spawnFields);
  });

  it("keeps path content different while the path shape stays identical", async () => {
    const { results } = await createAll();

    const userDataRoots = [
      results.headless.specific.paths.userData,
      results.desktop.specific.paths.userData,
      results.vscode.specific.paths.userData,
    ];

    for (const root of userDataRoots) {
      expect(path.isAbsolute(root)).toBe(true);
    }

    // Same four keys, same absolute strings, different content: this is the
    // "path content may differ" half of the parity rule.
    expect(Object.keys(results.headless.specific.paths).sort()).toEqual([
      "cache",
      "logs",
      "temp",
      "userData",
    ]);
    expect(Object.keys(results.desktop.specific.paths).sort()).toEqual(
      Object.keys(results.headless.specific.paths).sort(),
    );
    expect(Object.keys(results.vscode.specific.paths).sort()).toEqual(
      Object.keys(results.headless.specific.paths).sort(),
    );

    expect(new Set(userDataRoots).size).toBe(3);
  });

  it("registers shutdown synchronously and runs callbacks once on the shell trigger", async () => {
    const { fixtures } = await createAll();

    for (const kind of ["headless", "desktop", "vscode"] as const) {
      const fixture = fixtures[kind];
      let invocations = 0;

      const returned = fixture.port.onShutdown(() => {
        invocations += 1;
      });

      expect(returned).toBeUndefined();
      expect(invocations).toBe(0);

      await fixture.shutdown();
      expect(invocations).toBe(1);

      // A second quit/deactivate event must not re-run callbacks: they stop
      // child processes.
      await fixture.shutdown();
      expect(invocations).toBe(1);
    }
  });

  it("exposes the nine frozen members and is usable as the startup subset", async () => {
    const { fixtures } = await createAll();
    const startupPorts: HostPortStartup[] = [];

    for (const kind of ["headless", "desktop", "vscode"] as const) {
      const { port } = fixtures[kind];

      for (const member of CONTRACT_MEMBERS) {
        expect(typeof port[member]).toBe("function");
      }

      // Compile-time proof that every adapter is assignable to the v1 startup
      // subset, which is what lets B1's consumers keep working.
      startupPorts.push(port);
    }

    expect(startupPorts).toHaveLength(3);
  });
});

type AllFixtures = Record<AdapterKind, Fixture>;
type AllResults = Record<AdapterKind, SequenceResult>;

/**
 * Build one fixture per adapter and run the identical sequence on each.
 *
 * Each adapter gets its own disposable root: three shells do not share a data
 * directory, and separate roots are what make "path content may differ" a real
 * observation instead of a fixture coincidence.
 */
async function createAll(): Promise<{ fixtures: AllFixtures; results: AllResults }> {
  const fixtures: AllFixtures = {
    headless: await createHeadlessFixture(),
    desktop: await createDesktopFixture(),
    vscode: await createVscodeFixture(),
  };

  const results: AllResults = {
    headless: await runSequence(fixtures.headless),
    desktop: await runSequence(fixtures.desktop),
    vscode: await runSequence(fixtures.vscode),
  };

  return { fixtures, results };
}

/**
 * The one call sequence the parity cases compare.
 *
 * It touches all nine members in contract order. The inputs are the same for
 * every adapter except the adapter's own path content (each root differs) and
 * the dropped-file payload, which is where the shells differ by design.
 */
/** @param value a queued pick answer @returns always a list */
function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return typeof value === "string" ? [value] : value;
}

async function runSequence(fixture: Fixture): Promise<SequenceResult> {
  const { port } = fixture;

  // Item 2: the spawn spec.
  const spawn = await port.getRuntimeSpawnSpec();
  const spec = spawn.ok ? spawn.spec : undefined;
  const envHome = spec?.env["HARUYUKI_HOME"];

  // Item 3: the secure store, including overwrite and idempotent delete.
  const seeded = await port.secureGet("token");
  const missing = await port.secureGet("missing");
  await port.secureSet("added", "v1");
  await port.secureSet("added", "v2");
  const overwritten = await port.secureGet("added");
  await port.secureDelete("added");
  const afterDelete = await port.secureGet("added");
  const deleteAbsent = await port.secureDelete("absent");

  // Item 4: one accepted URL per scheme, then the whole rejected set.
  const acceptedHttp = await port.openExternal("http://example.com");
  const acceptedHttps = await port.openExternal("https://example.com/path");
  const rejected: string[] = [];

  for (const url of REJECTED_URLS) {
    rejected.push(externalCode(await port.openExternal(url)));
  }

  // Item 5: two queued answers, then cancellation.
  const firstPick = await port.pickPaths({ kind: "file" });
  const secondPick = await port.pickPaths({ kind: "directory", multiple: true });
  const cancelledPick = await port.pickPaths({ kind: "file" });

  // Item 6: one path inside the allowed root, then every documented escape.
  const insideResource = await port.resolveLocalResource(fixture.insideFile);
  const outsideCodes: string[] = [];

  for (const candidate of outOfRootCandidates(fixture)) {
    const answer = await port.resolveLocalResource(candidate);

    outsideCodes.push(answer.ok ? "OK" : answer.code);
  }

  // Item 8: every level, all of which must resolve.
  const notifyLevels: string[] = [];
  let notifyResolved = true;

  for (const level of ["info", "warn", "error"] as const) {
    try {
      await port.notify(level, `parity ${level}`);
      notifyLevels.push(level);
    } catch {
      notifyResolved = false;
    }
  }

  // Item 9: one dropped file, shaped the way a drop reaches each shell.
  const dropped = await port.readDroppedFiles([
    { name: "dropped.txt", path: fixture.droppedFilePath },
  ]);

  return {
    shared: {
      spawnOk: spawn.ok,
      spawnFields: spec === undefined ? [] : Object.keys(spec).sort(),
      spawnStdio: spec?.stdio,
      spawnWindowsHide: spec?.windowsHide,
      spawnDetached: spec?.detached,
      spawnBundleIsAbsolute: spec !== undefined && path.isAbsolute(spec.bundlePath),
      spawnCwdIsUserData: spec !== undefined && spec.cwd === port.paths.userData,
      spawnEnvHomeIsUserData: envHome === port.paths.userData,
      spawnEnvInheritsPath: spec !== undefined && spec.env["PATH"] === process.env["PATH"],
      secureSeeded: readValue(seeded),
      secureMissingCode: readCode(missing),
      secureOverwrite: readValue(overwritten),
      secureAfterDeleteCode: readCode(afterDelete),
      secureDeleteAbsentOk: deleteAbsent.ok,
      externalAcceptedHttp: acceptedHttp.ok,
      externalAcceptedHttps: acceptedHttps.ok,
      externalRejectedCodes: rejected,
      externalTraced: [...port.calls.openExternal],
      pickFirstCount: firstPick.length,
      pickSecondCount: secondPick.length,
      pickCancelledCount: cancelledPick.length,
      pickCallCount: port.calls.pickPaths,
      notifyLevels,
      notifyResolved,
      resourceInsideOk: insideResource.ok,
      resourceOutsideCodes: outsideCodes,
    },
    specific: {
      capabilities: port.capabilities,
      paths: port.paths,
      spawnExe: spec?.exePath ?? "",
      spawnElectronRunAsNode: spec?.env["ELECTRON_RUN_AS_NODE"],
      resourceInsideUrl: insideResource.ok ? insideResource.url : "",
      pickFirstAnswer: firstPick,
      pickSecondAnswer: secondPick,
      dropped,
    },
  };
}

/** Build the headless fixture on its own disposable root. */
async function createHeadlessFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const engineHome = path.join(root, "engine-home");
  const bundlePath = prepareBundle(root);
  const pickedAnswers = [
    path.join(root, "pick-1.txt"),
    [path.join(root, "pick-2.txt"), path.join(root, "pick-3.txt")],
  ];

  const port = await createHeadlessHostPort({
    bundlePath,
    engineHome,
    pickQueue: pickedAnswers,
    secureSeed: { token: "seeded-value" },
  });

  return {
    kind: "headless",
    root,
    bundlePath,
    insideFile: path.join(engineHome, "userData", "state.json"),
    outsideFile: path.join(root, "outside.txt"),
    pickedAnswers,
    droppedFilePath: path.join(root, "dropped.txt"),
    droppedContent: "dropped-bytes",
    port,
    shutdown: () => port.dispose(),
  };
}

/** Build the desktop double with `app.getPath`-style roots. */
async function createDesktopFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const bundlePath = prepareBundle(root);
  const pickedAnswers = [
    path.join(root, "pick-1.txt"),
    [path.join(root, "pick-2.txt"), path.join(root, "pick-3.txt")],
  ];

  const paths: HostPortStartup["paths"] = {
    userData: path.join(root, "desktop", "userData"),
    logs: path.join(root, "desktop", "logs"),
    cache: path.join(root, "desktop", "cache"),
    temp: path.join(root, "desktop", "temp"),
  };

  const port = await createDesktopHostPort({
    bundlePath,
    paths,
    pickQueue: pickedAnswers,
    secureSeed: { token: "seeded-value" },
  });

  return {
    kind: "desktop",
    root,
    bundlePath,
    insideFile: path.join(paths.userData, "state.json"),
    outsideFile: path.join(root, "outside.txt"),
    pickedAnswers,
    droppedFilePath: path.join(root, "dropped.txt"),
    droppedContent: "dropped-bytes",
    port,
    shutdown: () => port.triggerShutdown(),
  };
}

/** Build the VSCode double with `context.globalStorageUri`-style roots. */
async function createVscodeFixture(): Promise<Fixture> {
  const root = await makeRoot();
  const bundlePath = prepareBundle(root);
  const pickedAnswers = [
    path.join(root, "pick-1.txt"),
    [path.join(root, "pick-2.txt"), path.join(root, "pick-3.txt")],
  ];
  const storageRoot = path.join(root, "vscode", "globalStorage");

  const port = await createVscodeHostPort({
    bundlePath,
    globalStorageUri: pathToFileURL(storageRoot).href,
    pickQueue: pickedAnswers,
    secureSeed: { token: "seeded-value" },
    droppedContent: { "dropped.txt": "dropped-bytes" },
  });

  return {
    kind: "vscode",
    root,
    bundlePath,
    insideFile: path.join(storageRoot, "userData", "state.json"),
    outsideFile: path.join(root, "outside.txt"),
    pickedAnswers,
    droppedFilePath: path.join(root, "dropped.txt"),
    droppedContent: "dropped-bytes",
    port,
    shutdown: () => port.triggerShutdown(),
  };
}

/** Create a disposable root, write a fake bundle into it, and remember the root. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "haruyuki-adapter-parity-"));

  tempRoots.add(root);

  return root;
}

/** Write a fake engine bundle and return its absolute path. */
function prepareBundle(root: string): string {
  const bundlePath = path.join(root, "engine.mjs");

  writeFileSync(bundlePath, "// fake engine bundle\n");

  return bundlePath;
}

/**
 * Every documented `OUT_OF_ROOT` escape, built from the fixture's own roots.
 *
 * The `..` entry climbs two levels from the inside file's directory so it lands
 * outside every adapter's allowed root, whatever that root is.
 */
function outOfRootCandidates(fixture: Fixture): string[] {
  const candidates = [
    fixture.outsideFile,
    path.join(path.dirname(fixture.insideFile), "..", "..", "escape.txt"),
    "state.json",
    "../relative.txt",
  ];

  const otherDrive = anotherDrivePath(fixture.root);

  if (otherDrive !== undefined) {
    candidates.push(otherDrive);
  }

  return candidates;
}

/**
 * A path on a drive other than the fixture root's, or `undefined` on POSIX.
 *
 * The path need not exist: containment is lexical, so the answer does not depend
 * on the drive being mounted.
 */
function anotherDrivePath(root: string): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const currentRoot = path.parse(path.resolve(root)).root;
  const currentLetter = currentRoot.slice(0, 1).toUpperCase();
  const otherLetter = currentLetter === "C" ? "D" : "C";

  return `${otherLetter}:\\outside-root.txt`;
}

/** The value half of a secure read, or `undefined` when the key is absent. */
function readValue(result: SecureRead): string | undefined {
  return result.ok ? result.value : undefined;
}

/** The code half of a secure read; `OK` keeps the comparison array uniform. */
function readCode(result: SecureRead): string {
  return result.ok ? "OK" : result.code;
}

/** The code half of an `openExternal` answer. */
function externalCode(result: ExternalResult): string {
  return result.ok ? "OK" : result.code;
}

/**
 * Remove a tree depth-first, one entry per call.
 *
 * A missing entry is ignored: cleanup runs after a test that may have already
 * removed part of the tree, and cleanup must never mask the real failure.
 */
async function removeTree(root: string): Promise<void> {
  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const child = path.join(root, entry.name);

    if (entry.isDirectory()) {
      await removeTree(child);
      continue;
    }

    await unlink(child).catch(() => undefined);
  }

  await rmdir(root).catch(() => undefined);
}
